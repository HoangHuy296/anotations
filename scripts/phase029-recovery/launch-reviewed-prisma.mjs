// Recovery operations only. No implicit target, dotenv reload, retry, or service action.
// Application use still requires separate execution approval and the runbook gates.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');
const sqlSha = '3bb6389f380ffaa5c3be88d26d56782065a00b3844f0326ccba1c05ee4b5a1db';
const appSystem = '7662655305624969250';
const profiles = {
  application: { host: '127.0.0.1', port: '5433', database: 'fieldframe', schema: 'public', container: 'annotationplatformdev-postgres-1', containerId: '0a4ca1285c5ae8ccd7f1770340c4d9c31546d63113d9701d19ce89f2756ed7d9', systemIdentifier: appSystem },
  disposable: { host: '127.0.0.1', port: '55451', database: 'fieldframe', schema: 'public', container: 'phase029-launcher-rehearsal', label: 'launcher-rehearsal' },
};
const hash = x => createHash('sha256').update(x).digest('hex');
const check = (condition, code) => { if (!condition) throw new Error(code); };
const json = p => JSON.parse(readFileSync(p, 'utf8'));
let verifiedUrl;
function safeOutput(s) {
  let value = String(s ?? '');
  if (verifiedUrl) {
    value = value.split(verifiedUrl.toString()).join('[REDACTED_DATABASE_URL]');
    for (const password of [verifiedUrl.password, decodeURIComponent(verifiedUrl.password)]) {
      if (password) value = value.split(password).join('[REDACTED]');
    }
  }
  return value.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[REDACTED_DATABASE_URL]');
}
async function launch() {
  const [configArg, receiptArg, command, ...extra] = process.argv.slice(2);
  check(configArg && receiptArg && ['deploy', 'status', 'probe'].includes(command) && !extra.length, 'EXPLICIT_CONFIG_RECEIPT_COMMAND_REQUIRED');
  const receipt = json(resolve(receiptArg));
  const pin = profiles[receipt.profile];
  check(pin && receipt.sqlSha256 === sqlSha, 'MISSING_OR_UNAPPROVED_IDENTITY_RECEIPT');
  check(/^\d+$/.test(receipt.systemIdentifier) && /^[0-9a-f]{64}$/.test(receipt.containerId), 'MISSING_INSTANCE_IDENTITY');
  if (receipt.profile === 'application') {
    check(receipt.systemIdentifier === pin.systemIdentifier && receipt.containerId === pin.containerId, 'APPLICATION_INSTANCE_MISMATCH');
    const before = json(join(receipt.captureDir, 'evidence.json'));
    const verification = json(join(receipt.captureDir, 'verification.json'));
    check(verification.result === 'PASS' && before.identity.value.systemIdentifier === pin.systemIdentifier, 'POST_DRAIN_VERIFICATION_REQUIRED');
    const age = Date.now() - Date.parse(before.identity.value.capturedAt);
    check(Number.isFinite(age) && age >= 0 && age < 300000, 'STALE_POST_DRAIN_CAPTURE');
    check(before.sessions.value.length === 0, 'UNDRAINED_SESSIONS');
  } else {
    check(receipt.systemIdentifier !== appSystem, 'APPLICATION_INSTANCE_FORBIDDEN');
  }
  const config = realpathSync(resolve(configArg));
  check((statSync(config).mode & 0o077) === 0, 'CONFIG_MUST_BE_PRIVATE');
  check(hash(readFileSync(config)) === receipt.configSha256, 'CONFIG_CHECKSUM_MISMATCH');
  const inheritedDatabaseUrlPresent = Object.hasOwn(process.env, 'DATABASE_URL');
  // Config must independently resolve its URL; an inherited shell value is untrusted.
  delete process.env.DATABASE_URL;
  const { loadConfigFromFile } = createRequire(require.resolve('prisma/config'))('@prisma/config');
  const loaded = await loadConfigFromFile({ configFile: config, configRoot: root });
  check(!loaded.error && loaded.config?.datasource?.url, 'CONFIG_RESOLUTION_FAILED');
  const c = loaded.config;
  const u = new URL(c.datasource.url);
  verifiedUrl = u;
  const target = { host: u.hostname, port: u.port || '5432', database: decodeURIComponent(u.pathname.slice(1)), schema: u.searchParams.get('schema') || 'public' };
  check(u.protocol === 'postgresql:' && !u.hash && u.username && [...u.searchParams.keys()].every(k => k === 'schema') && u.searchParams.getAll('schema').length <= 1, 'UNAPPROVED_CONNECTION_OPTIONS');
  check(Object.entries(target).every(([k, v]) => v === pin[k] && v === receipt.target?.[k]), 'EFFECTIVE_TARGET_MISMATCH');
  console.log('EFFECTIVE_PRISMA_TARGET', JSON.stringify({ ...target, inheritedDatabaseUrlPresent, shellUrlTrusted: false }));
  check(hash(readFileSync(join(root, 'specs/proposals/phase029-modality/recovery.v2.review.sql'))) === sqlSha, 'SQL_CHECKSUM_MISMATCH');
  check(hash(readFileSync(c.schema)) === receipt.schemaSha256, 'SCHEMA_CHECKSUM_MISMATCH');
  check(realpathSync(c.schema) === join(dirname(config), 'schema.prisma') && realpathSync(c.migrations.path) === join(dirname(config), 'migrations'), 'UNEXPECTED_STAGED_PATH');
  const names = readdirSync(c.migrations.path, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  const baseline = readdirSync(join(root, 'prisma/migrations'), { withFileTypes: true }).filter(d => d.isDirectory() && d.name <= '20260930010000_dataset_modality').map(d => d.name).sort();
  const correction = '20260930020000_revert_dataset_modality';
  check(baseline.length === 22 && (receipt.profile === 'disposable' ? [21, 22, 23].includes(names.length) : names.length === 23), 'UNREVIEWED_MIGRATION_COUNT');
  const expectedNames = [...baseline, correction].slice(0, names.length);
  check(JSON.stringify(names) === JSON.stringify(expectedNames) && JSON.stringify(names) === JSON.stringify(Object.keys(receipt.migrationHashes).sort()), 'UNREVIEWED_MIGRATION_SET');
  for (const name of names) {
    const actual = hash(readFileSync(join(c.migrations.path, name, 'migration.sql')));
    const expected = name === correction ? sqlSha : hash(readFileSync(join(root, 'prisma/migrations', name, 'migration.sql')));
    check(actual === expected && actual === receipt.migrationHashes[name], 'MIGRATION_CHECKSUM_MISMATCH');
  }
  const inspection = JSON.parse(execFileSync('docker', ['inspect', pin.container], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0];
  const bindings = inspection.NetworkSettings.Ports['5432/tcp'];
  check(inspection.Id === receipt.containerId && inspection.State.Running && bindings?.length === 1 && bindings[0].HostIp === pin.host && bindings[0].HostPort === pin.port, 'CONTAINER_IDENTITY_MISMATCH');
  if (pin.label) check(inspection.Config.Labels?.['phase029.disposable'] === pin.label, 'DISPOSABLE_LABEL_MISMATCH');
  // Control-file identity is verified before opening ANY SQL connection.
  const control = execFileSync('docker', ['exec', pin.container, 'sh', '-c', 'LC_ALL=C pg_controldata "$PGDATA"'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  check(control.match(/^Database system identifier:\s+(\d+)/m)?.[1] === receipt.systemIdentifier, 'PRECONNECT_SYSTEM_ID_MISMATCH');
  console.log('PRECONNECT_INSTANCE_VERIFIED', JSON.stringify({ containerId: inspection.Id, systemIdentifier: receipt.systemIdentifier }));
  const query = "SELECT json_build_object('systemIdentifier',system_identifier::text,'database',current_database(),'otherSessions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()),'preparedTransactions',(SELECT count(*) FROM pg_prepared_xacts)) FROM pg_control_system()";
  const probe = spawnSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8', env: { ...process.env, PGHOST: target.host, PGPORT: target.port, PGDATABASE: target.database, PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGAPPNAME: 'phase029-verified-launcher', PGCONNECT_TIMEOUT: '10', PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=10000' } });
  check(probe.status === 0, 'READONLY_IDENTITY_PROBE_FAILED');
  const identity = JSON.parse(probe.stdout.trim());
  check(identity.systemIdentifier === receipt.systemIdentifier && identity.database === target.database, 'TCP_INSTANCE_MISMATCH');
  check(identity.otherSessions === 0 && identity.preparedTransactions === 0, 'UNDRAINED_DATABASE');
  console.log('READONLY_TCP_IDENTITY_VERIFIED');
  if (command === 'probe') return;
  const frozen = mkdtempSync('/tmp/phase029-launcher-frozen-');
  try {
    const file = join(frozen, 'prisma.config.ts');
    const canonicalUrl = u.toString();
    writeFileSync(file, `import {defineConfig} from ${JSON.stringify(require.resolve('prisma/config'))}; export default defineConfig(${JSON.stringify({ schema: c.schema, migrations: { path: c.migrations.path }, engine: 'classic', datasource: { url: canonicalUrl } })});`, { mode: 0o400 });
    // Both schema env("DATABASE_URL") and the frozen config get the SAME verified URL.
    // No dotenv load, inherited URL, CLI credential argument, or persistent env change.
    const childEnv = { ...process.env, DATABASE_URL: canonicalUrl };
    const cli = join(dirname(require.resolve('prisma/config')), 'build/index.js');
    const run = args => {
      const result = spawnSync(process.execPath, [cli, ...args, '--config', file], { encoding: 'utf8', env: childEnv, maxBuffer: 8 * 1024 * 1024 });
      process.stdout.write(safeOutput(result.stdout));
      process.stderr.write(safeOutput(result.stderr));
      return result.status ?? 1;
    };
    const validated = run(['validate']);
    check(validated === 0, 'PRISMA_SCHEMA_VALIDATION_FAILED');
    console.log('SCHEMA_VALIDATION_PASSED_VERIFIED_ENVIRONMENT');
    const exitCode = run(['migrate', command]);
    console.log('PRISMA_MIGRATION_EXIT', exitCode);
    process.exitCode = exitCode;
  } finally {
    rmSync(frozen, { recursive: true, force: true });
  }
}
try { await launch(); } catch (error) {
  // Loader/URL/subprocess exceptions can contain private source or credentials.
  const code = /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'LAUNCHER_CONFIGURATION_OR_IO_FAILURE';
  console.error('LAUNCHER_ABORT', code);
  process.exitCode = 1;
}
