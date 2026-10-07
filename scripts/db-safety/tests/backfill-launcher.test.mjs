import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runLauncher, SHARED_DEV_ENABLED } from '../backfill-launcher.mjs';
import {
  ADDED_BY, APPLICATION_SYSTEM, AUTHORIZATION_SCHEMA, CREDENTIALS_SCHEMA, FROZEN_MIGRATIONS, IMPLEMENTATION_FILES, OP_PROFILE, REQUEST_SCHEMA, assertMigrationDelta, assertNoAmbientTargets,
  computeImplementation, historyDigest, implementationDigest, loadCredentials, manifestDigest, manifestSql, sha256, storageConfigFingerprint, validateAuthorizationStatic, validateRequest,
} from '../backfill-binding.mjs';

// Offline: every probe, the target verification and the child process are injected. Nothing here touches Docker, PostgreSQL, a storage service or any real target.
const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const hex = text => createHash('sha256').update(text).digest('hex');
const SECRETS = { dbPassword: 's3cr3t-db-password', accessKey: 'AKIAFAKEACCESSKEY', secretKey: 'fake-storage-secret-key' };
const names = Array.from({ length: 23 }, (_, index) => `2026010${String(index).padStart(2, '0')}000000_m${index}`);
const fullHistory = () => [...names.map((name, index) => ({ name, checksum: hex(`m${index}`) })), { name: FROZEN_MIGRATIONS.m24.name, checksum: FROZEN_MIGRATIONS.m24.checksum }, { name: FROZEN_MIGRATIONS.m25.name, checksum: FROZEN_MIGRATIONS.m25.checksum }];
const history = count => fullHistory().slice(0, count);
const observedHistory = count => history(count).map(row => ({ ...row, finished: true, rolledBack: false }));
const implementation = () => ({ files: Object.fromEntries(IMPLEMENTATION_FILES.map(file => [file, hex(file)])), clientTreeSha256: hex('client'), migrationsTreeSha256: hex('chain') });
// schema manifest rows: 1829 baseline entries, +12 (M24), +1 (M25)
const baseRows = () => Array.from({ length: 1829 }, (_, index) => ['relation', JSON.stringify(['public', `t${index}`]), [index]]);
const m24Rows = () => [
  ...ADDED_BY['migrate-m24'].column.map(n => ['column', JSON.stringify(['public', 'Dataset', n]), ['x']]),
  ...ADDED_BY['migrate-m24'].constraint.map(n => ['constraint', JSON.stringify(['public', 'relation', '"Dataset"', n]), ['y']]),
  ...ADDED_BY['migrate-m24'].trigger.map(n => ['trigger', JSON.stringify(['public', 'Dataset', n]), ['z']]),
  ...ADDED_BY['migrate-m24'].routine.map(n => ['routine', JSON.stringify(['public', n]), ['f']]),
];
const m25Rows = () => [['column', JSON.stringify(['public', 'PreparedImport', 'creationRequestHash']), ['text']]];
const rowsFor = entries => (entries === 1829 ? baseRows() : entries === 1841 ? [...baseRows(), ...m24Rows()] : [...baseRows(), ...m24Rows(), ...m25Rows()]);
const TABLES = [['Asset', 3, hex('asset')], ['Dataset', 5, hex('dataset')], ['User', 1, hex('user')]];
const DATASETS = { total: 120, unresolved: 120, resolved: 0, live: 75 };
const observedState = (operation, systemIdentifier) => {
  const profile = OP_PROFILE[operation], rows = rowsFor(profile.entries);
  return { systemIdentifier, database: 'fieldframe', history: observedHistory(profile.history), manifestRows: rows, schemaEntries: rows.length, schemaManifestSha256: manifestDigest(rows), datasets: { ...DATASETS }, tables: TABLES.map(row => [...row]) };
};
const applyAfter = (state, operation, request) => {
  const next = operation === 'migrate-m24' ? 24 : 25;
  state.dbObserved = observedState('observe', request.postgres.expectedSystemIdentifier);
  state.dbObserved.history = observedHistory(next); state.dbObserved.manifestRows = rowsFor(OP_PROFILE[operation].after.entries);
  state.dbObserved.schemaEntries = state.dbObserved.manifestRows.length; state.dbObserved.schemaManifestSha256 = manifestDigest(state.dbObserved.manifestRows);
};

