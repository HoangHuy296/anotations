// Receipt-bound maintenance launcher for Phase029 T029 (observe) and T031 (apply).
//
//   node scripts/db-safety/backfill-launcher.mjs observe <request.json>
//   node scripts/db-safety/backfill-launcher.mjs apply   <request.json>
//
// The single input is a private request file that pins every identity the run is allowed to touch. Nothing is taken from the environment (an
// inherited database/storage variable aborts the run) and nothing is inferred. Every check fails closed with an upper-case code BEFORE any
// application data or object store is read or written. The launcher only runs the hash-pinned child (apps/web/scripts/backfill-run.ts) inside
// a fence that allows exactly the two bound endpoints, then seals immutable, secret-free evidence: binding.json, the child's output, receipt.json.
//
// SHARED-DEV EXECUTION IS NOT ENABLED. `SHARED_DEV_ENABLED` is a source constant; turning it on is a reviewed, hash-bound change plus a
// release-owner authorization file for the exact run (see validateAuthorization). Until then only `disposable` targets can run.
import { existsSync, readFileSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  APPLICATION_SYSTEM, RECEIPT_SCHEMA, assertDatabaseTarget, assertHistory, assertImplementationMatches, assertNoAmbientTargets, assertPrivateFile, assertSchemaObserved,
  assertStorageTarget, buildBinding, canonicalJson, computeImplementation, containsSecret, manifestDigest, manifestSql, must, prepareEvidenceDir, resolveEvidenceRoots, sha256,
  validateAuthorization, validateRequest, writeImmutable,
} from './backfill-binding.mjs';

export const SHARED_DEV_ENABLED = false;
const ROOT = resolve(import.meta.dirname, '../..');
const code = error => (/^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'LAUNCHER_FAILURE');

