// Verified logical backup for the Phase029 maintenance window:
//   pg_dump -Fc  ->  SHA-256  ->  pg_restore --list  ->  an ACTUAL restore into a fresh, isolated PostgreSQL container  ->  compare
//   migration history + schema + every table's row fingerprint + sequences with the source  ->  prove the comparison can fail  ->  remove the restore container.
//
//   node scripts/db-safety/backup-proof.mjs <request.json>
//
// The source is only ever read: `docker inspect`, `pg_controldata`, `psql` in a READ ONLY transaction and `pg_dump` run inside the pinned container through its own
// local client (no password is needed or used). The restore target is a new container created from the SOURCE's own image id (same PostgreSQL version), with no network,
// no published port and a random in-memory password; it is removed at the end (exactly that container, after its labels are re-checked). Evidence is a read-only dump
// plus an immutable receipt. A backup is "verified" only when every comparison passes; any deviation seals a FAILED receipt and leaves the source untouched.
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve, sep } from 'node:path';

export const REQUEST_SCHEMA = 'phase029-backup-proof-request/v1';
export const RECEIPT_SCHEMA = 'phase029-backup-proof-receipt/v1';
const ROOT = resolve(import.meta.dirname, '../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const must = (value, code) => { if (!value) throw Error(code); };
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/;
const TOKEN = /^[a-z0-9][a-z0-9-]{6,62}[a-z0-9]$/;
const canonical = value => JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));

/** Allowed locations for the dump (it holds user data): never inside tracked source. */
export const backupRoots = root => [join(root, '.data/backups'), join(root, 'specs/029-modality-specific-datasets/verification/maintenance-runs')].map(path => resolve(path));

export function validateRequest(raw, now = Date.now()) {
  const only = (object, keys, code) => must(object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(key => keys.includes(key)), code);
  only(raw, ['schema', 'runToken', 'issuedAt', 'expiresAt', 'source', 'backupDir', 'negativeControls', 'requireDrained'], 'REQUEST_SHAPE_INVALID');
  must(raw.schema === REQUEST_SCHEMA && TOKEN.test(raw.runToken ?? ''), 'REQUEST_INVALID');
  const issued = Date.parse(raw.issuedAt), expiry = Date.parse(raw.expiresAt);
  must(Number.isFinite(issued) && Number.isFinite(expiry) && issued <= now && now < expiry && expiry - issued <= 4 * 3600 * 1000, 'REQUEST_EXPIRED_OR_UNBOUNDED');
  only(raw.source, ['container', 'id', 'user', 'database', 'expectedSystemIdentifier'], 'REQUEST_SOURCE_INVALID');
  must(SAFE_NAME.test(raw.source.container ?? '') && /^[a-f0-9]{64}$/.test(raw.source.id ?? '') && SAFE_NAME.test(raw.source.user ?? '') && SAFE_NAME.test(raw.source.database ?? '') && /^\d{10,25}$/.test(raw.source.expectedSystemIdentifier ?? ''), 'REQUEST_SOURCE_INVALID');
  must(typeof raw.backupDir === 'string' && raw.backupDir.startsWith('/'), 'REQUEST_BACKUP_DIR_INVALID');
  must(typeof raw.negativeControls === 'boolean' && typeof raw.requireDrained === 'boolean', 'REQUEST_INVALID');
  return raw;
}

