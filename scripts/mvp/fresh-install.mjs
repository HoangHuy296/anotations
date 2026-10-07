// G-MIG-FRESH: apply the complete canonical migration chain (23 historical + exact reviewed M24 + M25) to a genuinely EMPTY PostgreSQL, through the repository's own
// receipt-bound deploy path (approve-disposable.mjs → cli.mjs deploy), then verify the result read-only.
//
//   node scripts/mvp/fresh-install.mjs --env-file <private mvp.env> [--out <evidence dir>]
//
// It refuses a database that is not empty, that has the application's system identifier, or whose container is not the pinned MVP postgres. It never edits,
// squashes, marks or skips a migration; it never touches the existing shared-dev stack. Secrets are read from the private env file and never printed or stored.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as guard from '../db-safety/guard.mjs';
import { manifestDigest, manifestSql } from '../db-safety/backfill-binding.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const must = (ok, code, detail) => { if (!ok) throw Object.assign(Error(code), { detail }); };
const args = process.argv.slice(2);
const flag = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const envFile = flag('--env-file');
must(envFile && existsSync(envFile), 'ENV_FILE_REQUIRED');
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(line => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const password = env.MVP_POSTGRES_PASSWORD, port = Number(env.MVP_POSTGRES_PORT || 55475);
must(password && port >= 55460 && port <= 55479, 'MVP_POSTGRES_SETTINGS_INVALID');
const CONTAINER = 'phase029-g1-mvp-postgres';
const EXPECTED = { history: 25, schemaEntries: 1842, m24: '13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7', m25: 'a8ffbc84bde7f18aac93bbb2e87423e6cfcbf6efd95c01e6650824fdcc3ed859', schemaManifestSha256: '5aedbda7cb56eb4d0ebe4710f0051ffa214dcf12557a6d3f7ad7a24dcb05e8fe' };
const run = (cmd, argv, options = {}) => { const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options }); return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; };
const psql = (sql, readonly = true) => {
  const r = run('docker', ['exec', '-i', ...(readonly ? ['-e', 'PGOPTIONS=-c default_transaction_read_only=on'] : []), CONTAINER, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'fieldframe'], { input: sql });
  must(r.status === 0, 'PSQL_FAILED', r.stderr.slice(0, 200));
  return r.stdout.trim();
};
const redact = text => text.split(password).join('[REDACTED]').replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[REDACTED_DATABASE_URL]');

