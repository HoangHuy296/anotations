// Offline verification of a built release image (web or worker) against the Git revision it must have been built from. Nothing is started: the image is inspected,
// a STOPPED container is created from it (no network, never started), selected paths are copied out, the container is removed by its exact id.
//
//   node scripts/db-safety/release-image-verify.mjs --image <ref|id> --service web|worker --revision <40-hex> [--out <json>]
//
// Checks (each reported with pass/fail and a reason; any failure exits non-zero):
//   label       the image carries org.opencontainers.image.revision == the revision and annotation.platform.service == the service
//   startup     Entrypoint/Cmd/Healthcheck contain no migrate/prisma/seed/db: command
//   secrets     no baked ENV value is a credentialed URL; no secret-looking ENV name has a value
//   source      key files inside the image are byte-identical to `git show <revision>:<path>` (schema, M24, M25, the Prisma client models, queue contract, modality contract, app code)
//   client      the generated Prisma client tree and the migration chain tree equal the pinned hashes; Dataset exposes the four modality fields; PreparedImport exposes creationRequestHash
//   env-files   no .env* file anywhere in the image filesystem except .env.example and files under node_modules
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readTree, treeHash } from './prisma-client-stage.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
export const PINNED = Object.freeze({
  clientTreeSha256: 'a750e6b900e00991e818b660f7af67866d1c8ea2ec7774ff2f92f0b40fb54a52',
  migrationsTreeSha256: 'f0da8710b3c874f842de6b686ae5b025dffd59f8acdab74a6e1c00faadb54ca8',
  m24: '20260930030000_dataset_modality_g2', m25: '20261006000000_prepared_import_creation_request_hash',
});
/**
 * The 26-migration chain (M26 promoted). PINNED above is the 25-migration rollout pin set and stays the default (the shared-dev rollout package and its tests reference it); an image built
 * from the frozen 26-migration tree is verified with `--chain 26`, which swaps ONLY the two tree digests and adds the M26 migration to the byte-compared sources. The generated client is
 * compared raw: an image holds the committed bytes (the checkout path embedded in internal/class.ts is the committed one), so no normalization is needed or applied here.
 */