const realExec = (command, args, options = {}) => {
  const result = spawnSync(command, args, { input: options.input, env: options.env ?? { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: options.timeoutMs ?? 30 * 60 * 1000 });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};
const realDumpToFile = (args, filePath) => {
  const fd = openSync(filePath, 'wx', 0o600);
  try {
    const result = spawnSync('docker', args, { stdio: ['ignore', fd, 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeout: 60 * 60 * 1000, encoding: 'utf8' });
    return { status: result.status ?? 1, stderr: result.stderr ?? '' };
  } finally { closeSync(fd); }
};
export const realDeps = () => ({ root: ROOT, now: () => Date.now(), exec: realExec, dumpToFile: realDumpToFile, newSecret: () => randomBytes(24).toString('hex'), sleep: ms => new Promise(done => setTimeout(done, ms)) });

const tableSql = names => names.map(name => `SELECT json_build_array('${name}', count(*), md5(coalesce(string_agg(h,'' ORDER BY h),''))) FROM (SELECT md5(to_jsonb(x)::text) AS h FROM public."${name}" x) t;`);

/** One read-only observation of a database through the container's own client: history, tables, sequences. */
export function observe(deps, container, user, database) {
  const psql = statements => {
    const r = deps.exec('docker', ['exec', '-i', '-e', 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=600000', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database], { input: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${statements.join('\n')}\nROLLBACK;\n` });
    must(r.status === 0, 'OBSERVATION_FAILED');
    const lines = r.stdout.trim().split('\n');
    must(lines.length === statements.length, 'OBSERVATION_INCOMPLETE');
    return lines.map(line => JSON.parse(line));
  };
  const [identity, history, tables, sequences] = psql([
    `SELECT json_build_object('database',current_database(),'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()));`,
    `SELECT coalesce(json_agg(json_build_object('name',migration_name,'checksum',checksum,'finished',finished_at IS NOT NULL,'rolledBack',rolled_back_at IS NOT NULL) ORDER BY started_at, migration_name),'[]'::json) FROM public._prisma_migrations;`,
    `SELECT coalesce(json_agg(tablename ORDER BY tablename),'[]'::json) FROM pg_tables WHERE schemaname='public';`,
    `SELECT coalesce(json_agg(json_build_array(schemaname||'.'||sequencename, last_value) ORDER BY schemaname, sequencename),'[]'::json) FROM pg_sequences;`,
  ]);
  must(tables.every(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)), 'TABLE_NAME_UNSAFE');
  const fingerprints = psql(tableSql(tables));
  const dump = deps.exec('docker', ['exec', container, 'pg_dump', '-U', user, '-d', database, '--schema-only', '--no-owner', '--no-acl', '--schema=public', '--no-password'], { timeoutMs: 10 * 60 * 1000 });
  must(dump.status === 0, 'SCHEMA_DUMP_FAILED');
  const schemaSha256 = sha(dump.stdout.split('\n').filter(line => !/^\\(?:un)?restrict /.test(line)).join('\n'));
  return { identity, history, historySha256: sha(canonical(history)), tables: fingerprints, tablesSha256: sha(canonical(fingerprints)), sequences, sequencesSha256: sha(canonical(sequences)), schemaSha256 };
}

export function compare(source, restored) {
  must(canonical(source.history) === canonical(restored.history) && source.history.length > 0, 'RESTORE_HISTORY_MISMATCH');
  must(source.schemaSha256 === restored.schemaSha256, 'RESTORE_SCHEMA_MISMATCH');
  must(canonical(source.tables.map(row => row[0])) === canonical(restored.tables.map(row => row[0])), 'RESTORE_TABLE_SET_MISMATCH');
  for (let index = 0; index < source.tables.length; index += 1) must(source.tables[index][1] === restored.tables[index][1] && source.tables[index][2] === restored.tables[index][2], 'RESTORE_TABLE_DATA_MISMATCH');
  must(canonical(source.sequences) === canonical(restored.sequences), 'RESTORE_SEQUENCE_MISMATCH');
}

function prepareBackupDir(path, roots) {
  const parent = realpathSync(dirname(path)), target = join(parent, basename(path));
  const allowed = roots.map(root => { try { return realpathSync(root); } catch { return null; } }).filter(Boolean);
  must(allowed.some(root => target.startsWith(root + sep)), 'BACKUP_DIR_OUTSIDE_ALLOWED_ROOT');
  if (existsSync(target)) { const stat = lstatSync(target); must(stat.isDirectory() && !stat.isSymbolicLink() && readdirSync(target).length === 0, 'BACKUP_DIR_NOT_EMPTY'); } else mkdirSync(target, { mode: 0o700 });
  const stat = statSync(target);
  must((stat.mode & 0o077) === 0 && stat.uid === process.getuid(), 'BACKUP_DIR_NOT_PRIVATE');
  return realpathSync(target);
}

/** Returns { ok, code, receipt, dir }. Never throws; the restore container is always removed; the source is never written. */
export async function runBackupProof(requestPath, deps = realDeps()) {
  let restoreId = null, restoreName = null, dir = null;
  const result = { ok: false, code: 'BACKUP_PROOF_FAILED' };
  const startedAt = new Date(deps.now()).toISOString();
  try {
    const requestBytes = readFileSync(realpathSync(requestPath));
    const request = validateRequest(JSON.parse(requestBytes.toString('utf8')), deps.now());
    dir = prepareBackupDir(request.backupDir, deps.backupRoots?.() ?? backupRoots(deps.root));
    const { source } = request;
    const docker = (args, options) => { const r = deps.exec('docker', args, options); return r; };

    // 1. the source is the pinned container, running, and its own control file reports the expected system identifier
    const inspectResult = docker(['inspect', source.container]);
    must(inspectResult.status === 0, 'SOURCE_NOT_FOUND');
    const inspected = JSON.parse(inspectResult.stdout)[0];
    must(inspected.Id === source.id && inspected.State.Running, 'SOURCE_IDENTITY_MISMATCH');
    const control = docker(['exec', source.container, 'sh', '-c', 'LC_ALL=C pg_controldata "$PGDATA"']);
    must(control.status === 0 && control.stdout.match(/^Database system identifier:\s+(\d+)/m)?.[1] === source.expectedSystemIdentifier, 'SYSTEM_IDENTITY_MISMATCH');

    // 2. the source is quiet when a drained window is required (no client sessions, no open transactions, no prepared transactions)
    if (request.requireDrained) {
      const sessions = docker(['exec', '-i', source.container, 'psql', '-X', '-qAt', '-U', source.user, '-d', source.database, '-v', 'ON_ERROR_STOP=1'], { input: `SELECT (SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid() AND datname=current_database())||' '||(SELECT count(*) FROM pg_prepared_xacts);\n` });
      must(sessions.status === 0 && sessions.stdout.trim() === '0 0', 'SOURCE_NOT_DRAINED');
    }

    // 3. what the source looks like BEFORE the dump
    const before = observe(deps, source.container, source.user, source.database);
    must(before.identity.systemIdentifier === source.expectedSystemIdentifier && before.identity.database === source.database, 'SYSTEM_IDENTITY_MISMATCH');

    // 4. the logical dump, streamed to a private file, then sealed read-only with its checksum
    const dumpPath = join(dir, 'backup.dump');
    const dump = deps.dumpToFile(['exec', source.container, 'pg_dump', '-U', source.user, '-d', source.database, '-Fc', '--no-password'], dumpPath);
    must(dump.status === 0, 'DUMP_FAILED');
    chmodSync(dumpPath, 0o400);
    const dumpBytes = readFileSync(dumpPath);
    must(dumpBytes.length > 1024 && dumpBytes.subarray(0, 5).toString('latin1') === 'PGDMP', 'DUMP_INVALID');
    const dumpSha256 = sha(dumpBytes), dumpSize = dumpBytes.length;

    // 5. a fresh, isolated restore target made from the source's own image
    restoreName = `phase029-bk-${request.runToken}`;
    const password = deps.newSecret();
    must(docker(['inspect', restoreName]).status !== 0, 'RESTORE_CONTAINER_EXISTS');
    const run = docker(['run', '-d', '--name', restoreName, '--network', 'none', '--label', 'annotation.safety=backup-proof', '--label', `annotation.run=${request.runToken}`, '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=postgres', inspected.Image], { env: { PATH: process.env.PATH, HOME: process.env.HOME, POSTGRES_PASSWORD: password } });
    if (/^[a-f0-9]{64}$/.test(run.stdout.trim())) restoreId = run.stdout.trim();
    must(run.status === 0 && restoreId, 'RESTORE_CONTAINER_NOT_CREATED');
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) { ready = docker(['exec', restoreId, 'pg_isready', '-U', 'postgres']).status === 0; if (!ready) await deps.sleep(500); }
    must(ready, 'RESTORE_CONTAINER_NOT_READY');
    const restored = JSON.parse(docker(['inspect', restoreId]).stdout)[0];
    must(restored.Image === inspected.Image && restored.Config.Labels?.['annotation.safety'] === 'backup-proof', 'RESTORE_CONTAINER_UNEXPECTED');

    // 6. the dump must be readable by pg_restore --list
    must(docker(['cp', dumpPath, `${restoreId}:/tmp/backup.dump`]).status === 0, 'DUMP_COPY_FAILED');
    const list = docker(['exec', restoreId, 'pg_restore', '--list', '/tmp/backup.dump']);
    must(list.status === 0, 'DUMP_UNREADABLE');
    const entries = list.stdout.split('\n').filter(line => line && !line.startsWith(';')).length;
    must(entries > 0 && /TABLE DATA/.test(list.stdout), 'DUMP_LIST_EMPTY');
    writeFileSync(join(dir, 'backup.list'), list.stdout, { mode: 0o400, flag: 'wx' });

    // 7. an ACTUAL restore into a brand-new database, then the comparison
    must(docker(['exec', restoreId, 'createdb', '-U', 'postgres', source.database]).status === 0, 'RESTORE_DATABASE_NOT_CREATED');
    const restoreRun = docker(['exec', restoreId, 'pg_restore', '-U', 'postgres', '-d', source.database, '--no-owner', '--no-acl', '--exit-on-error', '/tmp/backup.dump'], { timeoutMs: 60 * 60 * 1000 });
    must(restoreRun.status === 0, 'RESTORE_FAILED');
    const after = observe(deps, restoreId, 'postgres', source.database);
    compare(before, after);
    // the source did not move while it was being dumped (read-only window): a second observation equals the first
    const sourceAgain = observe(deps, source.container, source.user, source.database);
    must(sourceAgain.historySha256 === before.historySha256 && sourceAgain.tablesSha256 === before.tablesSha256 && sourceAgain.schemaSha256 === before.schemaSha256, 'SOURCE_CHANGED_DURING_BACKUP');

    // 8. controls: the proof must be able to fail (a truncated dump is rejected; a tampered restored row is detected)
    let controls = null;
    if (request.negativeControls) {
      const truncated = docker(['exec', restoreId, 'sh', '-c', `head -c ${Math.floor(dumpSize / 2)} /tmp/backup.dump > /tmp/truncated.dump && pg_restore --list /tmp/truncated.dump >/dev/null`]);
      must(truncated.status !== 0, 'CONTROL_TRUNCATED_DUMP_ACCEPTED');
      const tamper = docker(['exec', '-i', restoreId, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', source.database, '-v', 'ON_ERROR_STOP=1'], { input: `UPDATE public._prisma_migrations SET checksum = 'tampered-control' WHERE ctid = (SELECT ctid FROM public._prisma_migrations LIMIT 1);\n` });
      must(tamper.status === 0, 'CONTROL_TAMPER_FAILED');
      let detected = false;
      try { compare(before, observe(deps, restoreId, 'postgres', source.database)); } catch (error) { detected = /^RESTORE_(HISTORY|TABLE_DATA)_MISMATCH$/.test(error.message); }
      must(detected, 'CONTROL_TAMPER_NOT_DETECTED');
      controls = { truncatedDumpRejected: true, tamperDetected: true };
    }

    const receipt = {
      schema: RECEIPT_SCHEMA, status: 'VERIFIED', startedAt, finishedAt: new Date(deps.now()).toISOString(), runToken: request.runToken, requestSha256: sha(requestBytes),
      source: { container: source.container, id: source.id, image: inspected.Image, systemIdentifier: source.expectedSystemIdentifier, database: source.database },
      restore: { image: restored.Image, networkMode: restored.HostConfig?.NetworkMode ?? 'none', removed: false },
      dump: { file: 'backup.dump', bytes: dumpSize, sha256: dumpSha256, listEntries: entries, listSha256: sha(list.stdout) },
      state: { migrationCount: before.history.length, historySha256: before.historySha256, schemaSha256: before.schemaSha256, tables: before.tables.length, tablesSha256: before.tablesSha256, sequencesSha256: before.sequencesSha256, rows: Object.fromEntries(before.tables.map(row => [row[0], row[1]])) },
      controls, requireDrained: request.requireDrained,
    };
    result.receipt = receipt; result.ok = true; result.code = 'VERIFIED';
  } catch (error) {
    result.code = /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'BACKUP_PROOF_FAILED';
  } finally {
    // The restore container is removed by its exact id after its labels are re-checked; the source is never touched.
    if (!restoreId && restoreName) {
      // a failed `docker run` may still have left a created container under our exact name: adopt it by id only if it carries our label
      const named = deps.exec('docker', ['inspect', restoreName]);
      try { const found = JSON.parse(named.stdout)[0]; if (named.status === 0 && /^[a-f0-9]{64}$/.test(found.Id)) restoreId = found.Id; } catch { /* nothing to adopt */ }
    }
    if (restoreId) {
      const info = deps.exec('docker', ['inspect', restoreId]);
      let owned = false;
      try { owned = info.status === 0 && JSON.parse(info.stdout)[0].Config.Labels?.['annotation.safety'] === 'backup-proof' && JSON.parse(info.stdout)[0].Id === restoreId; } catch { owned = false; }
      const removal = owned ? deps.exec('docker', ['rm', '-fv', restoreId]) : { status: 1 };
      result.restoreRemoved = removal.status === 0;
      if (result.receipt) result.receipt.restore.removed = result.restoreRemoved;
      if (!result.restoreRemoved) { result.ok = false; result.code = 'RESTORE_CONTAINER_NOT_REMOVED'; }
    }
    if (dir) {
      const receipt = result.receipt ?? { schema: RECEIPT_SCHEMA, status: 'FAILED', code: result.code, startedAt, finishedAt: new Date(deps.now()).toISOString(), dumpPresent: existsSync(join(dir, 'backup.dump')), restoreRemoved: restoreId ? result.restoreRemoved ?? false : null };
      if (!result.ok && receipt.status === 'VERIFIED') { receipt.status = 'FAILED'; receipt.code = result.code; }
      try { writeFileSync(join(dir, 'backup-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o400, flag: 'wx' }); } catch { /* an existing receipt is never overwritten */ }
      result.dir = dir; result.receipt = receipt;
    }
  }
  return result;
}

if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) {
  const [requestPath, ...rest] = process.argv.slice(2);
  if (!requestPath || rest.length) { console.error('BACKUP_PROOF_ABORT USAGE_REQUEST_ONLY'); process.exitCode = 2; }
  else {
    const result = await runBackupProof(requestPath);
    if (result.ok) console.log(JSON.stringify({ ok: true, status: 'VERIFIED', dir: result.dir, dump: result.receipt.dump, state: { migrationCount: result.receipt.state.migrationCount, tables: result.receipt.state.tables }, controls: result.receipt.controls }));
    else console.error('BACKUP_PROOF_ABORT', result.code);
    process.exitCode = result.ok ? 0 : 1;
  }
}
