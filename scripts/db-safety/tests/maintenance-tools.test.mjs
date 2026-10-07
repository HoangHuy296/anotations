import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BASELINE_SCHEMA, CONTAINERS, baselineFrom, candidateSql, collectInventory, evaluate } from '../backfill-window-inventory.mjs';
import { RECEIPT_SCHEMA, REQUEST_SCHEMA, runBackupProof, validateRequest } from '../backup-proof.mjs';
import { PINNED, SERVICE_SOURCE, verifyImage } from '../release-image-verify.mjs';
import { historyDigest, manifestDigest } from '../backfill-binding.mjs';

// Offline: Docker, PostgreSQL, Redis and Git are faked. These tests pin the decision rules and the "read-only / fail closed" shape of the three operational tools.
const sha = value => createHash('sha256').update(value).digest('hex');
const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const readSource = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

// ============================================================================================ window inventory
const history23 = () => Array.from({ length: 23 }, (_, index) => ({ name: `m${index}`, checksum: sha(`m${index}`), finished: true, rolledBack: false }));
const manifestRows = count => Array.from({ length: count }, (_, index) => ['relation', JSON.stringify(['public', `t${index}`]), [index]]);
const JOBS = [{ id: 'job-a', type: 'IMPORT_DATASET', status: 'QUEUED' }, { id: 'job-b', type: 'AI_PREANNOTATE_ASSET', status: 'RUNNING' }];
const inventory = (over = {}) => {
  const rows = manifestRows(1829);
  return {
    schema: 'phase029-window-inventory/v1', generatedAt: '2026-10-06T00:00:00.000Z', readOnly: true,
    containers: Object.fromEntries(Object.entries(CONTAINERS).map(([role, name]) => [role, { name, id: sha(`id-${role}`), image: `sha256:${sha(`img-${role}`)}`, imageName: `img-${role}`, state: 'running', running: true }])),
    postgres: { systemIdentifier: '7662655305624969250', database: 'fieldframe', user: 'fieldframe', serverVersion: '16.14', history: history23(), historySha256: historyDigest(history23()), schemaEntries: 1829, schemaManifestSha256: manifestDigest(rows),
      counts: { datasets: 120, datasetsLive: 75, datasetsUnresolved: 120, assets: 615, annotations: 231770, jobs: 450, importsByStatus: { PREPARING: 11 } }, nonTerminalJobs: JOBS, preparingImports: ['p1', 'p2'],
      sessions: { clientSessions: 22, idleInTransaction: 0, activeQueries: 0, longestTransactionSeconds: 0, byApplication: { '(none)': 22 } }, locks: { ungrantedLocks: 0, preparedTransactions: 0, accessExclusiveOnAppTables: 0 },
      dbOnlyCandidates: ['d1', 'd2', 'd3'], bucket: 'annotation-assets' },
    redis: { queue: 'annotation-platform:fieldframe-jobs', db: 15, sets: { wait: 0, active: 0, paused: 0, delayed: 0, prioritized: 0, waitingChildren: 0 }, history: { failed: 64, completed: 2393 }, nonTerminalJobKeys: { 'job-a': { exists: false, completed: false }, 'job-b': { exists: false, completed: false } } },
    ...over,
  };
};
const baseline = () => baselineFrom(inventory());
const ids = verdict => verdict.hardStops.map(stop => stop.id);