const evidence = { schema: 'phase029-g-mig-fresh/v1', startedAt: new Date().toISOString(), checks: [], failure: null };
const check = (id, pass, detail) => { evidence.checks.push({ id, pass: Boolean(pass), detail }); must(pass, `CHECK_FAILED_${id}`, detail); };
const stage = mkdtempSync(join(tmpdir(), 'mvp-fresh-')); chmodSync(stage, 0o700);
try {
  // ---- identity and emptiness BEFORE anything is staged or approved
  const inspected = JSON.parse(run('docker', ['inspect', CONTAINER]).stdout || '[]')[0];
  must(inspected && inspected.State.Running, 'MVP_POSTGRES_NOT_RUNNING');
  const pin = { name: CONTAINER, id: inspected.Id, role: 'postgres', port, internalPort: 5432 };
  pin.systemIdentifier = run('docker', ['exec', CONTAINER, 'sh', '-c', 'LC_ALL=C pg_controldata "$PGDATA"']).stdout.match(/^Database system identifier:\s+(\d+)/m)?.[1];
  check('target-is-not-the-application-database', pin.systemIdentifier && pin.systemIdentifier !== guard.applicationSystem, { systemIdentifier: pin.systemIdentifier, applicationSystem: guard.applicationSystem });
  check('database-is-genuinely-fresh', psql("SELECT count(*) FROM pg_tables WHERE schemaname='public'") === '0' && psql("SELECT to_regclass('public._prisma_migrations') IS NULL") === 't', 'no public tables and no _prisma_migrations');
  evidence.target = { container: CONTAINER, id: pin.id, port, systemIdentifier: pin.systemIdentifier, volume: inspected.Mounts.find(m => m.Type === 'volume')?.Name };

  // ---- stage the reviewed bytes (all 25 migrations, unmodified) exactly as the guarded runner does
  cpSync(join(ROOT, 'prisma/migrations'), join(stage, 'migrations'), { recursive: true });
  cpSync(join(ROOT, 'prisma/schema.prisma'), join(stage, 'schema.prisma'));
  symlinkSync(join(ROOT, 'node_modules'), join(stage, 'node_modules'), 'dir');
  const dirs = readdirSync(join(stage, 'migrations'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  check('canonical-chain-is-25-migrations', dirs.length === EXPECTED.history, { count: dirs.length });
  const m24 = dirs.find(n => n.endsWith('_dataset_modality_g2')), m25 = dirs.find(n => n.endsWith('_prepared_import_creation_request_hash'));
  check('m24-m25-bytes-exact', sha(readFileSync(join(stage, 'migrations', m24, 'migration.sql'))) === EXPECTED.m24 && sha(readFileSync(join(stage, 'migrations', m25, 'migration.sql'))) === EXPECTED.m25 && dirs.at(-2) === m24 && dirs.at(-1) === m25, { m24, m25 });
  const url = `postgresql://postgres:${password}@127.0.0.1:${port}/fieldframe`;
  const configText = `import {defineConfig} from ${JSON.stringify(join(ROOT, 'node_modules/prisma/config.js'))}; export default defineConfig(${JSON.stringify({ schema: join(stage, 'schema.prisma'), migrations: { path: join(stage, 'migrations') }, engine: 'classic', datasource: { url } })});`;
  writeFileSync(join(stage, 'prisma.config.ts'), configText, { mode: 0o600 });
  const request = {
    config: join(stage, 'prisma.config.ts'), configSha256: sha(readFileSync(join(stage, 'prisma.config.ts'))), operation: 'deploy', postgres: pin,
    schemaSha256: sha(readFileSync(join(stage, 'schema.prisma'))), migrationHashes: Object.fromEntries(guard.migrationFiles(join(stage, 'migrations')).map(file => [file, sha(readFileSync(file))])),
  };
  const requestPath = join(stage, 'deploy-request.json'), receiptPath = join(stage, 'deploy-receipt.json');
  writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
  const base = { PATH: process.env.PATH, HOME: process.env.HOME };

  // ---- receipt, then the guarded deploy (the repository's normal path)
  const approved = run(process.execPath, [join(ROOT, 'scripts/db-safety/approve-disposable.mjs'), requestPath, receiptPath], { env: base, cwd: ROOT });
  evidence.approval = redact(approved.stdout + approved.stderr).slice(0, 400);
  check('receipt-approved', approved.status === 0, evidence.approval);
  const deploy = run(process.execPath, [join(ROOT, 'scripts/db-safety/cli.mjs'), 'deploy'], { env: { ...base, DB_SAFETY_RECEIPT: receiptPath }, cwd: ROOT });
  evidence.deployLog = redact(deploy.stdout + deploy.stderr).split('\n').filter(line => /Applying migration|migrations? found|have been successfully applied|No pending|Error|error|VERIFIED_DISPOSABLE_TARGET/.test(line)).slice(-40);
  check('guarded-deploy-succeeded', deploy.status === 0, { status: deploy.status });

  // ---- read-only verification
  const history = JSON.parse(psql(`SELECT coalesce(json_agg(json_build_object('name',migration_name,'checksum',checksum,'finished',finished_at IS NOT NULL,'rolledBack',rolled_back_at IS NOT NULL) ORDER BY started_at, migration_name),'[]'::json) FROM public._prisma_migrations`));
  check('history-25-finished-none-rolled-back', history.length === EXPECTED.history && history.every(row => row.finished && !row.rolledBack), { rows: history.length });
  check('history-names-and-checksums-equal-the-files-in-order', history.every((row, index) => row.name === dirs[index] && row.checksum === sha(readFileSync(join(stage, 'migrations', row.name, 'migration.sql')))), 'every applied migration equals its source bytes');
  check('m24-m25-recorded-checksums-exact', history.find(row => row.name === m24)?.checksum === EXPECTED.m24 && history.find(row => row.name === m25)?.checksum === EXPECTED.m25, { m24, m25 });
  const status = run(process.execPath, [join(ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'status', '--config', join(stage, 'prisma.config.ts')], { env: { ...base, DATABASE_URL: url }, cwd: ROOT });
  const statusText = redact(status.stdout + status.stderr);
  evidence.migrateStatus = statusText.split('\n').filter(line => line.trim()).slice(-6);
  check('prisma-migrate-status-clean', status.status === 0 && /Database schema is up to date/.test(statusText), evidence.migrateStatus);
  const rows = JSON.parse(psql(manifestSql(ROOT)));
  const digest = manifestDigest(rows);
  evidence.schemaManifest = { entries: rows.length, sha256: digest };
  check('live-schema-manifest-1842-entries-reviewed-digest', rows.length === EXPECTED.schemaEntries && digest === EXPECTED.schemaManifestSha256, evidence.schemaManifest);
  const guardCounts = JSON.parse(psql(`SELECT json_build_object('triggers',(SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('dataset_modality_insert_guard','dataset_modality_assignment_guard','asset_modality_write_guard')),'functions',(SELECT count(*) FROM pg_proc WHERE proname IN ('phase029_guard_dataset_insert','phase029_guard_dataset_assignment','phase029_guard_asset_write')),'checks',(SELECT count(*) FROM pg_constraint WHERE conname IN ('dataset_modality_resolution_shape','dataset_modality_revision_nonnegative')),'columns',(SELECT count(*) FROM information_schema.columns WHERE table_name='Dataset' AND column_name IN ('modality','modalityContentRevision','modalityResolvedAt','modalityResolverSubject')),'creationRequestHash',(SELECT count(*) FROM information_schema.columns WHERE table_name='PreparedImport' AND column_name='creationRequestHash'))`));
  check('m24-m25-objects-present', guardCounts.triggers === 3 && guardCounts.functions === 3 && guardCounts.checks === 2 && guardCounts.columns === 4 && guardCounts.creationRequestHash === 1, guardCounts);
  check('no-application-rows-created-by-migration', psql(`SELECT (SELECT count(*) FROM public."Dataset") + (SELECT count(*) FROM public."Asset") + (SELECT count(*) FROM public."User")`) === '0', 'Dataset/Asset/User are empty');
  evidence.result = 'PASS';
} catch (error) {
  evidence.result = 'FAIL'; evidence.failure = { code: error.message, detail: error.detail ?? null };
} finally {
  rmSync(stage, { recursive: true, force: true });
  evidence.finishedAt = new Date().toISOString();
  const out = resolve(flag('--out') ?? join(ROOT, 'specs/029-modality-specific-datasets/verification/mvp-fresh', `g-mig-fresh-${evidence.startedAt.replace(/[-:.]/g, '').slice(0, 15)}Z`));
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const text = JSON.stringify(evidence, null, 2) + '\n';
  must(!text.includes(password), 'SECRET_IN_EVIDENCE');
  writeFileSync(join(out, 'g-mig-fresh.json'), text, { mode: 0o400, flag: 'wx' });
  console.log(JSON.stringify({ result: evidence.result, out, failure: evidence.failure, checks: evidence.checks.map(c => `${c.pass ? 'PASS' : 'FAIL'} ${c.id}`) }, null, 2));
  process.exitCode = evidence.result === 'PASS' ? 0 : 1;
}
