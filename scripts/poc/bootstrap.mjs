// PoC bootstrap for docker-compose.yaml (project annotationplatformpoc). Run AFTER the infrastructure services are up, BEFORE web/worker/realtime:
//
//   node scripts/poc/bootstrap.mjs [--env-file .env] [--upgrade]
//
// --upgrade skips MinIO provisioning and accepts a database that already has migration history (applies only PENDING migrations, still receipt-bound).
// Without it the database must be genuinely empty.
//
// 1. Provisions the bucket, the three least-privilege MinIO identities (web/worker/verifier) and the lifecycle rule with the repository's S0 policies, using the
//    digest-pinned minio/mc image in a short-lived container (secrets pass by environment NAME only).
// 2. Applies the complete migration chain to the EMPTY PoC database through the receipt-bound DB safety launcher (approve-disposable.mjs -> cli.mjs deploy)
//    and verifies history/checksums/status read-only. It refuses a non-empty database. It never edits, skips or marks a migration.
// Secrets are read from the env file and never printed. Targets only the annotationplatformpoc resources named below.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as guard from '../db-safety/guard.mjs';
import { loadArtifacts, mcReference, renderPolicy } from '../db-safety/minio-authority.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const PROJECT = 'annotationplatformpoc';
const NETWORK = `${PROJECT}_default`;
const PG_CONTAINER = 'phase029-g1-poc-postgres';
const MINIO_CONTAINER = `${PROJECT}-minio-1`;
const sha = value => createHash('sha256').update(value).digest('hex');
const must = (ok, code, detail) => { if (!ok) throw Object.assign(Error(code), { detail }); };
const args = process.argv.slice(2);
const envFile = resolve(args.includes('--env-file') ? args[args.indexOf('--env-file') + 1] : join(ROOT, '.env'));
must(existsSync(envFile), 'ENV_FILE_REQUIRED');
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(line => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const need = name => { must(env[name], `ENV_REQUIRED_${name}`); return env[name]; };
const password = need('POSTGRES_PASSWORD');
const port = Number(process.env.POC_POSTGRES_PORT || env.POC_POSTGRES_PORT || 55471);
must(port >= 55460 && port <= 55479 && port !== 55475, 'POC_POSTGRES_PORT_INVALID');
const upgrade = args.includes('--upgrade');
const bucket = env.MINIO_BUCKET || 'annotation-assets';
const run = (cmd, argv, options = {}) => { const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options }); return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; };
const secrets = ['POSTGRES_PASSWORD', 'MINIO_SECRET_KEY', 'A24_WEB_SECRET', 'A24_WORKER_SECRET', 'A24_VERIFIER_SECRET'].map(name => env[name]).filter(Boolean);
const redact = text => secrets.reduce((out, secret) => out.split(secret).join('[REDACTED]'), text).replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[REDACTED_DATABASE_URL]');
const log = (id, detail) => console.log(`PASS ${id}${detail ? ' ' + JSON.stringify(detail) : ''}`);
const psql = sql => {
  const r = run('docker', ['exec', '-i', '-e', 'PGOPTIONS=-c default_transaction_read_only=on', PG_CONTAINER, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'fieldframe'], { input: sql });
  must(r.status === 0, 'PSQL_FAILED', r.stderr.slice(0, 200));
  return r.stdout.trim();
};