test('inventory baseline: derived from a 23-migration inventory only, and an unchanged inventory is GO', () => {
  const b = baseline();
  assert.equal(b.schema, BASELINE_SCHEMA); assert.equal(b.history23.count, 23); assert.equal(b.schema1829.entries, 1829);
  assert.throws(() => baselineFrom({ ...inventory(), postgres: { ...inventory().postgres, history: history23().slice(0, 22) } }), /BASELINE_REQUIRES_23_MIGRATIONS/);
  const verdict = evaluate(inventory(), b);
  assert.equal(verdict.status, 'GO'); assert.deepEqual(verdict.hardStops, []);
});
const DRIFTS = {
  'a different database': [inv => { inv.postgres.systemIdentifier = '1111111111111111111'; }, 'HS-01-SYSTEM-IDENTIFIER'],
  'a different database name': [inv => { inv.postgres.database = 'other'; }, 'HS-01-DATABASE-NAME'],
  'a 24th migration': [inv => { inv.postgres.history = [...history23(), { name: 'x', checksum: sha('x'), finished: true, rolledBack: false }]; }, 'HS-02-HISTORY-COUNT'],
  'a changed migration record': [inv => { inv.postgres.history[5] = { ...inv.postgres.history[5], checksum: sha('changed') }; inv.postgres.historySha256 = historyDigest(inv.postgres.history); }, 'HS-02-HISTORY-DRIFT'],
  'a rolled-back migration': [inv => { inv.postgres.history[5] = { ...inv.postgres.history[5], rolledBack: true }; inv.postgres.historySha256 = historyDigest(inv.postgres.history); }, 'HS-02-HISTORY-INCOMPLETE'],
  'a schema entry added': [inv => { inv.postgres.schemaEntries = 1830; }, 'HS-03-SCHEMA-ENTRIES'],
  'schema drift with the same count': [inv => { inv.postgres.schemaManifestSha256 = sha('drift'); }, 'HS-03-SCHEMA-DRIFT'],
  'a new non-terminal job': [inv => { inv.postgres.nonTerminalJobs = [...JOBS, { id: 'job-new', type: 'IMPORT_DATASET', status: 'QUEUED' }]; }, 'HS-04-NON-TERMINAL-JOBS'],
  'a job changed state': [inv => { inv.postgres.nonTerminalJobs = [{ ...JOBS[0], status: 'RUNNING' }, JOBS[1]]; }, 'HS-04-NON-TERMINAL-JOBS'],
  'a job disappeared': [inv => { inv.postgres.nonTerminalJobs = [JOBS[0]]; }, 'HS-04-NON-TERMINAL-JOBS'],
  'a new PREPARING import': [inv => { inv.postgres.preparingImports = ['p1', 'p2', 'p3']; }, 'HS-05-PREPARING-IMPORTS'],
  'a candidate appeared': [inv => { inv.postgres.dbOnlyCandidates = ['d1', 'd2', 'd3', 'd4']; }, 'HS-06-CANDIDATE-SET'],
  'a candidate disappeared': [inv => { inv.postgres.dbOnlyCandidates = ['d1', 'd2']; }, 'HS-06-CANDIDATE-SET'],
  'a rebuilt web container': [inv => { inv.containers.web.id = sha('rebuilt'); }, 'HS-07-CONTAINER-WEB'],
  'a different worker image': [inv => { inv.containers.worker.image = 'sha256:other'; }, 'HS-07-CONTAINER-WORKER'],
  'a missing container': [inv => { delete inv.containers.minio; }, 'HS-07-CONTAINER-MINIO'],
  'queue not empty': [inv => { inv.redis.sets.wait = 1; }, 'HS-08-QUEUE-NOT-EMPTY'],
  'delayed jobs': [inv => { inv.redis.sets.delayed = 2; }, 'HS-08-QUEUE-NOT-EMPTY'],
  'a job key appeared in redis': [inv => { inv.redis.nonTerminalJobKeys['job-a'] = { exists: true, completed: false }; }, 'HS-08-JOB-QUEUE-STATE'],
  'a prepared transaction': [inv => { inv.postgres.locks.preparedTransactions = 1; }, 'HS-09-PREPARED-TRANSACTIONS'],
  'an ungranted lock': [inv => { inv.postgres.locks.ungrantedLocks = 1; }, 'HS-09-UNGRANTED-LOCKS'],
  'an idle-in-transaction session': [inv => { inv.postgres.sessions.idleInTransaction = 1; }, 'HS-09-IDLE-IN-TRANSACTION'],
};
for (const [label, [mutate, expected]] of Object.entries(DRIFTS)) test(`inventory STOPs on ${label} (${expected})`, () => {
  const inv = inventory(); mutate(inv);
  const verdict = evaluate(inv, baseline());
  assert.equal(verdict.status, 'STOP'); assert.ok(ids(verdict).includes(expected), `${label}: ${ids(verdict)}`);
});
test('inventory: counts growing is informational, never a stop; drained mode demands zero sessions and stopped web/worker', () => {
  const grown = inventory(); grown.postgres.counts = { ...grown.postgres.counts, annotations: 300000, datasets: 121 }; grown.postgres.sessions.clientSessions = 30;
  const verdict = evaluate(grown, baseline());
  assert.equal(verdict.status, 'GO'); assert.ok(verdict.informational.some(entry => entry.id === 'DRIFT-ANNOTATIONS') && verdict.informational.some(entry => entry.id === 'DRIFT-DATASETS'));
  const drained = evaluate(inventory(), baseline(), { mode: 'drained' });
  assert.equal(drained.status, 'STOP'); assert.deepEqual(ids(drained).sort(), ['HS-10-NOT-DRAINED-SESSIONS', 'HS-10-WEB-RUNNING', 'HS-10-WORKER-RUNNING']);
  const quiet = inventory(); quiet.postgres.sessions = { ...quiet.postgres.sessions, clientSessions: 0, byApplication: {} }; quiet.containers.web.running = false; quiet.containers.worker.running = false;
  assert.equal(evaluate(quiet, baseline(), { mode: 'drained' }).status, 'GO');
  for (const [mutate, id] of [[inv => { inv.postgres.sessions.activeQueries = 1; }, 'HS-10-ACTIVE-QUERIES'], [inv => { inv.postgres.locks.accessExclusiveOnAppTables = 1; }, 'HS-10-EXCLUSIVE-LOCKS']]) { const inv = structuredClone(quiet); mutate(inv); assert.ok(ids(evaluate(inv, baseline(), { mode: 'drained' })).includes(id)); }
});
test('inventory after a migration step: expected history length and schema entries, the fingerprint is surfaced for the authorization, a replaced container can be allowed explicitly', () => {
  for (const [count, entries] of [[24, 1841], [25, 1842]]) {
    const inv = inventory(); inv.postgres.history = [...history23(), ...Array.from({ length: count - 23 }, (_, i) => ({ name: `new${i}`, checksum: sha(`n${i}`), finished: true, rolledBack: false }))]; inv.postgres.schemaEntries = entries;
    const verdict = evaluate(inv, baseline(), { expectHistory: count, skipCandidates: true });
    assert.equal(verdict.status, 'GO', JSON.stringify(verdict.hardStops)); assert.ok(verdict.informational.some(entry => entry.id === 'SCHEMA-FINGERPRINT-FOR-AUTHORIZATION'));
    assert.ok(ids(evaluate(inv, baseline(), { expectHistory: 23, skipCandidates: true })).includes('HS-02-HISTORY-COUNT'));
  }
  const inv = inventory(); inv.containers.web.id = sha('candidate'); inv.containers.worker.id = sha('candidate-worker');
  assert.equal(evaluate(inv, baseline(), { allowContainerChange: ['web', 'worker'] }).status, 'GO');
  assert.ok(ids(evaluate(inv, baseline(), { allowContainerChange: ['web'] })).includes('HS-07-CONTAINER-WORKER'));
});
test('inventory collection is read-only: fake docker/psql/redis, only inspect/exec reads, one READ ONLY transaction, a password is never requested', () => {
  const calls = [];
  const rows = manifestRows(1829);
  const exec = (command, args, input) => {
    calls.push({ command, args, input });
    if (command !== 'docker') return { status: 127, stdout: '', stderr: '' };
    if (args[0] === 'inspect') return { status: 0, stdout: JSON.stringify([{ Id: sha(args[1]), Image: `sha256:${sha(`img-${args[1]}`)}`, Config: { Image: 'x' }, State: { Status: 'running', Running: true, StartedAt: 't' }, RestartCount: 0 }]), stderr: '' };
    if (args[0] === 'exec' && args.includes('printenv')) return { status: 0, stdout: { POSTGRES_USER: 'fieldframe', POSTGRES_DB: 'fieldframe', MINIO_BUCKET: 'annotation-assets', BULLMQ_PREFIX: 'annotation-platform', REDIS_DB: '15' }[args.at(-1)] + '\n', stderr: '' };
    if (args.includes('psql')) {
      const lines = [{ systemIdentifier: '7662655305624969250', database: 'fieldframe', user: 'fieldframe', serverVersion: '16.14' }, history23(), rows, { datasets: 1, datasetsLive: 1, datasetsUnresolved: 1, assets: 1, annotations: 1, jobs: 1, importsByStatus: {} }, [], [], { clientSessions: 0, idleInTransaction: 0, activeQueries: 0, longestTransactionSeconds: 0, byApplication: {} }, { ungrantedLocks: 0, preparedTransactions: 0, accessExclusiveOnAppTables: 0 }, []];
      return { status: 0, stdout: lines.map(line => JSON.stringify(line)).join('\n') + '\n', stderr: '' };
    }
    if (args.includes('redis-cli') || args.includes('sh')) return { status: 0, stdout: ['LLEN:wait=0', 'LLEN:active=0', 'LLEN:paused=0', 'ZCARD:delayed=0', 'ZCARD:prioritized=0', 'ZCARD:waiting-children=0', 'ZCARD:failed=1', 'ZCARD:completed=2'].join('\n') + '\n', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  const result = collectInventory({ now: () => 0, root: REPO, exec });
  assert.equal(result.readOnly, true); assert.equal(result.postgres.schemaEntries, 1829); assert.equal(result.redis.sets.wait, 0);
  const verbs = new Set(calls.map(call => `${call.command}:${call.args[0]}`)); assert.deepEqual([...verbs].sort(), ['docker:exec', 'docker:inspect']);
  const psql = calls.find(call => call.args.includes('psql'));
  assert.match(psql.input, /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/); assert.match(psql.input, /ROLLBACK;\n$/);
  assert.ok(psql.args.some(arg => /default_transaction_read_only=on/.test(arg)));
  for (const statement of psql.input.split('\n').filter(line => line && !/^(BEGIN|ROLLBACK)/.test(line))) assert.match(statement, /^(SELECT|WITH)\b/, statement.slice(0, 40));
  assert.doesNotMatch(psql.input, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|LOCK)\b\s/i);
  assert.ok(!calls.some(call => call.args.some(arg => /PGPASSWORD|REDIS_PASSWORD=|-a$/.test(String(arg)))), 'no password on any command line');
});
test('inventory source: only read verbs, no write command, output file is exclusive; the DB-only candidate SQL is a pure SELECT with a validated bucket', () => {
  const source = readSource('backfill-window-inventory.mjs');
  assert.doesNotMatch(source, /'(rm|stop|start|restart|kill|run|create|cp|pause|unpause|update|build|pull|push|commit)'/);
  assert.doesNotMatch(source, /\b(SET|DEL|FLUSHDB|FLUSHALL|LPUSH|RPUSH|ZADD|ZREM|HSET|EXPIRE|SCRIPT|EVAL|CONFIG|SHUTDOWN|BGSAVE)\b\s/);
  assert.match(source, /flag: 'wx'/);
  assert.match(candidateSql('annotation-assets'), /^SELECT coalesce\(json_agg\(d\.id/); assert.doesNotMatch(candidateSql('annotation-assets'), /\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/);
  assert.throws(() => candidateSql("x'; DROP TABLE y; --"), /BUCKET_NAME_INVALID/);
});

// ============================================================================================ backup proof
function fakeDocker(options = {}) {
  const state = {
    calls: [], sourceTables: [['Asset', 3, 'aaa'], ['Dataset', 5, 'ddd'], ['_prisma_migrations', 25, 'mmm']], sourceHistory: history23(), sequences: [['public.s', 5]],
    schema: 'CREATE TABLE x;', restored: null, restoreExists: false, restoreRemoved: false, sessions: '0 0', ...options.state,
  };
  const SOURCE = { name: 'src-pg', id: 'a'.repeat(64) }, RESTORE_ID = 'b'.repeat(64);
  const psqlAnswer = (tables, history, input) => {
    if (/string_agg\(h/.test(input)) return tables.map(row => JSON.stringify(row)).join('\n') + '\n';
    return [{ database: 'fieldframe', systemIdentifier: '7000000000000000001' }, history, tables.map(row => row[0]), state.sequences].map(line => JSON.stringify(line)).join('\n') + '\n';
  };
  const exec = (command, args, execOptions = {}) => {
    state.calls.push({ command, args, input: execOptions.input, env: execOptions.env });
    if (command !== 'docker') return { status: 127, stdout: '', stderr: '' };
    const [verb] = args;
    const target = args[1];
    const onRestore = args.includes(RESTORE_ID);
    if (verb === 'inspect') {
      if (target === SOURCE.name) return { status: 0, stdout: JSON.stringify([{ Id: options.sourceId ?? SOURCE.id, Image: 'sha256:' + 'c'.repeat(64), State: { Running: options.sourceRunning ?? true }, Config: { Labels: {} } }]), stderr: '' };
      if (target === 'phase029-bk-run-bk-000001') return state.restoreExists ? { status: 0, stdout: JSON.stringify([{ Id: RESTORE_ID }]), stderr: '' } : { status: 1, stdout: '', stderr: 'No such object' };
      if (target === RESTORE_ID) return state.restoreRemoved ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: JSON.stringify([{ Id: RESTORE_ID, Image: 'sha256:' + 'c'.repeat(64), State: { Running: true }, Config: { Labels: { 'annotation.safety': options.restoreLabel ?? 'backup-proof' } }, HostConfig: { NetworkMode: 'none' } }]), stderr: '' };
    }
    if (verb === 'run') { state.restoreExists = true; return { status: options.runFails ? 1 : 0, stdout: RESTORE_ID + '\n', stderr: '' }; }
    if (verb === 'rm') { state.restoreRemoved = true; state.restoreExists = false; return { status: options.rmFails ? 1 : 0, stdout: '', stderr: '' }; }
    if (verb === 'cp') return { status: options.cpFails ? 1 : 0, stdout: '', stderr: '' };
    if (verb === 'exec') {
      const joined = args.join(' ');
      if (joined.includes('pg_controldata')) return { status: 0, stdout: `Database system identifier:           ${options.controlId ?? '7000000000000000001'}\n`, stderr: '' };
      if (joined.includes('pg_isready')) return { status: 0, stdout: '', stderr: '' };
      if (joined.includes('createdb')) return { status: options.createdbFails ? 1 : 0, stdout: '', stderr: '' };
      if (joined.includes('truncated.dump')) return { status: options.truncatedAccepted ? 0 : 1, stdout: '', stderr: '' };
      if (joined.includes('pg_restore --list')) return options.listFails ? { status: 1, stdout: '', stderr: 'bad' } : { status: 0, stdout: '; Archive\n123; 0 1 TABLE DATA public Asset u\n124; 0 2 TABLE DATA public Dataset u\n', stderr: '' };
      if (joined.includes('pg_restore -U')) { if (options.restoreFails) return { status: 1, stdout: '', stderr: 'fail' }; state.restored = { tables: state.sourceTables.map(row => [...row]), history: state.sourceHistory.map(row => ({ ...row })), schema: options.restoredSchema ?? state.schema }; if (options.restoredTableChange) state.restored.tables[1] = ['Dataset', 4, 'xxx']; if (options.restoredHistoryChange) state.restored.history[0].checksum = 'zz'; return { status: 0, stdout: '', stderr: '' }; }
      if (joined.includes('pg_dump') && joined.includes('--schema-only')) return { status: 0, stdout: onRestore ? (state.restored?.schema ?? '') : state.schema, stdout2: '', stderr: '' };
      if (joined.includes('psql')) {
        const input = execOptions.input ?? '';
        if (/pg_prepared_xacts/.test(input) && !/pg_tables/.test(input)) return { status: 0, stdout: state.sessions + '\n', stderr: '' };
        if (/UPDATE public\._prisma_migrations/.test(input)) { state.restored.history[0].checksum = 'tampered-control'; return { status: 0, stdout: '', stderr: '' }; }
        const tables = onRestore ? state.restored.tables : state.sourceTables;
        const history = onRestore ? state.restored.history : state.sourceHistory;
        return { status: 0, stdout: psqlAnswer(tables, history, input), stderr: '' };
      }
    }
    return { status: 1, stdout: '', stderr: 'unexpected ' + args.join(' ').slice(0, 60) };
  };
  const dumpToFile = (args, filePath) => { state.calls.push({ command: 'docker', args, dump: true }); if (options.dumpFails) return { status: 1, stderr: 'x' }; writeFileSync(filePath, Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(4096, 7)]), { mode: 0o600 }); return { status: 0, stderr: '' }; };
  return { state, exec, dumpToFile };
}
function backupContext(options = {}, requestOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bk-test-'));
  const backups = join(dir, 'backups'); mkdirSync(backups, { mode: 0o700 });
  const fake = fakeDocker(options);
  const request = { schema: REQUEST_SCHEMA, runToken: 'run-bk-000001', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), source: { container: 'src-pg', id: 'a'.repeat(64), user: 'fieldframe', database: 'fieldframe', expectedSystemIdentifier: '7000000000000000001' }, backupDir: join(backups, 'run-1'), negativeControls: true, requireDrained: true, ...requestOverrides };
  const requestPath = join(dir, 'request.json'); writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
  const deps = { root: dir, now: () => Date.now(), exec: fake.exec, dumpToFile: fake.dumpToFile, newSecret: () => 'random-password-value', sleep: async () => {}, backupRoots: () => [backups] };
  return { dir, backups, request, requestPath, deps, fake, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
test('backup proof: dump, checksum, list, real restore into a fresh isolated container, comparison, controls, removal, sealed receipt', async () => {
  const ctx = backupContext();
  try {
    const result = await runBackupProof(ctx.requestPath, ctx.deps);
    assert.equal(result.ok, true, result.code); assert.equal(result.code, 'VERIFIED');
    assert.deepEqual(readdirSync(result.dir).sort(), ['backup-receipt.json', 'backup.dump', 'backup.list']);
    for (const name of readdirSync(result.dir)) assert.equal(statSync(join(result.dir, name)).mode & 0o777, 0o400, name);
    const receipt = JSON.parse(readFileSync(join(result.dir, 'backup-receipt.json'), 'utf8'));
    assert.equal(receipt.schema, RECEIPT_SCHEMA); assert.equal(receipt.status, 'VERIFIED'); assert.equal(receipt.restore.removed, true); assert.equal(receipt.restore.networkMode, 'none');
    assert.equal(receipt.dump.sha256, sha(readFileSync(join(result.dir, 'backup.dump')))); assert.equal(receipt.dump.listEntries, 2);
    assert.deepEqual(receipt.controls, { truncatedDumpRejected: true, tamperDetected: true });
    assert.equal(receipt.state.migrationCount, 23); assert.equal(receipt.state.tables, 3); assert.deepEqual(receipt.state.rows, { Asset: 3, Dataset: 5, _prisma_migrations: 25 });
    assert.equal(ctx.fake.state.restoreRemoved, true);
    const run = ctx.fake.state.calls.find(call => call.args[0] === 'run');
    assert.ok(run.args.includes('--network') && run.args[run.args.indexOf('--network') + 1] === 'none'); assert.ok(run.args.includes('POSTGRES_PASSWORD') && !run.args.join(' ').includes('random-password-value'), 'the password is passed by name only');
    assert.equal(run.env.POSTGRES_PASSWORD, 'random-password-value'); assert.equal(run.args.at(-1), 'sha256:' + 'c'.repeat(64), 'created from the source image id');
    // the source is only ever read: its container sees exactly these verbs
    const sourceCalls = ctx.fake.state.calls.filter(call => call.args.includes('src-pg') && call.args[0] !== 'inspect');
    for (const call of sourceCalls) assert.ok(call.args.join(' ').includes('pg_controldata') || call.args.includes('psql') || call.args.includes('pg_dump'), call.args.join(' '));
    const writes = sourceCalls.filter(call => /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/.test(call.input ?? ''));
    assert.deepEqual(writes, []);
    assert.ok(sourceCalls.filter(call => call.args.includes('psql')).every(call => call.args.some(arg => /default_transaction_read_only=on/.test(arg)) || /pg_prepared_xacts/.test(call.input ?? '')));
  } finally { ctx.cleanup(); }
});
const BACKUP_FAILURES = {
  'source container id differs': [{ sourceId: 'f'.repeat(64) }, 'SOURCE_IDENTITY_MISMATCH'],
  'source not running': [{ sourceRunning: false }, 'SOURCE_IDENTITY_MISMATCH'],
  'source control file reports another system': [{ controlId: '9999999999999999999' }, 'SYSTEM_IDENTITY_MISMATCH'],
  'source not drained': [{ state: { sessions: '3 0' } }, 'SOURCE_NOT_DRAINED'],
  'source has prepared transactions': [{ state: { sessions: '0 1' } }, 'SOURCE_NOT_DRAINED'],
  'dump fails': [{ dumpFails: true }, 'DUMP_FAILED'],
  'restore container cannot be created': [{ runFails: true }, 'RESTORE_CONTAINER_NOT_CREATED'],
  'dump cannot be copied': [{ cpFails: true }, 'DUMP_COPY_FAILED'],
  'dump unreadable by pg_restore --list': [{ listFails: true }, 'DUMP_UNREADABLE'],
  'database cannot be created': [{ createdbFails: true }, 'RESTORE_DATABASE_NOT_CREATED'],
  'restore fails': [{ restoreFails: true }, 'RESTORE_FAILED'],
  'restored history differs': [{ restoredHistoryChange: true }, 'RESTORE_HISTORY_MISMATCH'],
  'restored table data differs': [{ restoredTableChange: true }, 'RESTORE_TABLE_DATA_MISMATCH'],
  'restored schema differs': [{ restoredSchema: 'CREATE TABLE y;' }, 'RESTORE_SCHEMA_MISMATCH'],
  'a truncated dump would be accepted (control)': [{ truncatedAccepted: true }, 'CONTROL_TRUNCATED_DUMP_ACCEPTED'],
};
for (const [label, [options, expected]] of Object.entries(BACKUP_FAILURES)) test(`backup proof fails closed (${label}) with ${expected}, seals a FAILED receipt and removes the restore container`, async () => {
  const ctx = backupContext(options);
  try {
    const result = await runBackupProof(ctx.requestPath, ctx.deps);
    assert.equal(result.ok, false, label); assert.equal(result.code, expected, label);
    const receipt = JSON.parse(readFileSync(join(result.dir, 'backup-receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'FAILED'); assert.equal(receipt.code, expected);
    if (ctx.fake.state.calls.some(call => call.args[0] === 'run')) assert.equal(ctx.fake.state.restoreRemoved, true, 'the restore container never leaks');
    assert.ok(!ctx.fake.state.calls.some(call => call.args[0] === 'rm' && call.args.includes('src-pg')), 'the source is never removed');
  } finally { ctx.cleanup(); }
});
test('backup proof: a container whose labels are not ours is never removed; requests are strict', async () => {
  const ctx = backupContext({ restoreLabel: 'someone-else' });
  try {
    const result = await runBackupProof(ctx.requestPath, ctx.deps);
    assert.equal(result.ok, false);
    assert.ok(!ctx.fake.state.calls.some(call => call.args[0] === 'rm'), 'no removal of a container whose labels do not match');
  } finally { ctx.cleanup(); }
  const request = backupContext().request;
  for (const bad of [{ ...request, extra: 1 }, { ...request, source: { ...request.source, id: 'short' } }, { ...request, runToken: 'X' }, { ...request, expiresAt: new Date(Date.now() - 1).toISOString() }, { ...request, backupDir: 'relative' }, { ...request, negativeControls: 'yes' }]) assert.throws(() => validateRequest(bad), /REQUEST_/);
  const outside = backupContext({}, { backupDir: join(tmpdir(), 'bk-outside-' + Math.random()) });
  try { const result = await runBackupProof(outside.requestPath, outside.deps); assert.equal(result.code, 'BACKUP_DIR_OUTSIDE_ALLOWED_ROOT'); assert.equal(outside.fake.state.calls.length, 0, 'nothing is touched before the directory check'); } finally { outside.cleanup(); }
  const reuse = backupContext();
  try { mkdirSync(reuse.request.backupDir, { mode: 0o700 }); writeFileSync(join(reuse.request.backupDir, 'x'), '1'); assert.equal((await runBackupProof(reuse.requestPath, reuse.deps)).code, 'BACKUP_DIR_NOT_EMPTY'); } finally { reuse.cleanup(); }
});
test('backup proof source: dumps with -Fc, restores with --exit-on-error into a no-network container, and removes by exact id only', () => {
  const source = readSource('backup-proof.mjs');
  assert.match(source, /'-Fc'/); assert.match(source, /'--exit-on-error'/); assert.match(source, /'--network', 'none'/); assert.match(source, /'rm', '-fv', restoreId/);
  assert.doesNotMatch(source, /'(stop|kill|restart|prune)'/); assert.doesNotMatch(source, /'-p'/, 'no published port');
});

// ============================================================================================ image verification
const REVISION = 'e'.repeat(40);
function fakeImageWorld(options = {}) {
  const calls = [];
  const files = new Map();
  const content = path => options.content?.[path] ?? (path === 'lib/generated/prisma/models/Dataset.ts' ? (options.datasetText ?? 'modality modalityContentRevision modalityResolvedAt modalityResolverSubject') : path === 'lib/generated/prisma/models/PreparedImport.ts' ? (options.preparedText ?? 'creationRequestHash') : `content of ${path}`);
  const gitFor = path => options.gitContent?.[path] ?? (path === 'lib/generated/prisma/models/Dataset.ts' ? 'modality modalityContentRevision modalityResolvedAt modalityResolverSubject' : path === 'lib/generated/prisma/models/PreparedImport.ts' ? 'creationRequestHash' : content(path));
  const exec = (command, args, execOptions = {}) => {
    calls.push({ command, args });
    if (command === 'git') { const path = args[1].slice(args[1].indexOf(':') + 1); return options.notInRevision === path ? { status: 128, stdout: '', stderr: '' } : { status: 0, stdout: gitFor(path), stderr: '' }; }
    if (command === 'sh') return { status: 0, stdout: options.envFilesInFilesystem ?? '', stderr: '' };
    const [verb] = args;
    if (verb === 'image') return options.missingImage ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: JSON.stringify([{ Id: 'sha256:' + 'd'.repeat(64), Config: { WorkingDir: '/workspace', Labels: { 'org.opencontainers.image.revision': options.labelRevision ?? REVISION, 'annotation.platform.service': options.labelService ?? 'web' }, Entrypoint: null, Cmd: options.cmd ?? ['pnpm', '--filter', '@annotationplatform/web', 'start'], Healthcheck: options.healthcheck ?? null, Env: options.env ?? ['NODE_ENV=production', 'PATH=/usr/bin'] } }]), stderr: '' };
    if (verb === 'create') return { status: options.createFails ? 1 : 0, stdout: 'f'.repeat(64) + '\n', stderr: 'x' };
    if (verb === 'inspect') return { status: 0, stdout: JSON.stringify([{ Id: 'f'.repeat(64), Config: { Labels: { 'annotation.safety': 'image-verify' } }, State: { Running: false } }]), stderr: '' };
    if (verb === 'rm') return { status: 0, stdout: '', stderr: '' };
    if (verb === 'cp') {
      const path = args[1].replace(`${'f'.repeat(64)}:/workspace/`, ''), target = args[2];
      if (options.absentInImage?.includes(path)) return { status: 1, stdout: '', stderr: '' };
      if (ENV_PROBES.includes(path)) return options.envFilePresent === path ? (writeFileSync(target, 'SECRET=1'), { status: 0, stdout: '', stderr: '' }) : { status: 1, stdout: '', stderr: '' };
      if (path === 'lib/generated/prisma' || path === 'prisma/migrations') { mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'f.txt'), path); return { status: 0, stdout: '', stderr: '' }; }
      writeFileSync(target, path === 'apps/web/.next/BUILD_ID' ? 'build123' : content(path));
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: '' };
  };
  void files;
  return { exec, calls };
}
const ENV_PROBES = ['.env', '.env.local', '.env.review', '.env.production', '.env.development', 'apps/web/.env', 'apps/web/.env.local', 'apps/worker/.env', 'apps/realtime/.env'];
const verifyWith = (options = {}, service = 'web') => {
  const world = fakeImageWorld({ ...options });
  return { ...verifyImage({ image: 'candidate-web:release', service, revision: REVISION }, { root: REPO, exec: world.exec, newName: () => 'phase029-imgverify-test' }), calls: world.calls };
};
test('image verification: a correct image passes every check, the container is created stopped without network and removed by id', () => {
  const result = verifyWith({}); // trees are compared with the pinned hashes: the fake trees differ, so only those two checks are expected to fail
  const failed = result.checks.filter(check => !check.pass).map(check => check.id).sort();
  assert.deepEqual(failed, ['client-tree', 'migration-chain-tree'], JSON.stringify(failed));
  assert.ok(result.checks.find(check => check.id === 'container-removed').pass);
  const create = result.calls.find(call => call.args[0] === 'create');
  assert.ok(create.args.includes('--network') && create.args[create.args.indexOf('--network') + 1] === 'none'); assert.ok(!result.calls.some(call => call.command === 'docker' && ['start', 'run', 'exec'].includes(call.args[0])), 'the image is never started');
  assert.equal(PINNED.migrationsTreeSha256, 'f0da8710b3c874f842de6b686ae5b025dffd59f8acdab74a6e1c00faadb54ca8');
  assert.ok(SERVICE_SOURCE.web.includes('apps/web/src/lib/datasets/modality.ts') && SERVICE_SOURCE.worker.includes('apps/worker/src/jobs/repository-asset-upsert.ts'));
});
const IMAGE_FAILURES = {
  'wrong revision label': [{ labelRevision: 'a'.repeat(40) }, 'label-revision'],
  'wrong service label': [{ labelService: 'worker' }, 'label-service'],
  'startup runs a migration': [{ cmd: ['sh', '-c', 'pnpm exec prisma migrate deploy && next start'] }, 'startup-no-migration-or-seed'],
  'startup seeds': [{ cmd: ['pnpm', 'db:seed'] }, 'startup-no-migration-or-seed'],
  'health check migrates': [{ healthcheck: { Test: ['CMD-SHELL', 'prisma migrate status'] } }, 'startup-no-migration-or-seed'],
  'baked credentialed URL': [{ env: ['DATABASE_URL=postgresql://user:pw@db:5432/x'] }, 'env-no-credentialed-url'],
  'baked secret value': [{ env: ['MINIO_SECRET_KEY=abc'] }, 'env-no-secret-values'],
  'Dataset lacks the modality fields': [{ datasetText: 'id name' }, 'client-dataset-modality-fields'],
  'PreparedImport lacks creationRequestHash': [{ preparedText: 'id' }, 'client-prepared-import-creation-request-hash'],
  'schema differs from the revision': [{ gitContent: { 'prisma/schema.prisma': 'another schema' } }, 'source:prisma/schema.prisma'],
  'M24 differs from the revision': [{ gitContent: { [`prisma/migrations/${PINNED.m24}/migration.sql`]: 'other' } }, `source:prisma/migrations/${PINNED.m24}/migration.sql`],
  'queue contract differs': [{ gitContent: { 'packages/queue/src/job-contract.ts': 'other' } }, 'source:packages/queue/src/job-contract.ts'],
  'a key file is missing in the image': [{ absentInImage: ['apps/web/src/lib/datasets/modality.ts'] }, 'source:apps/web/src/lib/datasets/modality.ts'],
  'an environment file is in the image': [{ envFilePresent: '.env' }, 'env-file-absent:.env'],
  'an environment file elsewhere in the filesystem': [{ envFilesInFilesystem: 'workspace/apps/web/.env.local\n' }, 'env-files-none-in-filesystem'],
  'the web build is missing': [{ absentInImage: ['apps/web/.next/BUILD_ID'] }, 'web-build-present'],
};
for (const [label, [options, expected]] of Object.entries(IMAGE_FAILURES)) test(`image verification fails (${label}) on ${expected}`, () => {
  const result = verifyWith(options);
  assert.equal(result.ok, false); assert.ok(result.checks.some(check => check.id === expected && !check.pass), `${label}: ${JSON.stringify(result.checks.filter(check => !check.pass).map(check => check.id))}`);
  assert.ok(result.checks.find(check => check.id === 'container-removed').pass, 'the verification container is always removed');
});
test('image verification: bad arguments, a missing image and a failed create are refused without side effects', () => {
  const world = fakeImageWorld({});
  for (const args of [{ image: '', service: 'web', revision: REVISION }, { image: 'x', service: 'realtime', revision: REVISION }, { image: 'x', service: 'web', revision: 'short' }, { image: 'a; rm -rf /', service: 'web', revision: REVISION }]) assert.equal(verifyImage(args, { root: REPO, exec: world.exec, newName: () => 'n' }).ok, false);
  assert.equal(world.calls.length, 0);
  assert.equal(verifyWith({ missingImage: true }).ok, false);
  const failed = verifyWith({ createFails: true }); assert.equal(failed.ok, false); assert.ok(!failed.calls.some(call => call.args[0] === 'cp'));
  const source = readSource('release-image-verify.mjs');
  assert.doesNotMatch(source, /'(start|run|exec|build|push|pull|tag|rmi|prune|stop|kill)'/);
});
