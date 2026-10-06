// Fresh READ-ONLY inventory for the Phase029 maintenance window. Run it immediately before authorization/execution (and again after each step).
//
//   node scripts/db-safety/backfill-window-inventory.mjs <out.json> [--baseline <window-baseline.json>] [--mode preflight|drained] [--expect-history 23|24|25]
//                                                                  [--skip-candidates] [--allow-container-change web,worker] [--write-baseline <path>]
//
// It reads: container/image identities (docker inspect), PostgreSQL through the container's own client in a READ ONLY transaction (system identifier, migration
// history, the reviewed schema manifest, counts, sessions, locks, prepared transactions, non-terminal jobs, PREPARING imports, the DB-only T029 candidate set) and
// Redis/BullMQ queue state (LLEN/ZCARD/GET/EXISTS/SCAN-free key probes only). It never writes, never stops or starts anything, never touches an object store, and needs
// no database or Redis password on the command line or in the environment (the clients run inside the containers, which already hold their own settings).
// Any material drift from the accepted baseline is a HARD STOP: the window must not open until a human has reviewed it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson, historyDigest, manifestDigest, manifestSql, must, sha256 } from './backfill-binding.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
export const INVENTORY_SCHEMA = 'phase029-window-inventory/v1';
export const BASELINE_SCHEMA = 'phase029-window-baseline/v1';
export const CONTAINERS = Object.freeze({ postgres: 'annotationplatformdev-postgres-1', redis: 'annotationplatformdev-redis-1', minio: 'annotationplatformdev-minio-1', web: 'annotationplatformdev-web-1', worker: 'annotationplatformdev-worker-1', realtime: 'annotationplatformdev-realtime-1' });
export const NON_TERMINAL = ['QUEUED', 'RUNNING', 'RETRYING', 'CANCELING'];
const SAFE = /^[A-Za-z0-9_.:-]{1,128}$/;

const realExec = (command, args, input) => {
  try { return { status: 0, stdout: execFileSync(command, args, { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }), stderr: '' }; }
  catch (error) { return { status: error.status ?? 1, stdout: error.stdout?.toString() ?? '', stderr: error.stderr?.toString() ?? '' }; }
};

/** DB-only T029 eligibility (the same rules as the reviewed classifier, evaluated in SQL over Asset/subtype/storage evidence; no object read). Authoritative candidates come from `observe`. */
export const candidateSql = bucket => {
  must(/^[a-z0-9][a-z0-9.-]{1,61}$/.test(bucket), 'BUCKET_NAME_INVALID');
  return `SELECT coalesce(json_agg(d.id ORDER BY d.id),'[]'::json) FROM "Dataset" d WHERE d."deletedAt" IS NULL AND d."archivedAt" IS NULL AND (to_jsonb(d)->>'modality') IS NULL
    AND EXISTS (SELECT 1 FROM "Asset" a0 WHERE a0."datasetId"=d.id)
    AND (SELECT count(DISTINCT a.modality) FROM "Asset" a WHERE a."datasetId"=d.id)=1
    AND NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."datasetId"=d.id AND j.status IN ('QUEUED','RUNNING','RETRYING','CANCELING'))
    AND NOT EXISTS (SELECT 1 FROM "PreparedImport" p WHERE p."datasetId"=d.id AND p.status='PREPARING')
    AND NOT EXISTS (SELECT 1 FROM "Asset" a WHERE a."datasetId"=d.id AND (a."deletedAt" IS NOT NULL
      OR a."storageProvider" IS DISTINCT FROM 'MINIO' OR a."storageBucket" IS DISTINCT FROM '${bucket}' OR a."storageKey" IS NULL OR a."sizeBytes" IS NULL
      OR (CASE WHEN (SELECT (CASE WHEN EXISTS(SELECT 1 FROM "ImageAsset" x WHERE x."assetId"=a.id) THEN 1 ELSE 0 END)+(CASE WHEN EXISTS(SELECT 1 FROM "VideoAsset" x WHERE x."assetId"=a.id) THEN 1 ELSE 0 END)+(CASE WHEN EXISTS(SELECT 1 FROM "AudioAsset" x WHERE x."assetId"=a.id) THEN 1 ELSE 0 END)+(CASE WHEN EXISTS(SELECT 1 FROM "TextAsset" x WHERE x."assetId"=a.id) THEN 1 ELSE 0 END))=1
          THEN NOT (CASE a.modality WHEN 'IMAGE' THEN EXISTS(SELECT 1 FROM "ImageAsset" x WHERE x."assetId"=a.id) WHEN 'VIDEO' THEN EXISTS(SELECT 1 FROM "VideoAsset" x WHERE x."assetId"=a.id) WHEN 'AUDIO' THEN EXISTS(SELECT 1 FROM "AudioAsset" x WHERE x."assetId"=a.id) ELSE EXISTS(SELECT 1 FROM "TextAsset" x WHERE x."assetId"=a.id) END)
          ELSE TRUE END)));`.replace(/\s+/g, ' ');
};