// ------------------------------------------------------------------------------------------------ 1. MinIO provisioning
if (!upgrade) {
  const frozen = JSON.parse(loadArtifacts().text.frozen);
  const artifacts = loadArtifacts();
  const mcImage = mcReference(frozen);
  const provision = readFileSync(join(ROOT, 'scripts/db-safety/minio-authority/provision.sh'), 'utf8');
  const penv = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    MC_HOST_local: `http://${need('MINIO_ACCESS_KEY')}:${need('MINIO_SECRET_KEY')}@minio:9000`,
    S0_BUCKET: bucket,
    S0_POLICY_WEB: JSON.stringify(renderPolicy(artifacts.text.web, bucket)), S0_POLICY_WORKER: JSON.stringify(renderPolicy(artifacts.text.worker, bucket)), S0_POLICY_VERIFIER: JSON.stringify(renderPolicy(artifacts.text.verifier, bucket)),
    S0_LIFECYCLE: artifacts.text.lifecycle,
    S0_WEB_KEY: need('A24_WEB_KEY'), S0_WEB_SECRET: need('A24_WEB_SECRET'), S0_WORKER_KEY: need('A24_WORKER_KEY'), S0_WORKER_SECRET: need('A24_WORKER_SECRET'),
    S0_VERIFIER_KEY: need('A24_VERIFIER_KEY'), S0_VERIFIER_SECRET: need('A24_VERIFIER_SECRET'),
  };
  must(new Set([penv.S0_WEB_KEY, penv.S0_WORKER_KEY, penv.S0_VERIFIER_KEY, env.MINIO_ACCESS_KEY]).size === 4, 'MINIO_IDENTITIES_NOT_DISTINCT');
  const net = JSON.parse(run('docker', ['network', 'inspect', NETWORK]).stdout || '[]')[0];
  must(net && Object.values(net.Containers ?? {}).some(c => c.Name === MINIO_CONTAINER), 'POC_MINIO_NOT_ON_POC_NETWORK');
  const names = Object.keys(penv).filter(key => key.startsWith('S0_') || key === 'MC_HOST_local');
  const r = run('docker', ['run', '--rm', '--network', NETWORK, '--read-only', '--tmpfs', '/tmp:rw,size=16m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m', '--user', '65534:65534', '--label', 'annotation.safety=poc-provision', ...names.flatMap(key => ['-e', key]), '--entrypoint', '/bin/sh', mcImage, '-c', provision], { env: penv });
  const output = redact(r.stdout + r.stderr);
  must(r.status === 0 && /S0_PROVISION_OK/.test(output), 'MINIO_PROVISION_FAILED', output.slice(-400));
  log('minio-provisioned', { bucket, identities: ['web', 'worker', 'verifier'], mc: mcImage.slice(0, 20) + '…' });
}

