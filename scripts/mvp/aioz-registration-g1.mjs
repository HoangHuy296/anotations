#!/usr/bin/env node
// Receipt-bound registration of the canonical AIOZ model (provider aioz-company / 68d7f474-6982-446c-8c5a-121d56d12dc9 / YOLO26s_COCO / IMAGE / DETECTION).
//   prove  — builds a throwaway G1 disposable stack (postgres + redis + minio), applies the 25-migration chain through the guarded deploy and exercises
//            the sanctioned operation, including every fail-closed case. Removes exactly what it created.
//   apply  — runs the sanctioned operation against the fresh-MVP PostgreSQL through approve-disposable.mjs -> cli.mjs seed, replays it, and proves
//            exactly one registration exists. Only ephemeral g1 provider containers are created (G1 requires isolated providers); they are removed.
//   node scripts/mvp/aioz-registration-g1.mjs prove
//   node scripts/mvp/aioz-registration-g1.mjs apply --env-file <private mvp.env>
// No secret is printed or stored. The MVP database is never written by SQL; the proof database alone receives fixture rows to demonstrate conflict rejection.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as guard from '../db-safety/guard.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const COMMAND = 'seed:register-aioz-model:yolo26s-coco';
const KEY = '68d7f474-6982-446c-8c5a-121d56d12dc9', NAME = 'YOLO26s_COCO';
const PINNED_SPEC = { kind: 'seed', cwd: '.', args: ['--import', 'tsx', 'scripts/register-aioz-model.ts', '--apply', KEY, NAME] };
const OTHER_KEY = '11111111-1111-4111-8111-111111111111';
const MINIO_IMAGE = 'minio/minio:RELEASE.2025-04-22T22-12-26Z';
const sha = value => createHash('sha256').update(value).digest('hex');
const must = (ok, code, detail) => { if (!ok) throw Object.assign(Error(code), { detail }); };
const argv = process.argv.slice(2);
const mode = argv[0];
const flag = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
must(['prove', 'apply'].includes(mode), 'MODE_REQUIRED');
const run = (cmd, args, options = {}) => { const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options }); return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; };
const base = { PATH: process.env.PATH, HOME: process.env.HOME };
const secrets = new Set();
const redact = text => { let out = guard.redact(text); for (const s of secrets) if (s) out = out.split(s).join('[REDACTED]'); return out; };
const abortCode = text => text.match(/SAFETY_ABORT (\S+)/)?.[1] ?? text.match(/(REGISTRATION_NOT_SANCTIONED|AIOZ_MODEL_REGISTRATION_CONFLICT|AIOZ_MODEL_CAPABILITY_UNSUPPORTED|DB_SAFETY_ENTRY_DENIED|AIOZ_MODEL_REGISTRATION_FAILED)/)?.[1] ?? null;

const evidence = { schema: 'phase029-aioz-registration-g1/v1', mode, startedAt: new Date().toISOString(), command: COMMAND, checks: [], failure: null };
const check = (id, pass, detail) => { evidence.checks.push({ id, pass: Boolean(pass), detail }); must(pass, `CHECK_FAILED_${id}`, detail); };
const owned = [];
const stage = mkdtempSync(join(tmpdir(), 'aioz-reg-')); chmodSync(stage, 0o700);

function startContainer(name, role, port, internalPort, image, { env = [], extra = [], cmd = [] } = {}) {
  const r = run('docker', ['run', '-d', '--name', name, '--label', 'annotation.safety=g1-disposable', '--label', `annotation.role=${role}`, '-p', `127.0.0.1:${port}:${internalPort}`, ...env.flatMap(e => ['-e', e]), ...extra, image, ...cmd]);
  must(r.status === 0, 'CONTAINER_START_FAILED', redact(r.stderr).slice(0, 200));
  owned.push(name);
  return { name, id: JSON.parse(run('docker', ['inspect', name]).stdout)[0].Id, role, port, internalPort };
}
const waitFor = (label, fn, tries = 90) => { for (let i = 0; i < tries; i += 1) { if (fn()) return; run('sleep', ['1']); } throw Object.assign(Error('NOT_READY'), { detail: label }); };