/** Read-only database observation through psql (the same tool as guard.probe): identity, history, schema manifest, Dataset counts. */
function probeDatabase(request, root) {
  const url = new URL(request.postgres.url);
  const statements = [
    `SELECT json_build_object('systemIdentifier',system_identifier::text,'database',current_database()) FROM pg_control_system();`,
    `SELECT coalesce(json_agg(json_build_object('name',migration_name,'checksum',checksum,'finished',finished_at IS NOT NULL,'rolledBack',rolled_back_at IS NOT NULL) ORDER BY started_at, migration_name),'[]'::json) FROM public._prisma_migrations;`,
    manifestSql(root),
    `SELECT json_build_object('total',count(*),'unresolved',count(*) FILTER (WHERE modality IS NULL),'resolved',count(*) FILTER (WHERE modality IS NOT NULL),'live',count(*) FILTER (WHERE "deletedAt" IS NULL AND "archivedAt" IS NULL)) FROM public."Dataset";`,
  ];
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGAPPNAME: 'phase029-backfill-launcher', PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=60000 -c lock_timeout=5000',
  };
  const input = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${statements.join('\n')}\nROLLBACK;\n`;
  const result = spawnSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  must(result.status === 0, 'DATABASE_UNAVAILABLE');
  const lines = result.stdout.trim().split('\n');
  must(lines.length === statements.length, 'DATABASE_PROBE_INCOMPLETE');
  const [identity, history, manifest, datasets] = lines.map(line => JSON.parse(line));
  return { systemIdentifier: identity.systemIdentifier, database: identity.database, history, schemaEntries: manifest.length, schemaManifestSha256: manifestDigest(manifest), datasets };
}

/** The child runner is the only code that reads storage; the launcher uses it for the identity probe too, so there is exactly one adapter. */
function childSpec(request, evidenceDir, operation, extraEnv = {}) {
  const dbUrl = new URL(request.postgres.url), storage = new URL(request.storage.endpoint);
  const allowed = [`${dbUrl.hostname}:${dbUrl.port || 5432}`, `${storage.hostname}:${storage.port || (storage.protocol === 'https:' ? 443 : 80)}`];
  return {
    cwd: join(ROOT, 'apps/web'),
    args: ['--require', join(ROOT, 'apps/web/tests/auth-ownership/register-server-only.cjs'), '--require', join(ROOT, 'scripts/db-safety/maintenance-fence.cjs'), '--import', 'tsx', 'scripts/backfill-run.ts'],
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, NODE_ENV: 'test',
      DATABASE_URL: request.postgres.url, STORAGE_ENDPOINT: request.storage.endpoint, STORAGE_ACCESS_KEY: request.storage.accessKey, STORAGE_SECRET_KEY: request.storage.secretKey,
      STORAGE_BUCKET: request.storage.bucket, ...(request.storage.region ? { STORAGE_REGION: request.storage.region } : {}),
      BACKFILL_OPERATION: operation, BACKFILL_EVIDENCE_DIR: evidenceDir, BACKFILL_RUN_TOKEN: request.runToken, BACKFILL_ALLOWED_ENDPOINTS: JSON.stringify(allowed), ...extraEnv,
    },
  };
}
const spawnChild = spec => {
  const result = spawnSync(process.execPath, spec.args, { cwd: spec.cwd, env: spec.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000 });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

function realDeps() {
  return {
    root: ROOT, now: () => Date.now(), sharedDevEnabled: SHARED_DEV_ENABLED, probeDatabase: request => probeDatabase(request, ROOT), spawnChild, computeImplementation: () => computeImplementation(ROOT),
    evidenceRoots: () => resolveEvidenceRoots(ROOT),
    verifyDisposableTarget: async request => {
      // Reuses the committed G1 identity checks: container id/labels, loopback-only binding, system identifier != the application's.
      const guard = await import('./guard.mjs');
      const { postgres: pg, minio } = request.disposablePins;
      guard.containerIdentity(pg, 'postgres'); guard.controlIdentity(pg); guard.containerIdentity(minio, 'minio');
      must(pg.systemIdentifier === request.postgres.expectedSystemIdentifier, 'SYSTEM_IDENTITY_MISMATCH');
    },
  };
}

/** Returns { exitCode, code, evidenceDir?, receipt? }. Never throws; never prints a secret. */
export async function runLauncher(argv, env, deps = realDeps()) {
  let evidence = null;
  const written = [];
  try {
    must(argv.length === 2 && ['observe', 'apply'].includes(argv[0]), 'USAGE_OPERATION_AND_REQUEST_ONLY');
    assertNoAmbientTargets(env);
    const requestPath = realpathSync(resolve(argv[1]));
    assertPrivateFile(requestPath, 'REQUEST_FILE_NOT_PRIVATE');
    const requestBytes = readFileSync(requestPath);
    const request = validateRequest(JSON.parse(requestBytes.toString('utf8')), deps.now());
    must(request.operation === argv[0], 'REQUEST_OPERATION_MISMATCH');
    const secrets = [new URL(request.postgres.url).password && decodeURIComponent(new URL(request.postgres.url).password), request.storage.accessKey, request.storage.secretKey, request.postgres.url];

    // 1. who is allowed to run at all
    if (request.targetKind === 'shared-dev') {
      must(deps.sharedDevEnabled === true, 'SHARED_DEV_EXECUTION_NOT_ENABLED');
      const authPath = realpathSync(resolve(request.authorization.path));
      assertPrivateFile(authPath, 'AUTHORIZATION_FILE_NOT_PRIVATE');
      const authBytes = readFileSync(authPath);
      must(sha256(authBytes) === request.authorization.sha256, 'AUTHORIZATION_HASH_MISMATCH');
      validateAuthorization(JSON.parse(authBytes.toString('utf8')), request, deps.now());
    }

    // 2. exactly the reviewed code and chain
    const implementation = deps.computeImplementation();
    assertImplementationMatches(request.implementation, implementation);

    // 3. exact database target
    if (request.targetKind === 'disposable') await deps.verifyDisposableTarget(request);
    const dbObserved = deps.probeDatabase(request);
    assertDatabaseTarget(request, dbObserved);
    assertHistory(request.postgres.expectedHistory, dbObserved.history);
    assertSchemaObserved(request, dbObserved);
    must(dbObserved.systemIdentifier === APPLICATION_SYSTEM ? request.targetKind === 'shared-dev' : request.targetKind === 'disposable', 'TARGET_KIND_SYSTEM_MISMATCH');

    // 4. exact storage target (identity probe is the child's adapter, so there is a single implementation)
    const probe = deps.spawnChild(childSpec(request, ROOT, 'identity'));
    must(probe.status === 0, /STORAGE_UNAVAILABLE/.test(probe.stderr) ? 'STORAGE_UNAVAILABLE' : 'STORAGE_IDENTITY_PROBE_FAILED');
    const storageObserved = JSON.parse(probe.stdout.trim().split('\n').at(-1));
    assertStorageTarget(request, storageObserved);

    // 5. approval inputs (apply only): pinned bytes, private files, the approved manifest names this observed manifest
    let manifestEnv = {};
    if (request.operation === 'apply') {
      const bytes = {};
      for (const [label, path, pin] of [['observed', request.manifests.observedPath, request.manifests.observedSha256], ['approved', request.manifests.approvedPath, request.manifests.approvedSha256]]) {
        const real = realpathSync(resolve(path)); assertPrivateFile(real, 'MANIFEST_FILE_NOT_PRIVATE');
        bytes[label] = readFileSync(real); must(sha256(bytes[label]) === pin, 'MANIFEST_FILE_HASH_MISMATCH');
        manifestEnv[label] = real;
      }
      const observedJson = JSON.parse(bytes.observed.toString('utf8')), approvedJson = JSON.parse(bytes.approved.toString('utf8'));
      must(approvedJson.observedManifestSha256 === observedJson.manifestSha256, 'APPROVED_OBSERVED_MISMATCH');
      must(observedJson.policy?.expectedBucket === request.storage.expectedBucket, 'MANIFEST_BUCKET_MISMATCH');
    }

    // 6. evidence directory, then the immutable binding
    const evidenceIdentity = prepareEvidenceDir(request.evidenceDir, deps.evidenceRoots());
    evidence = evidenceIdentity.realpath;
    const binding = buildBinding({ request, requestSha256: sha256(requestBytes), implementation, dbObserved, storageObserved, evidence: evidenceIdentity, now: deps.now() });
    const bindingText = JSON.stringify(binding, null, 2) + '\n';
    must(!containsSecret(bindingText, secrets), 'SECRET_IN_EVIDENCE');
    const bindingSha256 = writeImmutable(evidence, 'binding.json', bindingText); written.push('binding.json');

    // 7. second verification immediately before the run, then the run
    assertImplementationMatches(request.implementation, deps.computeImplementation());
    const startedAt = new Date(deps.now()).toISOString();
    const spec = childSpec(request, evidence, request.operation, request.operation === 'apply' ? {
      BACKFILL_OBSERVED_PATH: manifestEnv.observed, BACKFILL_OBSERVED_SHA256: request.manifests.observedSha256, BACKFILL_APPROVED_PATH: manifestEnv.approved, BACKFILL_APPROVED_SHA256: request.manifests.approvedSha256,
    } : {});
    const child = deps.spawnChild(spec);
    const outputName = request.operation === 'observe' ? 'observed-manifest.json' : 'result.json';
    const outputPath = join(evidence, outputName);

    // 8. the code must not have changed while it ran, nothing secret may be in the evidence, then seal the receipt
    assertImplementationMatches(request.implementation, deps.computeImplementation());
    const outputBytes = existsSync(outputPath) ? readFileSync(outputPath) : null;
    if (outputBytes) { written.push(outputName); must(!containsSecret(outputBytes.toString('utf8'), secrets), 'SECRET_IN_EVIDENCE'); }
    must(!containsSecret(child.stdout + child.stderr, secrets), 'SECRET_IN_CHILD_OUTPUT');
    const status = child.status === 0 ? 'COMPLETED' : child.status === 3 ? 'STOPPED' : 'FAILED';
    const output = outputBytes ? JSON.parse(outputBytes.toString('utf8')) : null;
    const receipt = {
      schema: RECEIPT_SCHEMA, operation: request.operation, targetKind: request.targetKind, status, exitCode: child.status, startedAt, finishedAt: new Date(deps.now()).toISOString(),
      runToken: request.runToken, resolverSubject: binding.resolverSubject, requestSha256: sha256(requestBytes),
      binding: { file: 'binding.json', sha256: bindingSha256 },
      output: outputBytes ? { file: outputName, sha256: sha256(outputBytes) } : null,
      approvedLineage: request.operation === 'apply' && output ? output.lineage : null,
      counts: request.operation === 'apply' && output ? output.run.counts : request.operation === 'observe' && output ? { candidates: output.candidates.length, rejected: output.rejected.length } : null,
      implementationStable: true,
      childFailureCode: child.status !== 0 && child.status !== 3 ? (child.stderr.match(/BACKFILL_RUN_FAILED ([A-Z0-9_]+)/)?.[1] ?? 'CHILD_FAILED') : null,
    };
    const receiptText = JSON.stringify(receipt, null, 2) + '\n';
    must(!containsSecret(receiptText, secrets) && canonicalJson(receipt).length > 0, 'SECRET_IN_EVIDENCE');
    writeImmutable(evidence, 'receipt.json', receiptText); written.push('receipt.json');
    return { exitCode: child.status === 0 ? 0 : child.status === 3 ? 3 : 1, code: status, evidenceDir: evidence, receipt };
  } catch (error) {
    // A secret-bearing file must not stay behind: remove only what this run wrote.
    if (evidence && /SECRET_IN/.test(code(error))) for (const name of written) rmSync(join(evidence, name), { force: true });
    return { exitCode: 1, code: code(error), evidenceDir: evidence && existsSync(evidence) && readdirSync(evidence).length ? evidence : null };
  }
}

if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) {
  const result = await runLauncher(process.argv.slice(2), process.env);
  if (result.exitCode === 0 || result.exitCode === 3) console.log(JSON.stringify({ ok: result.exitCode === 0, status: result.code, evidenceDir: result.evidenceDir, counts: result.receipt?.counts ?? null }));
  else console.error('SAFETY_ABORT', result.code);
  process.exitCode = result.exitCode;
}