function setup({ kind = 'disposable', operation = 'observe', mutateRequest = r => r, sharedDevEnabled = false, mutateAuth = a => a, credentials = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bl-test-'));
  const evidenceRoot = join(dir, 'evidence-root'); mkdirSync(evidenceRoot, { mode: 0o700 });
  const profile = OP_PROFILE[operation];
  const bucket = kind === 'disposable' ? 'g1-abc' : 'annotation-assets';
  const manifests = {};
  if (profile.manifests) {
    const observed = JSON.stringify({ manifestSha256: hex('observed-manifest'), policy: { expectedBucket: bucket }, candidates: [] }), approved = JSON.stringify({ observedManifestSha256: hex('observed-manifest'), sha256: hex('approved') });
    for (const [name, text] of [['observed', observed], ['approved', approved]]) { const path = join(dir, `${name}.json`); writeFileSync(path, text, { mode: 0o600 }); manifests[`${name}Path`] = path; manifests[`${name}Sha256`] = sha256(text); }
  }
  const credDir = join(dir, 'private-credentials'); mkdirSync(credDir, { mode: 0o700 });
  const credPath = join(credDir, 'maintenance.credentials.json');
  const credRecord = { schema: CREDENTIALS_SCHEMA, postgresPassword: SECRETS.dbPassword, ...(profile.storage ? { storageAccessKey: SECRETS.accessKey, storageSecretKey: SECRETS.secretKey } : {}), ...credentials };
  const credText = JSON.stringify(credRecord); writeFileSync(credPath, credText, { mode: 0o600 });
  const systemId = kind === 'disposable' ? '7693216261455953954' : APPLICATION_SYSTEM;
  const evidenceDir = join(evidenceRoot, 'run-1');
  const request = {
    schema: REQUEST_SCHEMA, operation, targetKind: kind, requestId: randomUUID(), issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
    runToken: 'run-20261006-abcd', evidenceDir,
    postgres: { host: '127.0.0.1', port: kind === 'disposable' ? 55461 : 5433, database: 'fieldframe', user: kind === 'disposable' ? 'postgres' : 'fieldframe', expectedSystemIdentifier: systemId, expectedHistory: history(profile.history), expectedSchemaManifestSha256: manifestDigest(rowsFor(profile.entries)), expectedSchemaEntries: profile.entries },
    ...(profile.storage ? { storage: { endpoint: kind === 'disposable' ? 'http://127.0.0.1:55462' : 'http://localhost:9000', bucket, expectedEndpoint: kind === 'disposable' ? 'http://127.0.0.1:55462' : 'http://localhost:9000', expectedBucket: bucket } } : {}),
    credentials: { path: credPath, sha256: sha256(credText) }, implementation: implementation(), manifests,
    ...(kind === 'disposable' ? { disposablePins: { postgres: { port: 55461, name: 'phase029-g1-x' }, ...(profile.storage ? { minio: { port: 55462, name: 'phase029-g1-y' } } : {}) } }
      : { sharedDevPins: { postgres: { container: 'annotationplatformdev-postgres-1', id: 'a'.repeat(64) }, ...(profile.storage ? { minio: { container: 'annotationplatformdev-minio-1', id: 'b'.repeat(64) } } : {}) } }),
  };
  const state = { implementation: implementation(), dbObserved: observedState(operation, systemId), containerSystem: systemId, childStatus: 0, storage: null, implementationAfterRun: null, identityFailure: false, migrationStatus: 0, afterMutate: null };
  const storageIdentity = () => ({ endpointHost: new URL(request.storage.endpoint).hostname, endpointPort: Number(new URL(request.storage.endpoint).port), useSSL: false, bucket: request.storage.bucket, bucketExists: true, configFingerprint: storageConfigFingerprint(request, { ...credRecord }) });
  if (kind === 'shared-dev') {
    const auth = {
      schema: AUTHORIZATION_SCHEMA, operation, targetKind: 'shared-dev', runToken: request.runToken, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), authorizedBy: 'release owner', statement: 'offline test record',
      postgres: { systemIdentifier: systemId, database: 'fieldframe', migrationCount: profile.history, historySha256: historyDigest(state.dbObserved.history), schemaManifestSha256: state.dbObserved.schemaManifestSha256, schemaEntries: profile.entries, m24: FROZEN_MIGRATIONS.m24, m25: FROZEN_MIGRATIONS.m25 },
      implementationSha256: implementationDigest(implementation()),
      storage: profile.storage ? (({ endpointHost, endpointPort, useSSL, bucket: b, configFingerprint }) => ({ endpointHost, endpointPort, useSSL, bucket: b, configFingerprint }))(storageIdentity()) : null,
      manifests: { observedSha256: profile.manifests ? manifests.observedSha256 : null, approvedSha256: profile.manifests ? manifests.approvedSha256 : null },
      evidenceDir: join(evidenceRoot, 'run-1'),
    };
    const finalAuth = mutateAuth(auth) ?? auth;
    const text = JSON.stringify(finalAuth); const path = join(dir, 'authorization.json'); writeFileSync(path, text, { mode: 0o600 });
    request.authorization = { path, sha256: sha256(text) };
  }
  const final = mutateRequest(request) ?? request;
  const requestPath = join(dir, 'request.json'); writeFileSync(requestPath, JSON.stringify(final), { mode: 0o600 });
  const calls = { child: [], db: 0, target: 0, migrations: 0, order: [] };
  const deps = {
    root: REPO, now: () => Date.now(), sharedDevEnabled, evidenceRoots: () => [evidenceRoot],
    computeImplementation: () => (calls.order.includes('operation') && state.implementationAfterRun ? state.implementationAfterRun : state.implementation),
    loadCredentials: req => loadCredentials(req, REPO),
    verifyTarget: async () => { calls.target += 1; calls.order.push('target'); return { postgres: { container: 'c', id: 'i', systemIdentifier: state.containerSystem } }; },
    probeDatabase: () => { calls.db += 1; calls.order.push('db'); return structuredClone(state.dbObserved); },
    runMigration: () => { calls.migrations += 1; calls.order.push('operation'); state.afterMutate?.(state); return { status: state.migrationStatus, output: `Applying migration\nDatasource db at ${final.postgres.host}:${final.postgres.port}\n` }; },
    spawnChild: spec => {
      calls.child.push(spec);
      const op = spec.env.BACKFILL_OPERATION;
      if (op === 'identity') return state.identityFailure ? { status: 1, stdout: '', stderr: 'BACKFILL_RUN_FAILED STORAGE_UNAVAILABLE' } : { status: 0, stdout: JSON.stringify(state.storage ?? storageIdentity()) + '\n', stderr: '' };
      calls.order.push('operation');
      const dirOut = spec.env.BACKFILL_EVIDENCE_DIR;
      if (state.childLeak) return { status: 0, stdout: `leak ${SECRETS.secretKey}`, stderr: '' };
      if (state.childFailure) return { status: 1, stdout: '', stderr: 'BACKFILL_RUN_FAILED MANIFEST_INVALID' };
      if (op === 'observe') writeFileSync(join(dirOut, 'observed-manifest.json'), JSON.stringify({ candidates: [{ datasetId: 'a' }], rejected: [], manifestSha256: hex('observed-manifest'), leak: state.fileLeak ? SECRETS.accessKey : undefined }), { mode: 0o400 });
      else writeFileSync(join(dirOut, 'result.json'), JSON.stringify({ lineage: { observedManifestSha256: hex('observed-manifest'), approvedManifestSha256: hex('approved'), approvedIdsDigest: hex('ids'), executedManifestSha256: hex('exec') }, run: { counts: { candidates: 1, committed: 1, replayed: 0, stopped: 0, notAttempted: 0 } } }), { mode: 0o400 });
      return { status: state.childStatus, stdout: '{}', stderr: '' };
    },
  };
  return { dir, requestPath, request: final, credPath, credDir, deps, calls, state, credRecord, authPath: join(dir, 'authorization.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const launch = (ctx, argv = null, env = {}) => runLauncher(argv ?? [ctx.request.operation, ctx.requestPath], env, ctx.deps);
const secretsIn = dir => readdirSync(dir).some(name => Object.values(SECRETS).some(secret => readFileSync(join(dir, name), 'utf8').includes(secret)));
const noEvidence = ctx => assert.equal(existsSync(join(ctx.request.evidenceDir, 'binding.json')), false, 'no binding was sealed');

test('observe: seals immutable, secret-free binding, output and receipt for a fully verified disposable target', async () => {
  const ctx = setup();
  try {
    const result = await launch(ctx);
    assert.equal(result.exitCode, 0, result.code); assert.equal(result.code, 'COMPLETED');
    assert.deepEqual(readdirSync(result.evidenceDir).sort(), ['binding.json', 'observed-manifest.json', 'receipt.json']);
    for (const name of readdirSync(result.evidenceDir)) assert.equal(statSync(join(result.evidenceDir, name)).mode & 0o777, 0o400, `${name} is read-only`);
    assert.equal(secretsIn(result.evidenceDir), false);
    const binding = JSON.parse(readFileSync(join(result.evidenceDir, 'binding.json'), 'utf8'));
    assert.equal(binding.schema, 'phase029-backfill-binding/v2');
    assert.equal(binding.postgres.systemIdentifier, ctx.request.postgres.expectedSystemIdentifier); assert.equal(binding.postgres.migrationCount, 25);
    assert.equal(binding.postgres.m24.checksum, FROZEN_MIGRATIONS.m24.checksum); assert.equal(binding.postgres.m25.checksum, FROZEN_MIGRATIONS.m25.checksum);
    assert.equal(binding.postgres.schemaEntries, 1842); assert.equal(binding.postgres.historySha256, historyDigest(observedHistory(25)));
    assert.equal(binding.storage.bucket, 'g1-abc'); assert.match(binding.storage.configFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(binding.resolverSubject, 'system:phase029-backfill:run-20261006-abcd'); assert.equal(binding.manifests, null);
    assert.deepEqual(binding.implementation, implementation()); assert.equal(binding.implementationSha256, implementationDigest(implementation())); assert.equal(binding.evidenceDir.realpath, result.evidenceDir);
    assert.deepEqual(binding.containers.postgres, { container: 'c', id: 'i', systemIdentifier: ctx.request.postgres.expectedSystemIdentifier });
    const receipt = JSON.parse(readFileSync(join(result.evidenceDir, 'receipt.json'), 'utf8'));
    assert.equal(receipt.binding.sha256, sha256(readFileSync(join(result.evidenceDir, 'binding.json'), 'utf8'))); assert.equal(receipt.implementationStable, true); assert.equal(receipt.authorizationSha256, null);
    assert.deepEqual(receipt.counts, { candidates: 1, rejected: 0 });
    // identity first, then the operation; both fenced to the two bound endpoints; the credentials reach only the child's environment
    assert.deepEqual(ctx.calls.child.map(spec => spec.env.BACKFILL_OPERATION), ['identity', 'observe']);
    for (const spec of ctx.calls.child) {
      assert.deepEqual(JSON.parse(spec.env.BACKFILL_ALLOWED_ENDPOINTS), ['127.0.0.1:55461', '127.0.0.1:55462']); assert.ok(spec.args.some(arg => arg.endsWith('maintenance-fence.cjs')));
      assert.equal(spec.args.join(' ').includes(SECRETS.dbPassword), false);
      assert.equal(spec.env.STORAGE_SECRET_KEY, SECRETS.secretKey); assert.ok(spec.env.DATABASE_URL.includes(encodeURIComponent(SECRETS.dbPassword)));
    }
    assert.deepEqual(ctx.calls.order.slice(0, 2), ['target', 'db']);
  } finally { ctx.cleanup(); }
});

test('apply: binds the approved manifest into the receipt; a STOPPED run exits 3 and is recorded as such', async () => {
  const ctx = setup({ operation: 'apply' });
  try {
    const done = await launch(ctx);
    assert.equal(done.exitCode, 0, done.code);
    const receipt = JSON.parse(readFileSync(join(done.evidenceDir, 'receipt.json'), 'utf8'));
    assert.equal(receipt.approvedLineage.approvedManifestSha256, hex('approved')); assert.equal(receipt.approvedLineage.observedManifestSha256, hex('observed-manifest'));
    const binding = JSON.parse(readFileSync(join(done.evidenceDir, 'binding.json'), 'utf8'));
    assert.deepEqual(binding.manifests, { observedSha256: ctx.request.manifests.observedSha256, approvedSha256: ctx.request.manifests.approvedSha256 });
    const env = ctx.calls.child.at(-1).env; assert.equal(env.BACKFILL_APPROVED_SHA256, ctx.request.manifests.approvedSha256); assert.equal(env.BACKFILL_RUN_TOKEN, 'run-20261006-abcd');
  } finally { ctx.cleanup(); }
  const stopped = setup({ operation: 'apply' });
  try {
    stopped.state.childStatus = 3;
    const result = await launch(stopped);
    assert.equal(result.exitCode, 3); assert.equal(result.code, 'STOPPED');
    assert.equal(JSON.parse(readFileSync(join(result.evidenceDir, 'receipt.json'), 'utf8')).status, 'STOPPED');
  } finally { stopped.cleanup(); }
});

// ---------------------------------------------------------------- guarded migration steps
for (const operation of ['migrate-m24', 'migrate-m25']) {
  test(`${operation}: exact pre-state, one pinned step, exact schema delta, unchanged data, sealed evidence with the post state`, async () => {
    const ctx = setup({ operation });
    try {
      const next = operation === 'migrate-m24' ? 24 : 25;
      ctx.state.afterMutate = state => applyAfter(state, operation, ctx.request);
      const result = await launch(ctx);
      assert.equal(result.exitCode, 0, result.code);
      assert.deepEqual(readdirSync(result.evidenceDir).sort(), ['binding.json', 'migration-output.log', 'receipt.json', 'verification.json']);
      for (const name of readdirSync(result.evidenceDir)) assert.equal(statSync(join(result.evidenceDir, name)).mode & 0o777, 0o400);
      assert.equal(secretsIn(result.evidenceDir), false);
      const verification = JSON.parse(readFileSync(join(result.evidenceDir, 'verification.json'), 'utf8'));
      assert.equal(verification.historyMatchesExpected, true); assert.equal(verification.delta.removed, 0); assert.equal(verification.delta.changed, 0);
      assert.equal(verification.delta.added, operation === 'migrate-m24' ? 12 : 1); assert.equal(verification.tables.tables, 3);
      assert.equal(verification.after.schemaEntries, OP_PROFILE[operation].after.entries); assert.equal(verification.after.migrationCount, next);
      const receipt = JSON.parse(readFileSync(join(result.evidenceDir, 'receipt.json'), 'utf8'));
      assert.equal(receipt.status, 'COMPLETED'); assert.equal(receipt.postState.migrationCount, next); assert.equal(receipt.postState.schemaEntries, OP_PROFILE[operation].after.entries);
      assert.equal(ctx.calls.migrations, 1); assert.equal(ctx.calls.child.length, 0, 'no storage child and no application child runs for a migration');
      assert.equal(ctx.calls.order.filter(step => step === 'operation').length, 1);
    } finally { ctx.cleanup(); }
  });
}
test('a migration step that fails seals a FAILED receipt with the observed state, never retries and never reverses anything', async () => {
  const ctx = setup({ operation: 'migrate-m24' });
  try {
    ctx.state.migrationStatus = 1;
    const result = await launch(ctx);
    assert.equal(result.exitCode, 1); assert.equal(result.code, 'FAILED');
    const receipt = JSON.parse(readFileSync(join(result.evidenceDir, 'receipt.json'), 'utf8')); const verification = JSON.parse(readFileSync(join(result.evidenceDir, 'verification.json'), 'utf8'));
    assert.equal(receipt.status, 'FAILED'); assert.equal(receipt.postState, null); assert.equal(verification.partial, true); assert.equal(ctx.calls.migrations, 1, 'exactly one attempt');
  } finally { ctx.cleanup(); }
});
const after24 = (state, mutateRows) => { const rows = mutateRows(rowsFor(1841)); state.dbObserved.manifestRows = rows; state.dbObserved.schemaEntries = rows.length; state.dbObserved.schemaManifestSha256 = manifestDigest(rows); state.dbObserved.history = observedHistory(24); };
const MIGRATION_FAULTS = {
  'unexpected extra schema object': [state => after24(state, rows => [...rows, ['index', '["public","x"]', 'i']]), 'MIGRATION_SCHEMA_DELTA_UNEXPECTED'],
  'an existing entry changed': [state => after24(state, rows => { rows[10] = [rows[10][0], rows[10][1], ['changed']]; return rows; }), 'MIGRATION_CHANGED_EXISTING_SCHEMA'],
  'table data changed': [state => { after24(state, rows => rows); state.dbObserved.tables[1] = ['Dataset', 6, hex('d2')]; }, 'MIGRATION_DATA_CHANGED'],
  'a dataset became resolved': [state => { after24(state, rows => rows); state.dbObserved.datasets = { total: 120, unresolved: 119, resolved: 1, live: 75 }; }, 'MIGRATION_DATASETS_RESOLVED'],
  'history did not gain the frozen row': [state => { after24(state, rows => rows); state.dbObserved.history = observedHistory(23); }, 'HISTORY_COUNT_MISMATCH'],
  'wrong checksum recorded for the new migration': [state => { after24(state, rows => rows); state.dbObserved.history = observedHistory(24).map((row, i) => (i === 23 ? { ...row, checksum: hex('wrong') } : row)); }, 'HISTORY_MISMATCH'],
};
for (const [label, [fault, expected]] of Object.entries(MIGRATION_FAULTS)) test(`migrate-m24 verification fails closed (${label}) with ${expected} and seals a FAILED receipt`, async () => {
  const ctx = setup({ operation: 'migrate-m24' });
  try {
    ctx.state.afterMutate = fault;
    const result = await launch(ctx);
    assert.equal(result.exitCode, 1, label); assert.equal(result.code, 'FAILED');
    const receipt = JSON.parse(readFileSync(join(result.evidenceDir, 'receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'FAILED'); assert.equal(receipt.childFailureCode, expected); assert.equal(receipt.postState, null);
  } finally { ctx.cleanup(); }
});
test('migration steps refuse a wrong pre-state and any storage or approval input', async () => {
  for (const [label, options, mutate, expected] of [
    ['migrate-m24 against a database already at 24', { operation: 'migrate-m24' }, ctx => { ctx.state.dbObserved.history = observedHistory(24); }, 'HISTORY_COUNT_MISMATCH'],
    ['migrate-m25 against a database at 23', { operation: 'migrate-m25' }, ctx => { ctx.state.dbObserved.history = observedHistory(23); }, 'HISTORY_COUNT_MISMATCH'],
    ['pre-state schema digest differs', { operation: 'migrate-m24' }, ctx => { ctx.state.dbObserved.schemaManifestSha256 = hex('other'); }, 'SCHEMA_MANIFEST_MISMATCH'],
  ]) {
    const ctx = setup(options);
    try { mutate(ctx); const result = await launch(ctx); assert.equal(result.exitCode, 1, label); assert.equal(result.code, expected, label); assert.equal(ctx.calls.migrations, 0, label); noEvidence(ctx); } finally { ctx.cleanup(); }
  }
  const withStorage = setup({ operation: 'migrate-m24', mutateRequest: r => { r.storage = { endpoint: 'http://127.0.0.1:55462', bucket: 'g1-abc', expectedEndpoint: 'http://127.0.0.1:55462', expectedBucket: 'g1-abc' }; return r; } });
  try { assert.equal((await launch(withStorage)).code, 'REQUEST_STORAGE_INVALID'); assert.equal(withStorage.calls.migrations, 0); } finally { withStorage.cleanup(); }
  const withManifests = setup({ operation: 'migrate-m24', mutateRequest: r => { r.manifests = { observedPath: '/x', observedSha256: hex('a'), approvedPath: '/y', approvedSha256: hex('b') }; return r; } });
  try { assert.equal((await launch(withManifests)).code, 'REQUEST_MANIFESTS_INVALID'); } finally { withManifests.cleanup(); }
  const storageKeys = setup({ operation: 'migrate-m24', credentials: { storageAccessKey: SECRETS.accessKey, storageSecretKey: SECRETS.secretKey } });
  try { assert.equal((await launch(storageKeys)).code, 'CREDENTIALS_SHAPE_INVALID', 'a migration never receives storage credentials'); assert.equal(storageKeys.calls.migrations, 0); } finally { storageKeys.cleanup(); }
});

// ---------------------------------------------------------------- credentials
const CREDENTIAL_REFUSALS = {
  'credentials file readable by others': [ctx => chmodSync(ctx.credPath, 0o644), 'CREDENTIALS_FILE_NOT_PRIVATE'],
  'credentials directory readable by others': [ctx => chmodSync(ctx.credDir, 0o755), 'CREDENTIALS_DIR_NOT_PRIVATE'],
  'credentials bytes differ from the pin': [ctx => writeFileSync(ctx.credPath, JSON.stringify({ ...ctx.credRecord, postgresPassword: 'a-different-password' }), { mode: 0o600 }), 'CREDENTIALS_HASH_MISMATCH'],
  'credentials older than four hours': [ctx => { const old = new Date(Date.now() - 5 * 3600 * 1000); utimesSync(ctx.credPath, old, old); }, 'CREDENTIALS_STALE'],
};
for (const [label, [mutate, expected]] of Object.entries(CREDENTIAL_REFUSALS)) test(`refuses (${label}) before any probe, target check or evidence`, async () => {
  const ctx = setup();
  try { mutate(ctx); const result = await launch(ctx); assert.equal(result.code, expected, label); assert.equal(ctx.calls.db, 0); assert.equal(ctx.calls.target, 0); assert.equal(ctx.calls.child.length, 0); noEvidence(ctx); } finally { ctx.cleanup(); }
});
test('credentials inside the repository, in an environment file, or with a malformed shape are refused; the request carries no secret field', () => {
  const ctx = setup();
  try {
    const attempt = (path, text, mode = 0o600) => { const request = structuredClone(ctx.request); writeFileSync(path, text, { mode }); request.credentials = { path, sha256: sha256(text) }; return () => loadCredentials(request, REPO); };
    const inside = join(REPO, 'scripts/db-safety/zz-test-credentials.json');
    try { assert.throws(attempt(inside, JSON.stringify(ctx.credRecord)), /CREDENTIALS_INSIDE_REPOSITORY/); } finally { rmSync(inside, { force: true }); }
    assert.throws(attempt(join(ctx.credDir, '.env'), JSON.stringify(ctx.credRecord)), /CREDENTIALS_ENV_FILE_FORBIDDEN/);
    assert.throws(attempt(join(ctx.credDir, 'prod.env'), JSON.stringify(ctx.credRecord)), /CREDENTIALS_ENV_FILE_FORBIDDEN/);
    assert.throws(attempt(join(ctx.credDir, 'a.json'), JSON.stringify({ ...ctx.credRecord, extra: 'x' })), /CREDENTIALS_SHAPE_INVALID/);
    assert.throws(attempt(join(ctx.credDir, 'b.json'), JSON.stringify({ ...ctx.credRecord, postgresPassword: 'short' })), /CREDENTIALS_SHAPE_INVALID/);
    assert.throws(attempt(join(ctx.credDir, 'c.json'), JSON.stringify({ schema: CREDENTIALS_SCHEMA, postgresPassword: SECRETS.dbPassword })), /CREDENTIALS_SHAPE_INVALID/, 'storage credentials are required for observe/apply');
    assert.doesNotThrow(attempt(join(ctx.credDir, 'd.json'), JSON.stringify(ctx.credRecord)));
    for (const key of ['url', 'password', 'accessKey', 'secretKey']) assert.throws(() => validateRequest({ ...ctx.request, postgres: { ...ctx.request.postgres, [key]: 'x' } }), /REQUEST_POSTGRES_INVALID/, `the request has no ${key} field`);
    assert.throws(() => validateRequest({ ...ctx.request, storage: { ...ctx.request.storage, secretKey: 'x' } }), /REQUEST_STORAGE_INVALID/);
  } finally { ctx.cleanup(); }
});

const REFUSALS = {
  'inherited DATABASE_URL': [{}, ctx => launch(ctx, null, { DATABASE_URL: 'postgresql://x' }), 'AMBIGUOUS_TARGET_ENVIRONMENT'],
  'inherited PGHOST': [{}, ctx => launch(ctx, null, { PGHOST: 'db' }), 'AMBIGUOUS_TARGET_ENVIRONMENT'],
  'inherited POSTGRES_PASSWORD': [{}, ctx => launch(ctx, null, { POSTGRES_PASSWORD: 'x' }), 'AMBIGUOUS_TARGET_ENVIRONMENT'],
  'inherited MINIO_ENDPOINT': [{}, ctx => launch(ctx, null, { MINIO_ENDPOINT: 'http://m' }), 'AMBIGUOUS_TARGET_ENVIRONMENT'],
  'inherited storage credentials': [{}, ctx => launch(ctx, null, { AWS_ACCESS_KEY_ID: 'x' }), 'AMBIGUOUS_TARGET_ENVIRONMENT'],
  'inherited receipt variable': [{}, ctx => launch(ctx, null, { DB_SAFETY_RECEIPT: '/x' }), 'AMBIGUOUS_TARGET_ENVIRONMENT'],
  'inherited NODE_OPTIONS': [{}, ctx => launch(ctx, null, { NODE_OPTIONS: '--require x' }), 'AMBIGUOUS_TARGET_ENVIRONMENT'],
  'extra argument': [{}, ctx => launch(ctx, ['observe', ctx.requestPath, 'extra']), 'USAGE_OPERATION_AND_REQUEST_ONLY'],
  'unknown operation': [{}, ctx => launch(ctx, ['migrate', ctx.requestPath]), 'USAGE_OPERATION_AND_REQUEST_ONLY'],
  'operation differs from the request': [{}, ctx => launch(ctx, ['apply', ctx.requestPath]), 'REQUEST_OPERATION_MISMATCH'],
  'request readable by others': [{}, ctx => { chmodSync(ctx.requestPath, 0o644); return launch(ctx); }, 'REQUEST_FILE_NOT_PRIVATE'],
  'expired request': [{ mutateRequest: r => ({ ...r, issuedAt: new Date(Date.now() - 7200000).toISOString(), expiresAt: new Date(Date.now() - 3600000).toISOString() }) }, ctx => launch(ctx), 'REQUEST_EXPIRED_OR_UNBOUNDED'],
  'request valid for more than 30 minutes': [{ mutateRequest: r => ({ ...r, expiresAt: new Date(Date.now() + 7200000).toISOString() }) }, ctx => launch(ctx), 'REQUEST_EXPIRED_OR_UNBOUNDED'],
  'unknown request key': [{ mutateRequest: r => ({ ...r, extra: 1 }) }, ctx => launch(ctx), 'REQUEST_SHAPE_INVALID'],
  'old request schema': [{ mutateRequest: r => ({ ...r, schema: 'phase029-backfill-request/v1' }) }, ctx => launch(ctx), 'REQUEST_SCHEMA_UNSUPPORTED'],
  'malformed run token': [{ mutateRequest: r => ({ ...r, runToken: 'cmuvg0zar000010uwqzkhidz1:user' }) }, ctx => launch(ctx), 'RUN_TOKEN_INVALID'],
  'history not 25 entries': [{ mutateRequest: r => { r.postgres.expectedHistory = r.postgres.expectedHistory.slice(0, 24); return r; } }, ctx => launch(ctx), 'REQUEST_HISTORY_INVALID'],
  'schema entry pin wrong': [{ mutateRequest: r => { r.postgres.expectedSchemaEntries = 1841; return r; } }, ctx => launch(ctx), 'REQUEST_SCHEMA_PIN_INVALID'],
  'implementation file hash differs': [{}, ctx => { ctx.state.implementation.files['apps/web/src/lib/datasets/modality-backfill.ts'] = hex('edited'); return launch(ctx); }, 'IMPLEMENTATION_HASH_MISMATCH'],
  'launcher itself differs': [{}, ctx => { ctx.state.implementation.files['scripts/db-safety/backfill-launcher.mjs'] = hex('edited'); return launch(ctx); }, 'IMPLEMENTATION_HASH_MISMATCH'],
  'implementation file set differs': [{}, ctx => { delete ctx.state.implementation.files['apps/web/scripts/backfill-run.ts']; return launch(ctx); }, 'IMPLEMENTATION_FILE_SET_MISMATCH'],
  'generated client differs': [{}, ctx => { ctx.state.implementation.clientTreeSha256 = hex('other'); return launch(ctx); }, 'GENERATED_CLIENT_MISMATCH'],
  'migration chain differs': [{}, ctx => { ctx.state.implementation.migrationsTreeSha256 = hex('other'); return launch(ctx); }, 'MIGRATION_CHAIN_MISMATCH'],
  'wrong system identifier (TCP)': [{}, ctx => { ctx.state.dbObserved.systemIdentifier = '1111111111111111111'; return launch(ctx); }, 'SYSTEM_IDENTITY_MISMATCH'],
  'container control file disagrees with the TCP identity': [{}, ctx => { ctx.state.containerSystem = '2222222222222222222'; return launch(ctx); }, 'SYSTEM_IDENTITY_MISMATCH'],
  'wrong database name': [{}, ctx => { ctx.state.dbObserved.database = 'other'; return launch(ctx); }, 'SYSTEM_IDENTITY_MISMATCH'],
  'history checksum differs': [{}, ctx => { ctx.state.dbObserved.history[3] = { ...ctx.state.dbObserved.history[3], checksum: hex('x') }; return launch(ctx); }, 'HISTORY_MISMATCH'],
  'history has 24 migrations': [{}, ctx => { ctx.state.dbObserved.history = ctx.state.dbObserved.history.slice(0, 24); return launch(ctx); }, 'HISTORY_COUNT_MISMATCH'],
  'a migration is unfinished': [{}, ctx => { ctx.state.dbObserved.history = ctx.state.dbObserved.history.map((row, i) => ({ ...row, finished: i !== 10, rolledBack: false })); return launch(ctx); }, 'HISTORY_INCOMPLETE'],
  'a migration is rolled back': [{}, ctx => { ctx.state.dbObserved.history = ctx.state.dbObserved.history.map((row, i) => ({ ...row, finished: true, rolledBack: i === 5 })); return launch(ctx); }, 'HISTORY_INCOMPLETE'],
  'schema manifest differs (drift)': [{}, ctx => { ctx.state.dbObserved.schemaManifestSha256 = hex('drift'); return launch(ctx); }, 'SCHEMA_MANIFEST_MISMATCH'],
  'schema entry count differs': [{}, ctx => { ctx.state.dbObserved.schemaEntries = 1841; return launch(ctx); }, 'SCHEMA_ENTRY_COUNT_MISMATCH'],
  'disposable run against the application system': [{ mutateRequest: r => { r.postgres.expectedSystemIdentifier = APPLICATION_SYSTEM; return r; } }, ctx => { ctx.state.dbObserved.systemIdentifier = APPLICATION_SYSTEM; ctx.state.containerSystem = APPLICATION_SYSTEM; return launch(ctx); }, 'APPLICATION_SYSTEM_FORBIDDEN_FOR_DISPOSABLE'],
  'disposable host not loopback': [{ mutateRequest: r => { r.postgres.host = 'db.internal'; return r; } }, ctx => launch(ctx), 'DISPOSABLE_TARGET_REQUIRED'],
  'port differs from the pinned container': [{ mutateRequest: r => { r.disposablePins.postgres.port = 55469; return r; } }, ctx => launch(ctx), 'URL_CONTAINER_MISMATCH'],
  'storage endpoint differs from the expected one': [{ mutateRequest: r => { r.storage.expectedEndpoint = 'http://127.0.0.1:55470'; return r; } }, ctx => launch(ctx), 'STORAGE_TARGET_MISMATCH'],
  'bucket differs from the expected one': [{ mutateRequest: r => { r.storage.expectedBucket = 'g1-other'; return r; } }, ctx => launch(ctx), 'STORAGE_TARGET_MISMATCH'],
  'storage endpoint is not the pinned container': [{ mutateRequest: r => { r.storage.endpoint = r.storage.expectedEndpoint = 'http://127.0.0.1:55470'; return r; } }, ctx => launch(ctx), 'DISPOSABLE_STORAGE_REQUIRED'],
  'storage bucket is not a disposable bucket': [{ mutateRequest: r => { r.storage.bucket = r.storage.expectedBucket = 'annotation-assets'; return r; } }, ctx => launch(ctx), 'DISPOSABLE_STORAGE_REQUIRED'],
  'storage unavailable': [{}, ctx => { ctx.state.identityFailure = true; return launch(ctx); }, 'STORAGE_UNAVAILABLE'],
  'bucket does not exist': [{}, ctx => { ctx.state.storage = { endpointHost: '127.0.0.1', endpointPort: 55462, useSSL: false, bucket: 'g1-abc', bucketExists: false, configFingerprint: hex('c') }; return launch(ctx); }, 'STORAGE_IDENTITY_MISMATCH'],
  'storage answers from a different port': [{}, ctx => { ctx.state.storage = { endpointHost: '127.0.0.1', endpointPort: 55471, useSSL: false, bucket: 'g1-abc', bucketExists: true, configFingerprint: hex('c') }; return launch(ctx); }, 'STORAGE_IDENTITY_MISMATCH'],
  'storage configuration fingerprint differs from the credentials': [{}, ctx => { ctx.state.storage = { endpointHost: '127.0.0.1', endpointPort: 55462, useSSL: false, bucket: 'g1-abc', bucketExists: true, configFingerprint: hex('different') }; return launch(ctx); }, 'STORAGE_FINGERPRINT_MISMATCH'],
  'evidence directory outside the allowed root': [{ mutateRequest: r => { r.evidenceDir = join(tmpdir(), 'bl-outside-' + randomUUID()); return r; } }, ctx => launch(ctx), 'EVIDENCE_DIR_OUTSIDE_ALLOWED_ROOT'],
  'evidence directory already holds files': [{}, ctx => { mkdirSync(ctx.request.evidenceDir, { mode: 0o700 }); writeFileSync(join(ctx.request.evidenceDir, 'old.json'), '{}'); return launch(ctx); }, 'EVIDENCE_DIR_NOT_EMPTY'],
  'evidence directory is a symlink': [{}, ctx => { const real = join(ctx.dir, 'real'); mkdirSync(real); symlinkSync(real, ctx.request.evidenceDir); return launch(ctx); }, 'EVIDENCE_DIR_NOT_EMPTY'],
  'observe request that carries manifests': [{ mutateRequest: r => { r.manifests = { approvedPath: '/x', approvedSha256: hex('a'), observedPath: '/y', observedSha256: hex('b') }; return r; } }, ctx => launch(ctx), 'REQUEST_MANIFESTS_INVALID'],
  'shared-dev kind while not enabled': [{ kind: 'shared-dev' }, ctx => launch(ctx), 'SHARED_DEV_EXECUTION_NOT_ENABLED'],
};
for (const [label, [options, action, expected]] of Object.entries(REFUSALS)) {
  test(`refuses (${label}) with ${expected}, before any evidence, approval or storage/database mutation`, async () => {
    const ctx = setup(options);
    try {
      const result = await action(ctx);
      assert.equal(result.exitCode, 1, `${label}: ${result.code}`); assert.equal(result.code, expected);
      assert.ok(!ctx.calls.child.some(spec => spec.env.BACKFILL_OPERATION !== 'identity'), 'the operation child never started');
      assert.equal(ctx.calls.migrations, 0); noEvidence(ctx);
      assert.equal(existsSync(join(ctx.request.evidenceDir, 'receipt.json')), false);
    } finally { ctx.cleanup(); }
  });
}

const APPLY_REFUSALS = {
  'observed manifest bytes differ from the pin': ctx => writeFileSync(ctx.request.manifests.observedPath, '{"manifestSha256":"x"}'),
  'approved manifest bytes differ from the pin': ctx => writeFileSync(ctx.request.manifests.approvedPath, JSON.stringify({ observedManifestSha256: hex('observed-manifest'), sha256: hex('another') })),
  'manifest file readable by others': ctx => chmodSync(ctx.request.manifests.approvedPath, 0o644),
};
for (const [label, mutate] of Object.entries(APPLY_REFUSALS)) test(`apply refuses (${label})`, async () => {
  const ctx = setup({ operation: 'apply' });
  try {
    mutate(ctx);
    const result = await launch(ctx);
    assert.equal(result.exitCode, 1); assert.match(result.code, /^MANIFEST_FILE_(HASH_MISMATCH|NOT_PRIVATE)$/);
    assert.ok(!ctx.calls.child.some(spec => spec.env.BACKFILL_OPERATION === 'apply'));
  } finally { ctx.cleanup(); }
});
test('apply refuses an approved manifest that names a different observed manifest, and an observed manifest for another bucket', async () => {
  for (const [label, observed, approved, expected] of [
    ['other observed', { manifestSha256: hex('different'), policy: { expectedBucket: 'g1-abc' } }, { observedManifestSha256: hex('observed-manifest'), sha256: hex('approved') }, 'APPROVED_OBSERVED_MISMATCH'],
    ['other bucket', { manifestSha256: hex('observed-manifest'), policy: { expectedBucket: 'g1-zzz' } }, { observedManifestSha256: hex('observed-manifest'), sha256: hex('approved') }, 'MANIFEST_BUCKET_MISMATCH'],
  ]) {
    const ctx = setup({ operation: 'apply' });
    try {
      for (const [name, value] of [['observed', observed], ['approved', approved]]) { const text = JSON.stringify(value); writeFileSync(ctx.request.manifests[`${name}Path`], text); ctx.request.manifests[`${name}Sha256`] = sha256(text); }
      writeFileSync(ctx.requestPath, JSON.stringify(ctx.request));
      const result = await launch(ctx); assert.equal(result.code, expected, label);
      assert.ok(!ctx.calls.child.some(spec => spec.env.BACKFILL_OPERATION === 'apply'));
    } finally { ctx.cleanup(); }
  }
});
test('apply without the approval inputs is not a request at all', async () => {
  const ctx = setup({ operation: 'apply', mutateRequest: r => { r.manifests = {}; return r; } });
  try { const result = await launch(ctx); assert.equal(result.code, 'REQUEST_MANIFESTS_INVALID'); assert.equal(ctx.calls.child.length, 0); } finally { ctx.cleanup(); }
});

test('the code changing while the child runs invalidates the run: no receipt is sealed', async () => {
  const ctx = setup();
  try {
    ctx.state.implementationAfterRun = { ...implementation(), files: { ...implementation().files, 'apps/web/src/lib/datasets/modality-backfill.ts': hex('swapped') } };
    const result = await launch(ctx);
    assert.equal(result.exitCode, 1); assert.equal(result.code, 'IMPLEMENTATION_HASH_MISMATCH');
    assert.equal(existsSync(join(ctx.request.evidenceDir, 'receipt.json')), false);
  } finally { ctx.cleanup(); }
});
test('a secret in the child output or in a written file aborts the run and removes what the run wrote', async () => {
  for (const [label, key, expected] of [['child stdout', 'childLeak', 'SECRET_IN_CHILD_OUTPUT'], ['output file', 'fileLeak', 'SECRET_IN_EVIDENCE']]) {
    const ctx = setup();
    try {
      ctx.state[key] = true;
      const result = await launch(ctx);
      assert.equal(result.exitCode, 1, label); assert.equal(result.code, expected, label);
      assert.equal(existsSync(join(ctx.request.evidenceDir, 'receipt.json')), false, label);
      if (key === 'fileLeak') assert.deepEqual(readdirSync(ctx.request.evidenceDir), [], 'secret-bearing files were removed');
    } finally { ctx.cleanup(); }
  }
});
test('a child failure is a FAILED receipt with only a fixed failure code', async () => {
  const ctx = setup({ operation: 'apply' });
  try {
    ctx.state.childFailure = true;
    const result = await launch(ctx);
    assert.equal(result.exitCode, 1); assert.equal(result.code, 'FAILED');
    const receipt = JSON.parse(readFileSync(join(result.evidenceDir, 'receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'FAILED'); assert.equal(receipt.childFailureCode, 'MANIFEST_INVALID'); assert.equal(receipt.output, null);
  } finally { ctx.cleanup(); }
});

// ---------------------------------------------------------------- shared-dev: capability enabled (offline fakes only) + per-run authorization v2
const sharedDev = (operation, options = {}) => setup({ kind: 'shared-dev', operation, sharedDevEnabled: true, ...options });
test('shared-dev capability is disabled in the committed launcher; when enabled (offline fakes) a correct per-run authorization is required and sufficient for every operation', async () => {
  assert.equal(SHARED_DEV_ENABLED, false, 'shared-dev execution is not enabled in the committed launcher');
  for (const operation of ['observe', 'apply', 'migrate-m24', 'migrate-m25']) {
    const ctx = sharedDev(operation);
    try {
      if (operation.startsWith('migrate')) ctx.state.afterMutate = state => applyAfter(state, operation, ctx.request);
      const result = await launch(ctx);
      assert.equal(result.exitCode, 0, `${operation}: ${result.code}`);
      const binding = JSON.parse(readFileSync(join(result.evidenceDir, 'binding.json'), 'utf8')); const receipt = JSON.parse(readFileSync(join(result.evidenceDir, 'receipt.json'), 'utf8'));
      assert.equal(binding.targetKind, 'shared-dev'); assert.equal(receipt.authorizationSha256, ctx.request.authorization.sha256);
      assert.equal(secretsIn(result.evidenceDir), false);
      assert.equal(binding.containers.postgres.systemIdentifier, APPLICATION_SYSTEM);
    } finally { ctx.cleanup(); }
  }
});
test('enabling the capability alone authorizes nothing: no authorization artifact, no run, and nothing is probed first', async () => {
  const ctx = sharedDev('observe');
  try {
    rmSync(ctx.authPath);
    const result = await launch(ctx);
    assert.notEqual(result.exitCode, 0); assert.equal(ctx.calls.db, 0); assert.equal(ctx.calls.target, 0); assert.equal(ctx.calls.child.length, 0); noEvidence(ctx);
  } finally { ctx.cleanup(); }
});
const AUTH_STATIC = {
  'authorization bytes differ from the pin': [ctx => writeFileSync(ctx.authPath, JSON.stringify({ tampered: true })), 'AUTHORIZATION_HASH_MISMATCH'],
  'authorization readable by others': [ctx => chmodSync(ctx.authPath, 0o644), 'AUTHORIZATION_FILE_NOT_PRIVATE'],
};
for (const [label, [mutate, expected]] of Object.entries(AUTH_STATIC)) test(`shared-dev refuses (${label}) before any probe`, async () => {
  const ctx = sharedDev('apply');
  try { mutate(ctx); const result = await launch(ctx); assert.equal(result.code, expected); assert.equal(ctx.calls.db, 0); assert.equal(ctx.calls.target, 0); noEvidence(ctx); } finally { ctx.cleanup(); }
});
const AUTH_FIELDS = {
  'other operation': [a => ({ ...a, operation: 'observe' }), 'AUTHORIZATION_SCOPE_MISMATCH'],
  'other run token': [a => ({ ...a, runToken: 'run-other-00001' }), 'AUTHORIZATION_SCOPE_MISMATCH'],
  'other target kind': [a => ({ ...a, targetKind: 'disposable' }), 'AUTHORIZATION_SCOPE_MISMATCH'],
  'older schema': [a => ({ ...a, schema: 'phase029-backfill-authorization/v1' }), 'AUTHORIZATION_SCOPE_MISMATCH'],
  'other system identifier': [a => ({ ...a, postgres: { ...a.postgres, systemIdentifier: '1111111111111111111' } }), 'AUTHORIZATION_SCOPE_MISMATCH'],
  'other database name': [a => ({ ...a, postgres: { ...a.postgres, database: 'other' } }), 'AUTHORIZATION_SCOPE_MISMATCH'],
  'other migration count': [a => ({ ...a, postgres: { ...a.postgres, migrationCount: 23 } }), 'AUTHORIZATION_SCOPE_MISMATCH'],
  'other history digest': [a => ({ ...a, postgres: { ...a.postgres, historySha256: hex('history') } }), 'AUTHORIZATION_HISTORY_MISMATCH'],
  'other schema fingerprint': [a => ({ ...a, postgres: { ...a.postgres, schemaManifestSha256: hex('schema') } }), 'AUTHORIZATION_SCOPE_MISMATCH'],
  'other schema entry count': [a => ({ ...a, postgres: { ...a.postgres, schemaEntries: 1841 } }), 'AUTHORIZATION_SCOPE_MISMATCH'],
  'other M24 checksum': [a => ({ ...a, postgres: { ...a.postgres, m24: { ...a.postgres.m24, checksum: hex('m24') } } }), 'AUTHORIZATION_SCOPE_MISMATCH'],
  'other M25 checksum': [a => ({ ...a, postgres: { ...a.postgres, m25: { ...a.postgres.m25, checksum: hex('m25') } } }), 'AUTHORIZATION_SCOPE_MISMATCH'],
  'other implementation digest': [a => ({ ...a, implementationSha256: hex('impl') }), 'AUTHORIZATION_IMPLEMENTATION_MISMATCH'],
  'other storage bucket': [a => ({ ...a, storage: { ...a.storage, bucket: 'elsewhere' } }), 'AUTHORIZATION_SCOPE_MISMATCH'],
  'other storage endpoint host': [a => ({ ...a, storage: { ...a.storage, endpointHost: 'other.internal' } }), 'AUTHORIZATION_SCOPE_MISMATCH'],
  'other storage endpoint port': [a => ({ ...a, storage: { ...a.storage, endpointPort: 9001 } }), 'AUTHORIZATION_SCOPE_MISMATCH'],
  'other storage fingerprint format': [a => ({ ...a, storage: { ...a.storage, configFingerprint: 'not-a-hash' } }), 'AUTHORIZATION_SCOPE_MISMATCH'],
  'other observed manifest': [a => ({ ...a, manifests: { ...a.manifests, observedSha256: hex('o') } }), 'AUTHORIZATION_SCOPE_MISMATCH'],
  'other approved manifest': [a => ({ ...a, manifests: { ...a.manifests, approvedSha256: hex('a') } }), 'AUTHORIZATION_SCOPE_MISMATCH'],
  'other evidence directory': [a => ({ ...a, evidenceDir: '/somewhere/else' }), 'AUTHORIZATION_EVIDENCE_DIR_MISMATCH'],
  'expired': [a => ({ ...a, issuedAt: new Date(Date.now() - 7200000).toISOString(), expiresAt: new Date(Date.now() - 3600000).toISOString() }), 'AUTHORIZATION_EXPIRED_OR_UNBOUNDED'],
  'valid for more than four hours': [a => ({ ...a, expiresAt: new Date(Date.now() + 5 * 3600000).toISOString() }), 'AUTHORIZATION_EXPIRED_OR_UNBOUNDED'],
  'not yet valid': [a => ({ ...a, issuedAt: new Date(Date.now() + 600000).toISOString(), expiresAt: new Date(Date.now() + 1200000).toISOString() }), 'AUTHORIZATION_EXPIRED_OR_UNBOUNDED'],
  'extra key': [a => ({ ...a, extra: 1 }), 'AUTHORIZATION_SHAPE_INVALID'],
  'a secret field': [a => ({ ...a, postgres: { ...a.postgres, password: 'x' } }), 'AUTHORIZATION_SHAPE_INVALID'],
  'missing approver': [a => ({ ...a, authorizedBy: '' }), 'AUTHORIZATION_SHAPE_INVALID'],
};
for (const [label, [mutateAuth, expected]] of Object.entries(AUTH_FIELDS)) test(`shared-dev refuses an authorization with ${label} (${expected}) before any probe, evidence or child`, async () => {
  const ctx = sharedDev('apply', { mutateAuth });
  try { const result = await launch(ctx); assert.equal(result.code, expected, label); assert.equal(ctx.calls.db, 0); assert.equal(ctx.calls.target, 0); assert.equal(ctx.calls.child.length, 0); noEvidence(ctx); } finally { ctx.cleanup(); }
});
test('shared-dev: what is observed must equal what was authorized (history, schema, storage identity, independent identity), before any application-data access', async () => {
  for (const [label, options, mutate, expected] of [
    ['history differs from the authorized history', { operation: 'observe' }, ctx => { ctx.state.dbObserved.history[4] = { ...ctx.state.dbObserved.history[4], checksum: hex('drift') }; }, 'HISTORY_MISMATCH'],
    ['schema differs', { operation: 'observe' }, ctx => { ctx.state.dbObserved.schemaManifestSha256 = hex('drift'); }, 'SCHEMA_MANIFEST_MISMATCH'],
    ['container control file differs', { operation: 'observe' }, ctx => { ctx.state.containerSystem = '3333333333333333333'; }, 'SYSTEM_IDENTITY_MISMATCH'],
    ['storage fingerprint differs from the authorized one', { operation: 'observe', mutateAuth: a => ({ ...a, storage: { ...a.storage, configFingerprint: hex('other-config') } }) }, () => {}, 'AUTHORIZATION_OBSERVED_MISMATCH'],
    ['the database is not the application system', { operation: 'observe', mutateRequest: r => { r.postgres.expectedSystemIdentifier = '4444444444444444444'; return r; }, mutateAuth: a => ({ ...a, postgres: { ...a.postgres, systemIdentifier: '4444444444444444444' } }) }, ctx => { ctx.state.dbObserved.systemIdentifier = '4444444444444444444'; ctx.state.containerSystem = '4444444444444444444'; }, 'SHARED_DEV_SYSTEM_REQUIRED'],
  ]) {
    const ctx = sharedDev(options.operation, options);
    try { mutate(ctx); const result = await launch(ctx); assert.equal(result.code, expected, label); assert.ok(!ctx.calls.child.some(spec => spec.env.BACKFILL_OPERATION !== 'identity'), label); assert.equal(ctx.calls.migrations, 0); noEvidence(ctx); } finally { ctx.cleanup(); }
  }
});
test('shared-dev requests need container pins and an authorization; a disposable request may carry neither', () => {
  const ctx = sharedDev('observe');
  try {
    assert.throws(() => validateRequest({ ...ctx.request, sharedDevPins: undefined }), /REQUEST_PINS_INVALID/);
    assert.throws(() => validateRequest({ ...ctx.request, sharedDevPins: { ...ctx.request.sharedDevPins, postgres: { container: 'x', id: 'short' } } }), /REQUEST_PINS_INVALID/);
    assert.throws(() => validateRequest({ ...ctx.request, authorization: undefined }), /REQUEST_AUTHORIZATION_INVALID/);
    assert.throws(() => validateRequest({ ...ctx.request, disposablePins: { postgres: {}, minio: {} } }), /REQUEST_PINS_INVALID/);
  } finally { ctx.cleanup(); }
  const disposable = setup();
  try {
    assert.throws(() => validateRequest({ ...disposable.request, authorization: { path: '/x', sha256: hex('a') } }), /REQUEST_PINS_INVALID/);
    assert.throws(() => validateRequest({ ...disposable.request, sharedDevPins: { postgres: { container: 'x', id: 'a'.repeat(64) } } }), /REQUEST_PINS_INVALID/);
  } finally { disposable.cleanup(); }
});
test('authorization static validation is a pure function of the request, the implementation and the intended evidence path', () => {
  const ctx = sharedDev('observe');
  try {
    const record = JSON.parse(readFileSync(ctx.authPath, 'utf8'));
    assert.doesNotThrow(() => validateAuthorizationStatic(record, ctx.request, implementation(), record.evidenceDir));
    assert.throws(() => validateAuthorizationStatic(record, ctx.request, { ...implementation(), clientTreeSha256: hex('x') }, record.evidenceDir), /AUTHORIZATION_IMPLEMENTATION_MISMATCH/);
  } finally { ctx.cleanup(); }
});

test('manifest delta and data checks are exact (pure rules)', () => {
  assert.deepEqual(assertMigrationDelta('migrate-m24', rowsFor(1829), rowsFor(1841)), { added: 12, removed: 0, changed: 0, kinds: { column: 4, constraint: 2, trigger: 3, routine: 3 } });
  assert.deepEqual(assertMigrationDelta('migrate-m25', rowsFor(1841), rowsFor(1842)).added, 1);
  assert.throws(() => assertMigrationDelta('migrate-m24', rowsFor(1829), rowsFor(1842)), /MIGRATION_SCHEMA_DELTA_UNEXPECTED/);
  assert.throws(() => assertMigrationDelta('migrate-m25', rowsFor(1829), rowsFor(1841)), /MIGRATION_SCHEMA_DELTA_UNEXPECTED/);
  assert.throws(() => assertMigrationDelta('migrate-m24', rowsFor(1829), rowsFor(1829)), /MIGRATION_SCHEMA_DELTA_UNEXPECTED/);
  const wrongTable = rowsFor(1842).map(row => (row[0] === 'column' && row[1].includes('creationRequestHash') ? ['column', JSON.stringify(['public', 'Asset', 'creationRequestHash']), row[2]] : row));
  assert.throws(() => assertMigrationDelta('migrate-m25', rowsFor(1841), wrongTable), /MIGRATION_SCHEMA_DELTA_UNEXPECTED/);
});

test('ambient rules and request validation are exact', () => {
  assert.doesNotThrow(() => assertNoAmbientTargets({ PATH: '/usr/bin', HOME: '/home/x', LANG: 'C', TMPDIR: '/tmp' }));
  for (const key of ['DATABASE_URL', 'PGPASSWORD', 'PGHOST', 'POSTGRES_PASSWORD', 'REDIS_URL', 'MINIO_ROOT_USER', 'S3_ENDPOINT', 'STORAGE_BUCKET', 'BACKFILL_OPERATION', 'DB_SAFETY_RECEIPT', 'G1_RUNTIME_ROLE', 'NODE_OPTIONS', 'BULLMQ_PREFIX']) assert.throws(() => assertNoAmbientTargets({ [key]: 'x' }), /AMBIGUOUS_TARGET_ENVIRONMENT/, key);
  assert.doesNotThrow(() => assertNoAmbientTargets({ DATABASE_URL: '' }));
  assert.throws(() => validateRequest({}), /REQUEST_SHAPE_INVALID|REQUEST_SCHEMA_UNSUPPORTED/);
});

test('the real implementation set: every pinned file exists, is hashed, and the schema-manifest extractor matches the disposable runner', async () => {
  const implementationNow = computeImplementation(REPO);
  assert.deepEqual(Object.keys(implementationNow.files).sort(), [...IMPLEMENTATION_FILES].sort());
  assert.ok(Object.values(implementationNow.files).every(hash => /^[0-9a-f]{64}$/.test(hash)));
  assert.equal(implementationNow.files[`prisma/migrations/${FROZEN_MIGRATIONS.m24.name}/migration.sql`], FROZEN_MIGRATIONS.m24.checksum);
  assert.equal(implementationNow.files[`prisma/migrations/${FROZEN_MIGRATIONS.m25.name}/migration.sql`], FROZEN_MIGRATIONS.m25.checksum);
  const disposable = await import('../disposable-test.mjs');
  assert.equal(manifestSql(REPO), disposable.releaseManifestSqlFrom(join(REPO, disposable.RECOVERY_REVIEW.path)));
  assert.match(implementationDigest(implementationNow), /^[0-9a-f]{64}$/);
});

test('the launcher reads no environment target, no .env file, runs only the pinned child, psql and the frozen Prisma step, and writes evidence exclusively', () => {
  const launcher = readFileSync(new URL('../backfill-launcher.mjs', import.meta.url), 'utf8');
  const binding = readFileSync(new URL('../backfill-binding.mjs', import.meta.url), 'utf8');
  for (const text of [launcher, binding]) { assert.doesNotMatch(text, /dotenv|--env-file|loadEnvFile/); assert.doesNotMatch(text, /process\.env\.(DATABASE_URL|PG|MINIO|S3|AWS|REDIS|POSTGRES)/); }
  assert.match(launcher, /assertNoAmbientTargets\(env\)/); assert.match(launcher, /export const SHARED_DEV_ENABLED = false;/);
  assert.match(binding, /'wx'/, 'evidence is created exclusively'); assert.match(binding, /0o400/);
  const spawns = [...launcher.matchAll(/spawnSync\(([^,]+),/g)].map(match => match[1].trim());
  assert.deepEqual(spawns, ["'psql'", 'process.execPath', 'process.execPath'], 'psql (read-only), the fenced node child, and (inside the frozen run helper) the Prisma CLI');
  assert.deepEqual([...launcher.matchAll(/execFileSync\('([a-z]+)'/g)].map(match => match[1]), ['docker', 'docker'], 'only read-only docker inspect and pg_controldata');
  assert.doesNotMatch(launcher, /migrate (dev|reset|resolve)|'reset'|'resolve'|db push|'seed'/);
  assert.match(launcher, /default_transaction_read_only=on/);
  const child = readFileSync(new URL('../../../apps/web/scripts/backfill-run.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(child, /process\.env\.DATABASE_URL|dotenv|loadEnvFile|--env-file|\.env['"`]/);
});