// ------------------------------------------------------------------------------------------------ 2. migrations via the DB safety launcher
const stage = mkdtempSync(join(tmpdir(), 'poc-migrate-')); chmodSync(stage, 0o700);
try {
  const inspected = JSON.parse(run('docker', ['inspect', PG_CONTAINER]).stdout || '[]')[0];
  must(inspected?.State.Running && inspected.Config.Labels['com.docker.compose.project'] === PROJECT, 'POC_POSTGRES_NOT_RUNNING_OR_NOT_POC');
  const pin = { name: PG_CONTAINER, id: inspected.Id, role: 'postgres', port, internalPort: 5432 };
  pin.systemIdentifier = run('docker', ['exec', PG_CONTAINER, 'sh', '-c', 'LC_ALL=C pg_controldata "$PGDATA"']).stdout.match(/^Database system identifier:\s+(\d+)/m)?.[1];
  must(pin.systemIdentifier && pin.systemIdentifier !== guard.applicationSystem, 'TARGET_IS_APPLICATION_DATABASE');
  const hasHistory = psql("SELECT to_regclass('public._prisma_migrations') IS NOT NULL") === 't';
  const hasTables = psql("SELECT count(*) FROM pg_tables WHERE schemaname='public'") !== '0';
  must(upgrade ? (!hasTables || hasHistory) : (!hasTables && !hasHistory), upgrade ? 'DATABASE_HAS_TABLES_WITHOUT_HISTORY' : 'DATABASE_NOT_EMPTY');
  log(upgrade ? 'database-upgrade-target' : 'database-is-fresh', { container: PG_CONTAINER, port, volume: inspected.Mounts.find(m => m.Type === 'volume')?.Name });

  cpSync(join(ROOT, 'prisma/migrations'), join(stage, 'migrations'), { recursive: true });
  cpSync(join(ROOT, 'prisma/schema.prisma'), join(stage, 'schema.prisma'));
  symlinkSync(join(ROOT, 'node_modules'), join(stage, 'node_modules'), 'dir');
  const dirs = readdirSync(join(stage, 'migrations'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  const url = `postgresql://postgres:${password}@127.0.0.1:${port}/fieldframe`;
  writeFileSync(join(stage, 'prisma.config.ts'), `import {defineConfig} from ${JSON.stringify(join(ROOT, 'node_modules/prisma/config.js'))}; export default defineConfig(${JSON.stringify({ schema: join(stage, 'schema.prisma'), migrations: { path: join(stage, 'migrations') }, engine: 'classic', datasource: { url } })});`, { mode: 0o600 });
  const request = {
    config: join(stage, 'prisma.config.ts'), configSha256: sha(readFileSync(join(stage, 'prisma.config.ts'))), operation: 'deploy', postgres: pin,
    schemaSha256: sha(readFileSync(join(stage, 'schema.prisma'))), migrationHashes: Object.fromEntries(guard.migrationFiles(join(stage, 'migrations')).map(file => [file, sha(readFileSync(file))])),
  };
  const requestPath = join(stage, 'deploy-request.json'), receiptPath = join(stage, 'deploy-receipt.json');
  writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
  const base = { PATH: process.env.PATH, HOME: process.env.HOME };
  const approved = run(process.execPath, [join(ROOT, 'scripts/db-safety/approve-disposable.mjs'), requestPath, receiptPath], { env: base, cwd: ROOT });
  must(approved.status === 0, 'RECEIPT_REFUSED', redact(approved.stdout + approved.stderr).slice(0, 300));
  log('receipt-approved', JSON.parse(approved.stdout.trim().split('\n').pop()));
  const deploy = run(process.execPath, [join(ROOT, 'scripts/db-safety/cli.mjs'), 'deploy'], { env: { ...base, DB_SAFETY_RECEIPT: receiptPath }, cwd: ROOT });
  const deployLog = redact(deploy.stdout + deploy.stderr);
  must(deploy.status === 0, 'GUARDED_DEPLOY_FAILED', deployLog.slice(-600));
  log('guarded-deploy-succeeded', deployLog.split('\n').filter(line => /migrations? found|successfully applied/.test(line)));

  const history = JSON.parse(psql(`SELECT coalesce(json_agg(json_build_object('name',migration_name,'checksum',checksum,'finished',finished_at IS NOT NULL,'rolledBack',rolled_back_at IS NOT NULL) ORDER BY started_at, migration_name),'[]'::json) FROM public._prisma_migrations`));
  must(history.length === dirs.length && history.every(row => row.finished && !row.rolledBack), 'HISTORY_INCOMPLETE', { applied: history.length, expected: dirs.length });
  must(history.every((row, index) => row.name === dirs[index] && row.checksum === sha(readFileSync(join(stage, 'migrations', row.name, 'migration.sql')))), 'HISTORY_MISMATCH');
  log('history-matches-source', { migrations: history.length, rolledBack: 0 });
  const status = run(process.execPath, [join(ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'status', '--config', join(stage, 'prisma.config.ts')], { env: { ...base, DATABASE_URL: url }, cwd: ROOT });
  must(status.status === 0 && /Database schema is up to date/.test(redact(status.stdout + status.stderr)), 'MIGRATE_STATUS_NOT_CLEAN');
  log('prisma-migrate-status-up-to-date');
  console.log('BOOTSTRAP_OK');
} catch (error) {
  console.error('BOOTSTRAP_FAILED', error.message, redact(JSON.stringify(error.detail ?? '')));
  process.exitCode = 1;
} finally {
  rmSync(stage, { recursive: true, force: true });
}