export const PINNED_M26 = Object.freeze({
  clientTreeSha256: 'b88f7a3dc76134aaf11d4962159bafde47a5904f9eb7e11e0edc4247cd79083c',
  migrationsTreeSha256: 'ad6cf07925c9422a715e0ea90616b45ca1e54a58d1ea0f55ea1496dd8b9ec54a',
  m26: '20261007000000_media_verification_a2',
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const BAD_STARTUP = /\b(migrate|prisma|seed|db:push|db:migrate|db:seed|db:reset)\b/i;
const SECRET_NAME = /(PASSWORD|SECRET|TOKEN|PRIVATE|CREDENTIAL|ACCESS_KEY)/i;
const CREDENTIAL_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@]+@/i;
const COMMON_SOURCE = ['prisma/schema.prisma', `prisma/migrations/${PINNED.m24}/migration.sql`, `prisma/migrations/${PINNED.m25}/migration.sql`, 'lib/generated/prisma/models/Dataset.ts', 'lib/generated/prisma/models/PreparedImport.ts', 'packages/queue/src/job-contract.ts', 'packages/domain/src/dataset-modality.ts'];
export const SERVICE_SOURCE = Object.freeze({
  web: [...COMMON_SOURCE, 'apps/web/src/lib/datasets/modality.ts', 'apps/web/src/app/api/datasets/route.ts', 'apps/web/Dockerfile'],
  worker: [...COMMON_SOURCE, 'apps/worker/src/jobs/repository-asset-upsert.ts', 'apps/worker/src/jobs/import-dataset.ts', 'apps/worker/src/index.ts', 'apps/worker/Dockerfile'],
});
const ENV_FILE_PROBES = ['.env', '.env.local', '.env.review', '.env.production', '.env.development', 'apps/web/.env', 'apps/web/.env.local', 'apps/worker/.env', 'apps/realtime/.env'];
const MODALITY_FIELDS = ['modalityContentRevision', 'modalityResolvedAt', 'modalityResolverSubject'];

const realExec = (command, args, options = {}) => {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, input: options.input, cwd: options.cwd, timeout: 20 * 60 * 1000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
export const realDeps = () => ({ root: ROOT, exec: realExec, newName: () => `phase029-imgverify-${randomBytes(6).toString('hex')}` });

/** Returns { ok, checks:[{id,pass,detail}] }. Never starts a container; always removes the one it created. */
export function verifyImage({ image, service, revision, chain = '25' }, deps = realDeps()) {
  const pins = chain === '26' ? PINNED_M26 : PINNED;
  const checks = [];
  const record = (id, pass, detail) => { checks.push({ id, pass: Boolean(pass), detail }); return pass; };
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{1,200}$/.test(image ?? '') || !['25', '26'].includes(chain) || !['web', 'worker'].includes(service) || !/^[0-9a-f]{40}$/.test(revision ?? '')) return { ok: false, checks: [{ id: 'arguments', pass: false, detail: 'ARGUMENTS_INVALID' }] };
  const inspect = deps.exec('docker', ['image', 'inspect', image]);
  if (inspect.status !== 0) return { ok: false, checks: [{ id: 'image', pass: false, detail: 'IMAGE_NOT_FOUND' }] };
  const info = JSON.parse(inspect.stdout)[0];
  record('image-id', /^sha256:[0-9a-f]{64}$/.test(info.Id), info.Id);
  const labels = info.Config?.Labels ?? {};
  record('label-revision', labels['org.opencontainers.image.revision'] === revision, labels['org.opencontainers.image.revision'] ?? 'MISSING');
  record('label-service', labels['annotation.platform.service'] === service, labels['annotation.platform.service'] ?? 'MISSING');
  const startup = JSON.stringify({ entrypoint: info.Config?.Entrypoint ?? null, cmd: info.Config?.Cmd ?? null, health: info.Config?.Healthcheck?.Test ?? null });
  record('startup-no-migration-or-seed', !BAD_STARTUP.test(startup.replace(/pnpm|--filter|@annotationplatform\/(web|worker)|start/g, '')), startup);
  const env = (info.Config?.Env ?? []).map(entry => { const index = entry.indexOf('='); return [entry.slice(0, index), entry.slice(index + 1)]; });
  record('env-no-credentialed-url', !env.some(([, value]) => CREDENTIAL_URL.test(value)), `${env.length} variables`);
  record('env-no-secret-values', !env.some(([name, value]) => SECRET_NAME.test(name) && value !== ''), env.filter(([name]) => SECRET_NAME.test(name)).map(([name]) => name).join(',') || 'none');

  const tmp = mkdtempSync(join(tmpdir(), 'phase029-imgverify-'));
  const name = deps.newName();
  let containerId = null;
  try {
    const created = deps.exec('docker', ['create', '--name', name, '--network', 'none', '--label', 'annotation.safety=image-verify', info.Id, 'true']);
    if (!record('container-created-not-started', created.status === 0 && /^[0-9a-f]{64}$/.test(created.stdout.trim()), created.status === 0 ? 'created' : created.stderr.slice(0, 120))) return { ok: false, checks };
    containerId = created.stdout.trim();
    const cwd = info.Config?.WorkingDir || '/workspace';
    const copy = (path, target) => deps.exec('docker', ['cp', `${containerId}:${cwd}/${path}`, target]).status === 0;
    // source byte-identity against the Git revision
    for (const path of [...SERVICE_SOURCE[service], ...(chain === '26' ? [`prisma/migrations/${PINNED_M26.m26}/migration.sql`] : [])]) {
      const target = join(tmp, path.replace(/\//g, '__'));
      const present = copy(path, target);
      const expected = deps.exec('git', ['show', `${revision}:${path}`], { cwd: deps.root });
      if (!present || expected.status !== 0) { record(`source:${path}`, false, present ? 'NOT_IN_REVISION' : 'NOT_IN_IMAGE'); continue; }
      record(`source:${path}`, sha(readFileSync(target)) === sha(expected.stdout), 'byte comparison');
    }
    // generated client and migration chain trees
    const clientDir = join(tmp, 'client'), chainDir = join(tmp, 'chain');
    record('client-tree', copy('lib/generated/prisma', clientDir) && treeHash(readTree(clientDir)) === pins.clientTreeSha256, pins.clientTreeSha256.slice(0, 12));
    record('migration-chain-tree', copy('prisma/migrations', chainDir) && treeHash(readTree(chainDir)) === pins.migrationsTreeSha256, pins.migrationsTreeSha256.slice(0, 12));
    const dataset = join(tmp, 'lib__generated__prisma__models__Dataset.ts'), prepared = join(tmp, 'lib__generated__prisma__models__PreparedImport.ts');
    const datasetText = existsSync(dataset) ? readFileSync(dataset, 'utf8') : '', preparedText = existsSync(prepared) ? readFileSync(prepared, 'utf8') : '';
    record('client-dataset-modality-fields', /\bmodality\b/.test(datasetText) && MODALITY_FIELDS.every(field => datasetText.includes(field)), MODALITY_FIELDS.join(','));
    record('client-prepared-import-creation-request-hash', preparedText.includes('creationRequestHash'), 'creationRequestHash');
    if (service === 'web') record('web-build-present', copy('apps/web/.next/BUILD_ID', join(tmp, 'BUILD_ID')) && readFileSync(join(tmp, 'BUILD_ID'), 'utf8').trim().length > 0, 'BUILD_ID');
    // no environment file anywhere in the image filesystem
    for (const probe of ENV_FILE_PROBES) record(`env-file-absent:${probe}`, !copy(probe, join(tmp, `probe-${sha(probe).slice(0, 8)}`)), probe);
    const listing = deps.exec('sh', ['-c', `docker export ${containerId} | tar -tf - | grep -E '(^|/)\\.env(\\.[A-Za-z0-9_-]+)?$' | grep -v -E '(^|/)node_modules/|\\.env\\.example$' | head -20`]);
    record('env-files-none-in-filesystem', listing.stdout.trim() === '', listing.stdout.trim() || 'none');
  } finally {
    if (containerId) {
      const found = deps.exec('docker', ['inspect', containerId]);
      let owned = false;
      try { const c = JSON.parse(found.stdout)[0]; owned = c.Id === containerId && c.Config.Labels?.['annotation.safety'] === 'image-verify' && !c.State.Running; } catch { owned = false; }
      record('container-removed', owned && deps.exec('docker', ['rm', '-f', containerId]).status === 0, owned ? 'removed' : 'NOT_OWNED');
    }
    rmSync(tmp, { recursive: true, force: true });
  }
  return { ok: checks.every(check => check.pass), checks };
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const args = process.argv.slice(2), value = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  const chain = value('--chain') ?? '25';
  const result = verifyImage({ image: value('--image'), service: value('--service'), revision: value('--revision'), chain });
  const out = value('--out');
  if (out) writeFileSync(resolve(out), JSON.stringify({ image: value('--image'), service: value('--service'), revision: value('--revision'), ...result }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ ok: result.ok, failed: result.checks.filter(check => !check.pass).map(check => check.id) }));
  process.exitCode = result.ok ? 0 : 1;
}