try {
  const catalog = JSON.parse(readFileSync(join(ROOT, 'scripts/db-safety/commands.json'), 'utf8'));
  check('catalog-entry-is-exactly-the-pinned-seed', isDeepStrictEqual(catalog[COMMAND], PINNED_SPEC), catalog[COMMAND]);
  const entrySource = readFileSync(join(ROOT, 'scripts/register-aioz-model.ts'), 'utf8');
  check('entrypoint-uses-the-standard-receipt-entry-without-deny-or-bare-import', /^import "\.\/db-safety\/test-entry\.cjs";/.test(entrySource) && !entrySource.includes('deny-entry') && !/from "db-safety/.test(entrySource), 'first import is the relative G1 entry');

  // ---- target database
  let pg, password;
  if (mode === 'prove') {
    password = randomBytes(18).toString('hex'); secrets.add(password);
    pg = startContainer('phase029-g1-aiozreg-postgres', 'postgres', 55476, 5432, 'postgres:16-alpine', { env: ['POSTGRES_USER=postgres', `POSTGRES_PASSWORD=${password}`, 'POSTGRES_DB=fieldframe'], extra: ['--tmpfs', '/var/lib/postgresql/data'] });
    waitFor('postgres', () => run('docker', ['exec', pg.name, 'psql', '-U', 'postgres', '-d', 'fieldframe', '-tAc', 'select 1']).status === 0);
    run('sleep', ['3']); // the official image restarts once after initdb
    waitFor('postgres-stable', () => run('docker', ['exec', pg.name, 'psql', '-U', 'postgres', '-d', 'fieldframe', '-tAc', 'select 1']).status === 0);
  } else {
    const envFile = flag('--env-file'); must(envFile && existsSync(envFile), 'ENV_FILE_REQUIRED');
    const env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(l => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    password = env.MVP_POSTGRES_PASSWORD; must(password && Number(env.MVP_POSTGRES_PORT || 55475) === 55475, 'MVP_POSTGRES_SETTINGS_INVALID'); secrets.add(password);
    const inspected = JSON.parse(run('docker', ['inspect', 'phase029-g1-mvp-postgres']).stdout || '[]')[0];
    must(inspected?.State.Running, 'MVP_POSTGRES_NOT_RUNNING');
    pg = { name: 'phase029-g1-mvp-postgres', id: inspected.Id, role: 'postgres', port: 55475, internalPort: 5432 };
  }
  pg.systemIdentifier = run('docker', ['exec', pg.name, 'sh', '-c', 'LC_ALL=C pg_controldata "$PGDATA"']).stdout.match(/^Database system identifier:\s+(\d+)/m)?.[1];
  check('target-is-not-the-application-database', pg.systemIdentifier && pg.systemIdentifier !== guard.applicationSystem, { mode, systemIdentifier: pg.systemIdentifier });
  evidence.target = { container: pg.name, port: pg.port, systemIdentifier: pg.systemIdentifier };
  const url = `postgresql://postgres:${password}@127.0.0.1:${pg.port}/fieldframe`;
  const psql = (sql, readonly = true) => {
    const r = run('docker', ['exec', '-i', ...(readonly ? ['-e', 'PGOPTIONS=-c default_transaction_read_only=on'] : []), pg.name, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'fieldframe'], { input: sql });
    must(r.status === 0, 'PSQL_FAILED', redact(r.stderr).slice(0, 200));
    return r.stdout.trim();
  };
  const rows = () => JSON.parse(psql(`SELECT coalesce(json_agg(json_build_object('key',key,'displayName',"displayName",'provider',provider,'modality',modality::text,'taskType',"taskType"::text,'isActive',"isActive")),'[]'::json) FROM public."AiModel"`));

  // ---- reviewed bytes, config, and the isolated providers G1 requires for any seed receipt
  cpSync(join(ROOT, 'prisma/migrations'), join(stage, 'migrations'), { recursive: true });
  cpSync(join(ROOT, 'prisma/schema.prisma'), join(stage, 'schema.prisma'));
  symlinkSync(join(ROOT, 'node_modules'), join(stage, 'node_modules'), 'dir');
  writeFileSync(join(stage, 'prisma.config.ts'), `import {defineConfig} from ${JSON.stringify(join(ROOT, 'node_modules/prisma/config.js'))}; export default defineConfig(${JSON.stringify({ schema: join(stage, 'schema.prisma'), migrations: { path: join(stage, 'migrations') }, engine: 'classic', datasource: { url } })});`, { mode: 0o600 });
  const providerSecret = randomBytes(18).toString('hex'); secrets.add(providerSecret);
  const token = randomBytes(4).toString('hex');
  const redis = startContainer('phase029-g1-aiozreg-redis', 'redis', 55477, 6379, 'redis:7-alpine', { cmd: ['redis-server', '--requirepass', providerSecret] });
  const minio = startContainer('phase029-g1-aiozreg-minio', 'minio', 55478, 9000, MINIO_IMAGE, { env: ['MINIO_ROOT_USER=g1' + token, `MINIO_ROOT_PASSWORD=${providerSecret}`], cmd: ['server', '/data'] });
  const providers = { MINIO_ENDPOINT: 'http://127.0.0.1:55478', MINIO_ACCESS_KEY: 'g1' + token, MINIO_SECRET_KEY: providerSecret, MINIO_BUCKET: `g1-${token}`, REDIS_HOST: '127.0.0.1', REDIS_PORT: '55477', REDIS_PASSWORD: providerSecret, REDIS_DB: '0', BULLMQ_PREFIX: `g1-${token}` };
  writeFileSync(join(stage, 'providers.json'), JSON.stringify(providers), { mode: 0o600 });
  waitFor('providers', () => run('docker', ['exec', redis.name, 'redis-cli', '-a', providerSecret, 'ping']).stdout.includes('PONG'));
  const migrationHashes = Object.fromEntries(guard.migrationFiles(join(stage, 'migrations')).map(file => [file, sha(readFileSync(file))]));
  const requestBase = () => ({ config: join(stage, 'prisma.config.ts'), configSha256: sha(readFileSync(join(stage, 'prisma.config.ts'))), postgres: pg, schemaSha256: sha(readFileSync(join(stage, 'schema.prisma'))), migrationHashes });

  let seq = 0;
  const issue = (operation, command, extra = {}) => {
    const name = `${operation}-${seq += 1}`;
    const requestPath = join(stage, `${name}-request.json`), receiptPath = join(stage, `${name}-receipt.json`);
    writeFileSync(requestPath, JSON.stringify({ ...requestBase(), operation, ...(command ? { command } : {}), ...extra }), { mode: 0o600 });
    const p = run(process.execPath, [join(ROOT, 'scripts/db-safety/approve-disposable.mjs'), requestPath, receiptPath], { env: base, cwd: ROOT });
    must(p.status === 0, 'RECEIPT_ISSUE_FAILED', redact(p.stdout + p.stderr).slice(0, 300));
    return receiptPath;
  };
  const seedReceipt = () => issue('seed', COMMAND, { providerFile: join(stage, 'providers.json'), providers: [redis, minio] });
  const launch = (receipt, command = COMMAND, env = {}) => {
    const p = run(process.execPath, [join(ROOT, 'scripts/db-safety/cli.mjs'), 'seed', command], { env: { ...base, ...(receipt ? { DB_SAFETY_RECEIPT: receipt } : {}), ...env }, cwd: ROOT });
    const out = redact(p.stdout + p.stderr);
    return { status: p.status, out, code: abortCode(out) };
  };
  // A direct invocation shaped exactly like the cli's child (same env), used to try arguments the catalog would never pass.
  const direct = (receipt, args) => {
    const p = run(process.execPath, ['--import', 'tsx', 'scripts/register-aioz-model.ts', ...args], { env: { ...base, ...providers, DATABASE_URL: new URL(url).toString(), DB_SAFETY_RECEIPT: receipt, NODE_ENV: 'test' }, cwd: ROOT });
    const out = redact(p.stdout + p.stderr);
    return { status: p.status, out, code: abortCode(out) };
  };
  // A well-formed but forged/expired receipt registered through the repository's own approve(); verify() must still reject it.
  const forged = (mutate) => {
    const valid = JSON.parse(readFileSync(seedReceipt(), 'utf8'));
    const receipt = mutate({ ...valid, id: randomUUID() });
    const path = join(stage, `forged-${seq += 1}.json`);
    guard.approve(receipt, path);
    return path;
  };

  if (mode === 'prove') {
    const deploy = issue('deploy', null);
    const d = run(process.execPath, [join(ROOT, 'scripts/db-safety/cli.mjs'), 'deploy'], { env: { ...base, DB_SAFETY_RECEIPT: deploy }, cwd: ROOT });
    check('guarded-deploy-of-25-migrations', d.status === 0 && psql('SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL') === '25', { status: d.status });
  } else {
    check('mvp-target-has-the-25-migration-chain', psql('SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL') === '25', 'history');
  }
  const before = rows();
  check('no-registration-exists-yet', before.length === 0, { rows: before.length });

  if (mode === 'prove') {
    // ---- fail-closed cases: nothing may be written
    const none = launch(null);
    check('missing-receipt-fails-closed', none.status !== 0 && /RECEIPT_REQUIRED/.test(none.out) && rows().length === 0, { status: none.status, code: none.code });
    const garbage = join(stage, 'garbage-receipt.json'); writeFileSync(garbage, '{"id":"not-a-receipt"}', { mode: 0o400 });
    const bad = launch(garbage);
    check('invalid-receipt-fails-closed', bad.status !== 0 && rows().length === 0, { status: bad.status, code: bad.code });
    const directNoReceipt = run(process.execPath, ['--import', 'tsx', 'scripts/register-aioz-model.ts', '--apply', KEY, NAME], { env: { ...base, DATABASE_URL: new URL(url).toString() }, cwd: ROOT });
    check('direct-invocation-without-receipt-is-denied-before-any-client', directNoReceipt.status !== 0 && /DB_SAFETY_ENTRY_DENIED|RECEIPT_REQUIRED/.test(directNoReceipt.stderr + directNoReceipt.stdout) && rows().length === 0, { status: directNoReceipt.status });
    const expired = launch(forged(r => ({ ...r, issuedAt: new Date(Date.now() - 3 * 3600e3).toISOString(), expiresAt: new Date(Date.now() - 2 * 3600e3).toISOString() })));
    check('expired-receipt-fails-closed', expired.status !== 0 && expired.code === 'STALE_RECEIPT' && rows().length === 0, { status: expired.status, code: expired.code });
    const wrongDb = launch(forged(r => ({ ...r, postgres: { ...r.postgres, systemIdentifier: '1234567890123456789' } })));
    check('wrong-database-identity-fails-closed', wrongDb.status !== 0 && rows().length === 0, { status: wrongDb.status, code: wrongDb.code });
    const appDb = launch(forged(r => ({ ...r, postgres: { ...r.postgres, systemIdentifier: guard.applicationSystem } })));
    check('application-database-identity-fails-closed', appDb.status !== 0 && rows().length === 0, { status: appDb.status, code: appDb.code });
    const wrongCommand = launch(seedReceipt(), 'prisma/seed.ts');
    check('receipt-for-a-different-command-fails-closed', wrongCommand.status !== 0 && wrongCommand.code === 'COMMAND_SCOPE_MISMATCH' && rows().length === 0, { status: wrongCommand.status, code: wrongCommand.code });
    const receiptForDirect = seedReceipt();
    for (const [id, args] of [
      ['different-provider-model-uuid', ['--apply', OTHER_KEY, NAME]],
      ['different-display-name', ['--apply', KEY, 'Another_Model']],
      ['extra-argument', ['--apply', KEY, NAME, 'extra']],
    ]) {
      const r = direct(receiptForDirect, args);
      check(`${id}-fails-closed-before-database-access`, r.status !== 0 && /REGISTRATION_NOT_SANCTIONED/.test(r.out) && rows().length === 0, { status: r.status, code: r.code });
    }
    // provider/modality/task are not caller inputs: a tampered catalog entry or scope module changes a hashed protected source and invalidates the receipt
    const tamperedReceipt = forged(r => ({ ...r, sources: { ...r.sources, [join(ROOT, 'scripts/db-safety/commands.json')]: '0'.repeat(64) } }));
    const tampered = launch(tamperedReceipt);
    check('catalog-tamper-after-approval-fails-closed', tampered.status !== 0 && tampered.code === 'APPROVED_FILE_CHANGED' && rows().length === 0, { status: tampered.status, code: tampered.code });
  }

  // ---- the sanctioned registration (receipt bound), then an exact replay
  const first = launch(seedReceipt());
  check('sanctioned-registration-succeeds', first.status === 0 && /"created":true/.test(first.out), { status: first.status, code: first.code, created: /"created":true/.test(first.out) });
  const exact = r => r.length === 1 && r[0].key === KEY && r[0].displayName === NAME && r[0].provider === 'aioz-company' && r[0].modality === 'IMAGE' && r[0].taskType === 'DETECTION' && r[0].isActive === true;
  check('exactly-one-active-registration-for-the-canonical-model', exact(rows()), rows());
  const replay = launch(seedReceipt());
  check('replay-is-idempotent-no-duplicate', replay.status === 0 && /"created":false/.test(replay.out) && exact(rows()), { status: replay.status, created: /"created":false/.test(replay.out), rows: rows().length });

  if (mode === 'prove') {
    // ---- conflicting row: never silently remapped or reactivated
    psql(`UPDATE public."AiModel" SET "displayName"='Renamed_Elsewhere' WHERE key='${KEY}'`, false);
    const conflict = launch(seedReceipt());
    const after = rows();
    check('conflicting-registration-is-rejected-not-remapped', conflict.status !== 0 && /AIOZ_MODEL_REGISTRATION_CONFLICT/.test(conflict.out) && after.length === 1 && after[0].displayName === 'Renamed_Elsewhere', { status: conflict.status, code: conflict.code, rows: after.length });
    psql(`UPDATE public."AiModel" SET "displayName"='${NAME}', "isActive"=false WHERE key='${KEY}'`, false);
    const inactive = launch(seedReceipt());
    check('inactive-registration-is-rejected-not-reactivated', inactive.status !== 0 && /AIOZ_MODEL_REGISTRATION_CONFLICT/.test(inactive.out) && rows()[0].isActive === false && rows().length === 1, { status: inactive.status, code: inactive.code });
  }
  evidence.finalRows = rows();
  evidence.result = 'PASS';
} catch (error) {
  evidence.result = 'FAIL'; evidence.failure = { code: error.message, detail: error.detail ?? null };
} finally {
  for (const name of owned.reverse()) run('docker', ['rm', '-fv', name]);
  evidence.cleanup = { removed: owned.length, remaining: run('docker', ['ps', '-a', '--format', '{{.Names}}', '--filter', 'name=phase029-g1-aiozreg']).stdout.trim().split('\n').filter(Boolean) };
  rmSync(stage, { recursive: true, force: true });
  evidence.finishedAt = new Date().toISOString();
  const out = resolve(join(ROOT, 'specs/029-modality-specific-datasets/verification/mvp-aioz', `aioz-registration-${mode}-${evidence.startedAt.replace(/[-:.]/g, '').slice(0, 15)}Z`));
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const text = JSON.stringify(evidence, null, 2) + '\n';
  for (const s of secrets) must(!s || !text.includes(s), 'SECRET_IN_EVIDENCE');
  writeFileSync(join(out, 'evidence.json'), text, { mode: 0o400, flag: 'wx' });
  console.log(JSON.stringify({ result: evidence.result, out, failure: evidence.failure, checks: evidence.checks.map(c => `${c.pass ? 'PASS' : 'FAIL'} ${c.id}`), cleanup: evidence.cleanup }, null, 2));
  process.exitCode = evidence.result === 'PASS' ? 0 : 1;
}