export function collectInventory(deps) {
  const exec = deps.exec ?? realExec;
  const docker = (...args) => { const r = exec('docker', args); must(r.status === 0, 'DOCKER_READ_FAILED'); return r.stdout; };
  const out = { schema: INVENTORY_SCHEMA, generatedAt: new Date(deps.now()).toISOString(), readOnly: true };

  // ---- services: container / image identities
  out.containers = {};
  for (const [role, name] of Object.entries(CONTAINERS)) {
    const info = JSON.parse(docker('inspect', name))[0];
    out.containers[role] = { name, id: info.Id, image: info.Image, imageName: info.Config.Image, state: info.State.Status, running: info.State.Running, startedAt: info.State.StartedAt, restartCount: info.RestartCount, health: info.State.Health?.Status ?? null };
  }
  const envOf = (role, key) => { const r = exec('docker', ['exec', CONTAINERS[role], 'printenv', key]); return r.status === 0 ? r.stdout.trim() : null; };
  const pgUser = envOf('postgres', 'POSTGRES_USER'), pgDb = envOf('postgres', 'POSTGRES_DB');
  must(pgUser && pgDb && SAFE.test(pgUser) && SAFE.test(pgDb), 'POSTGRES_SETTINGS_UNREADABLE');
  const bucket = envOf('worker', 'MINIO_BUCKET');
  must(bucket, 'WORKER_BUCKET_UNREADABLE');

  // ---- PostgreSQL: one READ ONLY transaction, every statement yields one single-line JSON value
  const statements = [
    `SELECT json_build_object('systemIdentifier',system_identifier::text,'database',current_database(),'user',current_user,'serverVersion',current_setting('server_version')) FROM pg_control_system();`,
    `SELECT coalesce(json_agg(json_build_object('name',migration_name,'checksum',checksum,'finished',finished_at IS NOT NULL,'rolledBack',rolled_back_at IS NOT NULL) ORDER BY started_at, migration_name),'[]'::json) FROM public._prisma_migrations;`,
    manifestSql(deps.root ?? ROOT),
    `SELECT json_build_object('datasets',(SELECT count(*) FROM "Dataset"),'datasetsLive',(SELECT count(*) FROM "Dataset" WHERE "deletedAt" IS NULL AND "archivedAt" IS NULL),'datasetsUnresolved',(SELECT count(*) FROM "Dataset" x WHERE (to_jsonb(x)->>'modality') IS NULL),'assets',(SELECT count(*) FROM "Asset"),'annotations',(SELECT count(*) FROM "Annotation"),'jobs',(SELECT count(*) FROM "Job"),'importsByStatus',(SELECT coalesce(json_object_agg(status,n),'{}'::json) FROM (SELECT status::text AS status, count(*) AS n FROM "PreparedImport" GROUP BY 1) t));`,
    `SELECT coalesce(json_agg(json_build_object('id',id,'type',type::text,'status',status::text) ORDER BY id),'[]'::json) FROM "Job" WHERE status IN (${NON_TERMINAL.map(s => `'${s}'`).join(',')});`,
    `SELECT coalesce(json_agg(id ORDER BY id),'[]'::json) FROM "PreparedImport" WHERE status='PREPARING';`,
    `SELECT json_build_object('clientSessions',(SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid() AND datname=current_database()),'idleInTransaction',(SELECT count(*) FROM pg_stat_activity WHERE state LIKE 'idle in transaction%' AND pid<>pg_backend_pid()),'activeQueries',(SELECT count(*) FROM pg_stat_activity WHERE state='active' AND pid<>pg_backend_pid() AND backend_type='client backend'),'longestTransactionSeconds',(SELECT coalesce(max(extract(epoch FROM now()-xact_start))::int,0) FROM pg_stat_activity WHERE xact_start IS NOT NULL AND pid<>pg_backend_pid() AND backend_type='client backend'),'byApplication',(SELECT coalesce(json_object_agg(a,n),'{}'::json) FROM (SELECT coalesce(nullif(application_name,''),'(none)') AS a, count(*) AS n FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid() GROUP BY 1) t));`,
    `SELECT json_build_object('ungrantedLocks',(SELECT count(*) FROM pg_locks WHERE NOT granted),'preparedTransactions',(SELECT count(*) FROM pg_prepared_xacts),'accessExclusiveOnAppTables',(SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE c.relname IN ('Dataset','Asset') AND l.mode='AccessExclusiveLock' AND l.pid<>pg_backend_pid()));`,
    candidateSql(bucket),
  ];
  const input = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${statements.join('\n')}\nROLLBACK;\n`;
  const psql = exec('docker', ['exec', '-i', '-e', 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=5000', CONTAINERS.postgres, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', pgUser, '-d', pgDb], input);
  must(psql.status === 0, 'DATABASE_READ_FAILED');
  const lines = psql.stdout.trim().split('\n');
  must(lines.length === statements.length, 'DATABASE_READ_INCOMPLETE');
  const [identity, history, manifest, counts, jobs, imports, sessions, locks, candidates] = lines.map(line => JSON.parse(line));
  out.postgres = {
    ...identity, history, historySha256: historyDigest(history), schemaEntries: manifest.length, schemaManifestSha256: manifestDigest(manifest), counts, nonTerminalJobs: jobs, preparingImports: imports, sessions, locks, dbOnlyCandidates: candidates,
    bucket,
  };

  // ---- Redis / BullMQ (read commands only; the password stays inside the container)
  const prefix = envOf('worker', 'BULLMQ_PREFIX'), redisDb = envOf('worker', 'REDIS_DB') ?? '0';
  must(prefix && SAFE.test(prefix) && /^\d+$/.test(redisDb), 'REDIS_SETTINGS_UNREADABLE');
  const queue = `${prefix}:fieldframe-jobs`;
  const probes = ['LLEN wait', 'LLEN active', 'LLEN paused', 'ZCARD delayed', 'ZCARD prioritized', 'ZCARD waiting-children', 'ZCARD failed', 'ZCARD completed'];
  const jobIds = jobs.map(job => job.id);
  must(jobIds.every(id => SAFE.test(id)), 'JOB_ID_UNSAFE');
  const script = [
    'export REDISCLI_AUTH="$REDIS_PASSWORD"', `R="redis-cli -n ${redisDb}"`, `Q="${queue}"`,
    ...probes.map(probe => `echo "${probe.replace(' ', ':')}=$($R ${probe.split(' ')[0]} $Q:${probe.split(' ')[1]})"`),
    ...jobIds.map(id => `echo "job:${id}=exists:$($R EXISTS $Q:${id}) completed:$($R ZSCORE $Q:completed ${id})"`),
  ].join('\n');
  const redis = exec('docker', ['exec', '-i', CONTAINERS.redis, 'sh', '-s'], script);
  must(redis.status === 0, 'REDIS_READ_FAILED');
  const fields = Object.fromEntries(redis.stdout.trim().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
  const num = key => { must(/^\d+$/.test(fields[key] ?? ''), 'REDIS_PROBE_INVALID'); return Number(fields[key]); };
  out.redis = {
    queue, db: Number(redisDb),
    sets: { wait: num('LLEN:wait'), active: num('LLEN:active'), paused: num('LLEN:paused'), delayed: num('ZCARD:delayed'), prioritized: num('ZCARD:prioritized'), waitingChildren: num('ZCARD:waiting-children') },
    history: { failed: num('ZCARD:failed'), completed: num('ZCARD:completed') },
    nonTerminalJobKeys: Object.fromEntries(jobIds.map(id => { const [exists, completed] = fields[`job:${id}`].replace('exists:', '').split(' completed:'); return [id, { exists: exists === '1', completed: completed !== '' }]; })),
  };
  return out;
}

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const jobKey = job => `${job.id}|${job.type}|${job.status}`;
/** HARD STOPS decide whether the window may open; everything else is informational. A material difference from the accepted baseline is always a stop. */
export function evaluate(inventory, baseline, options = {}) {
  const { mode = 'preflight', expectHistory = 23, skipCandidates = false, allowContainerChange = [] } = options;
  const stops = [], info = [];
  const stop = (id, detail) => stops.push({ id, detail });
  must(baseline?.schema === BASELINE_SCHEMA, 'BASELINE_INVALID');
  const pg = inventory.postgres;
  if (pg.systemIdentifier !== baseline.postgres.systemIdentifier) stop('HS-01-SYSTEM-IDENTIFIER', 'the database is not the one the baseline accepted');
  if (pg.database !== baseline.postgres.database) stop('HS-01-DATABASE-NAME', pg.database);
  if (pg.history.length !== expectHistory) stop('HS-02-HISTORY-COUNT', `${pg.history.length} migrations, expected ${expectHistory}`);
  else if (historyDigest(pg.history.slice(0, 23)) !== baseline.history23.sha256 && !(expectHistory === 23 && pg.historySha256 === baseline.history23.sha256)) stop('HS-02-HISTORY-DRIFT', 'the first 23 migration records differ from the baseline');
  if (pg.history.some(row => !row.finished || row.rolledBack)) stop('HS-02-HISTORY-INCOMPLETE', 'an unfinished or rolled-back migration record exists');
  const entries = { 23: baseline.schema1829.entries, 24: 1841, 25: 1842 }[expectHistory];
  if (pg.schemaEntries !== entries) stop('HS-03-SCHEMA-ENTRIES', `${pg.schemaEntries} entries, expected ${entries}`);
  if (expectHistory === 23 && pg.schemaManifestSha256 !== baseline.schema1829.sha256) stop('HS-03-SCHEMA-DRIFT', 'the schema manifest differs from the accepted 23-migration fingerprint');
  if (expectHistory > 23) info.push({ id: 'SCHEMA-FINGERPRINT-FOR-AUTHORIZATION', detail: pg.schemaManifestSha256 });
  if (!sameSet(pg.nonTerminalJobs.map(jobKey), baseline.nonTerminalJobs.map(jobKey))) stop('HS-04-NON-TERMINAL-JOBS', 'the set of non-terminal jobs changed');
  if (!sameSet(pg.preparingImports, baseline.preparingImports)) stop('HS-05-PREPARING-IMPORTS', 'the set of PREPARING imports changed');
  if (!skipCandidates && !sameSet(pg.dbOnlyCandidates, baseline.dbOnlyCandidates)) stop('HS-06-CANDIDATE-SET', `DB-only candidate set differs (now ${pg.dbOnlyCandidates.length}, baseline ${baseline.dbOnlyCandidates.length})`);
  for (const [role, accepted] of Object.entries(baseline.containers)) {
    const now = inventory.containers[role];
    if (allowContainerChange.includes(role)) { info.push({ id: `CONTAINER-CHANGE-ALLOWED-${role}`, detail: `${now?.id}/${now?.image}` }); continue; }
    if (!now || now.id !== accepted.id || now.image !== accepted.image) stop(`HS-07-CONTAINER-${role.toUpperCase()}`, `${role} is not the accepted container/image`);
  }
  const sets = inventory.redis.sets;
  if (Object.values(sets).some(value => value !== 0)) stop('HS-08-QUEUE-NOT-EMPTY', JSON.stringify(sets));
  for (const [id, state] of Object.entries(inventory.redis.nonTerminalJobKeys)) { const accepted = baseline.redis.nonTerminalJobKeys[id]; if (!accepted || accepted.exists !== state.exists || accepted.completed !== state.completed) stop('HS-08-JOB-QUEUE-STATE', id); }
  const { sessions, locks } = pg;
  if (locks.preparedTransactions > 0) stop('HS-09-PREPARED-TRANSACTIONS', String(locks.preparedTransactions));
  if (locks.ungrantedLocks > 0) stop('HS-09-UNGRANTED-LOCKS', String(locks.ungrantedLocks));
  if (sessions.idleInTransaction > 0) stop('HS-09-IDLE-IN-TRANSACTION', String(sessions.idleInTransaction));
  if (mode === 'drained') {
    if (sessions.clientSessions > 0) stop('HS-10-NOT-DRAINED-SESSIONS', JSON.stringify(sessions.byApplication));
    if (sessions.activeQueries > 0) stop('HS-10-ACTIVE-QUERIES', String(sessions.activeQueries));
    if (locks.accessExclusiveOnAppTables > 0) stop('HS-10-EXCLUSIVE-LOCKS', String(locks.accessExclusiveOnAppTables));
    for (const role of ['web', 'worker']) if (inventory.containers[role].running) stop(`HS-10-${role.toUpperCase()}-RUNNING`, `${role} must be stopped for a drained window`);
  }
  info.push({ id: 'COUNTS', detail: pg.counts }, { id: 'SESSIONS', detail: sessions }, { id: 'REDIS-HISTORY', detail: inventory.redis.history });
  for (const key of ['datasets', 'datasetsLive', 'assets', 'annotations', 'jobs']) if (pg.counts[key] !== baseline.counts[key]) info.push({ id: `DRIFT-${key.toUpperCase()}`, detail: `${baseline.counts[key]} -> ${pg.counts[key]}` });
  return { status: stops.length === 0 ? 'GO' : 'STOP', mode, expectHistory, hardStops: stops, informational: info };
}

/** The accepted assumptions, derived from one inventory taken with 23 migrations. A human reviews and accepts this file; it is not secret. */
export function baselineFrom(inventory) {
  must(inventory.postgres.history.length === 23 && inventory.postgres.schemaEntries === 1829, 'BASELINE_REQUIRES_23_MIGRATIONS');
  return {
    schema: BASELINE_SCHEMA, derivedFrom: inventory.generatedAt, status: 'ACCEPTED_BY_RELEASE_OWNER_PENDING',
    postgres: { systemIdentifier: inventory.postgres.systemIdentifier, database: inventory.postgres.database },
    history23: { count: 23, sha256: inventory.postgres.historySha256 },
    schema1829: { entries: inventory.postgres.schemaEntries, sha256: inventory.postgres.schemaManifestSha256 },
    nonTerminalJobs: inventory.postgres.nonTerminalJobs, preparingImports: inventory.postgres.preparingImports, dbOnlyCandidates: inventory.postgres.dbOnlyCandidates,
    containers: Object.fromEntries(Object.entries(inventory.containers).map(([role, c]) => [role, { name: c.name, id: c.id, image: c.image, imageName: c.imageName }])),
    redis: { queue: inventory.redis.queue, nonTerminalJobKeys: inventory.redis.nonTerminalJobKeys },
    counts: inventory.postgres.counts,
  };
}

function parseArgs(argv) {
  const [out, ...rest] = argv; must(out && !out.startsWith('--'), 'USAGE_OUTPUT_PATH_REQUIRED');
  const options = { mode: 'preflight', expectHistory: 23, skipCandidates: false, allowContainerChange: [], baseline: null, writeBaseline: null };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--skip-candidates') options.skipCandidates = true;
    else if (['--baseline', '--mode', '--expect-history', '--allow-container-change', '--write-baseline'].includes(flag)) { const value = rest[++index]; must(value, 'USAGE_FLAG_VALUE_REQUIRED'); if (flag === '--baseline') options.baseline = value; else if (flag === '--mode') options.mode = value; else if (flag === '--expect-history') options.expectHistory = Number(value); else if (flag === '--write-baseline') options.writeBaseline = value; else options.allowContainerChange = value.split(','); }
    else throw Error('USAGE_UNKNOWN_FLAG');
  }
  must(['preflight', 'drained'].includes(options.mode) && [23, 24, 25].includes(options.expectHistory) && options.allowContainerChange.every(role => Object.hasOwn(CONTAINERS, role)), 'USAGE_VALUE_INVALID');
  return { out: resolve(out), options };
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  try {
    const { out, options } = parseArgs(process.argv.slice(2));
    must(!existsSync(out), 'OUTPUT_EXISTS');
    const inventory = collectInventory({ now: () => Date.now(), root: ROOT });
    const verdict = options.baseline ? evaluate(inventory, JSON.parse(readFileSync(resolve(options.baseline), 'utf8')), options) : { status: 'NO_BASELINE', hardStops: [], informational: [] };
    const document = { ...inventory, verdict };
    writeFileSync(out, JSON.stringify(document, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (options.writeBaseline) { must(!existsSync(resolve(options.writeBaseline)), 'OUTPUT_EXISTS'); writeFileSync(resolve(options.writeBaseline), JSON.stringify(baselineFrom(inventory), null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
    console.log(JSON.stringify({ status: verdict.status, hardStops: verdict.hardStops, inventorySha256: sha256(canonicalJson(inventory)), out }));
    process.exitCode = verdict.status === 'STOP' ? 2 : 0;
  } catch (error) { console.error('INVENTORY_ABORT', /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'INVENTORY_FAILURE'); process.exitCode = 1; }
}
