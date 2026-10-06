import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runLauncher, SHARED_DEV_ENABLED } from '../backfill-launcher.mjs';
import {
  APPLICATION_SYSTEM, FROZEN_MIGRATIONS, IMPLEMENTATION_FILES, assertNoAmbientTargets, computeImplementation, manifestSql, sha256, validateAuthorization, validateRequest,
} from '../backfill-binding.mjs';

// Offline: every probe and the child process are injected. Nothing here touches Docker, PostgreSQL, a storage service or any real target.
const hex = text => createHash('sha256').update(text).digest('hex');
const SECRETS = { dbPassword: 's3cr3t-db-password', accessKey: 'AKIAFAKEACCESSKEY', secretKey: 'fake-storage-secret-key' };
const history = () => Array.from({ length: 25 }, (_, index) => index === 23 ? { name: FROZEN_MIGRATIONS.m24.name, checksum: FROZEN_MIGRATIONS.m24.checksum } : index === 24 ? { name: FROZEN_MIGRATIONS.m25.name, checksum: FROZEN_MIGRATIONS.m25.checksum } : { name: `2026010${String(index).padStart(2, '0')}000000_m${index}`, checksum: hex(`m${index}`) });
const implementation = () => ({ files: Object.fromEntries(IMPLEMENTATION_FILES.map(file => [file, hex(file)])), clientTreeSha256: hex('client'), migrationsTreeSha256: hex('chain') });
const SCHEMA_SHA = hex('schema-manifest');

function setup({ kind = 'disposable', operation = 'observe', mutateRequest = r => r, sharedDevEnabled = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bl-test-'));
  const evidenceRoot = join(dir, 'evidence-root'); mkdirSync(evidenceRoot, { mode: 0o700 });
  const manifests = {};
  if (operation === 'apply') {
    const observed = JSON.stringify({ manifestSha256: hex('observed-manifest'), policy: { expectedBucket: kind === 'disposable' ? 'g1-abc' : 'annotation-assets' }, candidates: [] }), approved = JSON.stringify({ observedManifestSha256: hex('observed-manifest'), sha256: hex('approved') });
    for (const [name, text] of [['observed', observed], ['approved', approved]]) { const path = join(dir, `${name}.json`); writeFileSync(path, text, { mode: 0o600 }); manifests[`${name}Path`] = path; manifests[`${name}Sha256`] = sha256(text); }
  }
  const request = {
    schema: 'phase029-backfill-request/v1', operation, targetKind: kind, requestId: randomUUID(), issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
    runToken: 'run-20261006-abcd', evidenceDir: join(evidenceRoot, 'run-1'),
    postgres: { url: kind === 'disposable' ? `postgresql://postgres:${SECRETS.dbPassword}@127.0.0.1:55461/fieldframe` : `postgresql://app:${SECRETS.dbPassword}@db.internal:5432/fieldframe`, expectedSystemIdentifier: kind === 'disposable' ? '7693216261455953954' : APPLICATION_SYSTEM, expectedDatabase: 'fieldframe', expectedHistory: history(), expectedSchemaManifestSha256: SCHEMA_SHA, expectedSchemaEntries: 1842 },
    storage: { endpoint: kind === 'disposable' ? 'http://127.0.0.1:55462' : 'http://minio.internal:9000', accessKey: SECRETS.accessKey, secretKey: SECRETS.secretKey, bucket: kind === 'disposable' ? 'g1-abc' : 'annotation-assets', expectedEndpoint: kind === 'disposable' ? 'http://127.0.0.1:55462' : 'http://minio.internal:9000', expectedBucket: kind === 'disposable' ? 'g1-abc' : 'annotation-assets' },
    implementation: implementation(), manifests,
    ...(kind === 'disposable' ? { disposablePins: { postgres: { port: 55461, name: 'phase029-g1-x' }, minio: { port: 55462, name: 'phase029-g1-y' } } } : {}),
  };
  if (kind === 'shared-dev') {
    const record = { schema: 'phase029-backfill-authorization/v1', operation, systemIdentifier: APPLICATION_SYSTEM, runToken: request.runToken, approvedManifestSha256: operation === 'apply' ? manifests.approvedSha256 : null, storageEndpoint: request.storage.expectedEndpoint, bucket: request.storage.expectedBucket, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), authorizedBy: 'release owner', statement: 'offline test record' };
    const text = JSON.stringify(record); const path = join(dir, 'authorization.json'); writeFileSync(path, text, { mode: 0o600 });
    request.authorization = { path, sha256: sha256(text) }; request.__authPath = path;
  }
  const final = mutateRequest(request) ?? request;
  const authPath = final.__authPath; delete final.__authPath;
  const requestPath = join(dir, 'request.json'); writeFileSync(requestPath, JSON.stringify(final), { mode: 0o600 });
  const calls = { child: [], db: 0, disposable: 0 };
  const state = { implementation: implementation(), dbObserved: { systemIdentifier: final.postgres.expectedSystemIdentifier, database: 'fieldframe', history: history().map(row => ({ ...row, finished: true, rolledBack: false })), schemaEntries: 1842, schemaManifestSha256: SCHEMA_SHA, datasets: { total: 120, unresolved: 120, resolved: 0, live: 75 } }, childStatus: 0, storage: null, implementationAfterRun: null };
  const deps = {
    root: dir, now: () => Date.now(), sharedDevEnabled, evidenceRoots: () => [evidenceRoot],
    computeImplementation: () => (calls.child.some(spec => spec.env.BACKFILL_OPERATION !== 'identity') && state.implementationAfterRun ? state.implementationAfterRun : state.implementation),
    verifyDisposableTarget: async () => { calls.disposable += 1; },
    probeDatabase: () => { calls.db += 1; return state.dbObserved; },
    spawnChild: spec => {
      calls.child.push(spec);
      const op = spec.env.BACKFILL_OPERATION;
      if (op === 'identity') return state.identityFailure ? { status: 1, stdout: '', stderr: 'BACKFILL_RUN_FAILED STORAGE_UNAVAILABLE' } : { status: 0, stdout: JSON.stringify(state.storage ?? { endpointHost: new URL(final.storage.endpoint).hostname, endpointPort: Number(new URL(final.storage.endpoint).port), useSSL: false, bucket: final.storage.bucket, bucketExists: true, configFingerprint: hex('cfg') }) + '\n', stderr: '' };
      const dirOut = spec.env.BACKFILL_EVIDENCE_DIR;
      if (state.childLeak) return { status: 0, stdout: `leak ${SECRETS.secretKey}`, stderr: '' };
      if (state.childFailure) return { status: 1, stdout: '', stderr: 'BACKFILL_RUN_FAILED MANIFEST_INVALID' };
      if (op === 'observe') writeFileSync(join(dirOut, 'observed-manifest.json'), JSON.stringify({ candidates: [{ datasetId: 'a' }], rejected: [], manifestSha256: hex('observed-manifest'), leak: state.fileLeak ? SECRETS.accessKey : undefined }), { mode: 0o400 });
      else writeFileSync(join(dirOut, 'result.json'), JSON.stringify({ lineage: { observedManifestSha256: hex('observed-manifest'), approvedManifestSha256: hex('approved'), approvedIdsDigest: hex('ids'), executedManifestSha256: hex('exec') }, run: { counts: { candidates: 1, committed: 1, replayed: 0, stopped: 0, notAttempted: 0 } } }), { mode: 0o400 });
      return { status: state.childStatus, stdout: '{}', stderr: '' };
    },
  };
  return { dir, requestPath, request: final, deps, calls, state, authPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const launch = (ctx, argv = null, env = {}) => runLauncher(argv ?? [ctx.request.operation, ctx.requestPath], env, ctx.deps);
const secretsIn = dir => readdirSync(dir).some(name => Object.values(SECRETS).some(secret => readFileSync(join(dir, name), 'utf8').includes(secret)));

test('observe: seals immutable, secret-free binding, output and receipt for a fully verified disposable target', async () => {
  const ctx = setup();
  try {
    const result = await launch(ctx);
    assert.equal(result.exitCode, 0, result.code); assert.equal(result.code, 'COMPLETED');
    assert.deepEqual(readdirSync(result.evidenceDir).sort(), ['binding.json', 'observed-manifest.json', 'receipt.json']);
    for (const name of readdirSync(result.evidenceDir)) assert.equal(statSync(join(result.evidenceDir, name)).mode & 0o777, 0o400, `${name} is read-only`);
    assert.equal(secretsIn(result.evidenceDir), false);
    const binding = JSON.parse(readFileSync(join(result.evidenceDir, 'binding.json'), 'utf8'));
    assert.equal(binding.postgres.systemIdentifier, ctx.request.postgres.expectedSystemIdentifier); assert.equal(binding.postgres.migrationCount, 25);
    assert.equal(binding.postgres.m24.checksum, FROZEN_MIGRATIONS.m24.checksum); assert.equal(binding.postgres.m25.checksum, FROZEN_MIGRATIONS.m25.checksum);
    assert.equal(binding.postgres.schemaEntries, 1842); assert.equal(binding.postgres.schemaManifestSha256, SCHEMA_SHA);
    assert.equal(binding.storage.bucket, 'g1-abc'); assert.match(binding.storage.configFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(binding.resolverSubject, 'system:phase029-backfill:run-20261006-abcd'); assert.equal(binding.manifests, null);
    assert.deepEqual(binding.implementation, implementation()); assert.equal(binding.evidenceDir.realpath, result.evidenceDir);
    const receipt = JSON.parse(readFileSync(join(result.evidenceDir, 'receipt.json'), 'utf8'));
    assert.equal(receipt.binding.sha256, sha256(readFileSync(join(result.evidenceDir, 'binding.json'), 'utf8'))); assert.equal(receipt.implementationStable, true);
    assert.deepEqual(receipt.counts, { candidates: 1, rejected: 0 });
    // the child ran exactly twice (storage identity, then the operation), both fenced to the two bound endpoints, with no database URL leaked into its arguments
    assert.deepEqual(ctx.calls.child.map(spec => spec.env.BACKFILL_OPERATION), ['identity', 'observe']);
    for (const spec of ctx.calls.child) { assert.deepEqual(JSON.parse(spec.env.BACKFILL_ALLOWED_ENDPOINTS), ['127.0.0.1:55461', '127.0.0.1:55462']); assert.ok(spec.args.some(arg => arg.endsWith('maintenance-fence.cjs'))); assert.equal(spec.args.join(' ').includes(SECRETS.dbPassword), false); }
    assert.equal(ctx.calls.disposable, 1); assert.equal(ctx.calls.db, 1);
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

const REFUSALS = {
  'inherited DATABASE_URL': [{}, ctx => launch(ctx, null, { DATABASE_URL: 'postgresql://x' }), 'AMBIGUOUS_TARGET_ENVIRONMENT'],
  'inherited PGHOST': [{}, ctx => launch(ctx, null, { PGHOST: 'db' }), 'AMBIGUOUS_TARGET_ENVIRONMENT'],
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
  'malformed run token': [{ mutateRequest: r => ({ ...r, runToken: 'cmuvg0zar000010uwqzkhidz1:user' }) }, ctx => launch(ctx), 'RUN_TOKEN_INVALID'],
  'history not 25 entries': [{ mutateRequest: r => { r.postgres.expectedHistory = r.postgres.expectedHistory.slice(0, 24); return r; } }, ctx => launch(ctx), 'REQUEST_HISTORY_INVALID'],
  'schema entry pin wrong': [{ mutateRequest: r => { r.postgres.expectedSchemaEntries = 1841; return r; } }, ctx => launch(ctx), 'REQUEST_SCHEMA_PIN_INVALID'],
  'implementation file hash differs': [{}, ctx => { ctx.state.implementation.files['apps/web/src/lib/datasets/modality-backfill.ts'] = hex('edited'); return launch(ctx); }, 'IMPLEMENTATION_HASH_MISMATCH'],
  'launcher itself differs': [{}, ctx => { ctx.state.implementation.files['scripts/db-safety/backfill-launcher.mjs'] = hex('edited'); return launch(ctx); }, 'IMPLEMENTATION_HASH_MISMATCH'],
  'implementation file set differs': [{}, ctx => { delete ctx.state.implementation.files['apps/web/scripts/backfill-run.ts']; return launch(ctx); }, 'IMPLEMENTATION_FILE_SET_MISMATCH'],
  'generated client differs': [{}, ctx => { ctx.state.implementation.clientTreeSha256 = hex('other'); return launch(ctx); }, 'GENERATED_CLIENT_MISMATCH'],
  'migration chain differs': [{}, ctx => { ctx.state.implementation.migrationsTreeSha256 = hex('other'); return launch(ctx); }, 'MIGRATION_CHAIN_MISMATCH'],
  'wrong system identifier': [{}, ctx => { ctx.state.dbObserved.systemIdentifier = '1111111111111111111'; return launch(ctx); }, 'SYSTEM_IDENTITY_MISMATCH'],
  'wrong database name': [{}, ctx => { ctx.state.dbObserved.database = 'other'; return launch(ctx); }, 'SYSTEM_IDENTITY_MISMATCH'],
  'history checksum differs': [{}, ctx => { ctx.state.dbObserved.history[3] = { ...ctx.state.dbObserved.history[3], checksum: hex('x') }; return launch(ctx); }, 'HISTORY_MISMATCH'],
  'history has 24 migrations': [{}, ctx => { ctx.state.dbObserved.history = ctx.state.dbObserved.history.slice(0, 24); return launch(ctx); }, 'HISTORY_COUNT_MISMATCH'],
  'a migration is unfinished': [{}, ctx => { ctx.state.dbObserved.history = ctx.state.dbObserved.history.map((row, i) => ({ ...row, finished: i !== 10, rolledBack: false })); return launch(ctx); }, 'HISTORY_INCOMPLETE'],
  'a migration is rolled back': [{}, ctx => { ctx.state.dbObserved.history = ctx.state.dbObserved.history.map((row, i) => ({ ...row, finished: true, rolledBack: i === 5 })); return launch(ctx); }, 'HISTORY_INCOMPLETE'],
  'schema manifest differs (drift)': [{}, ctx => { ctx.state.dbObserved.schemaManifestSha256 = hex('drift'); return launch(ctx); }, 'SCHEMA_MANIFEST_MISMATCH'],
  'schema entry count differs': [{}, ctx => { ctx.state.dbObserved.schemaEntries = 1841; return launch(ctx); }, 'SCHEMA_ENTRY_COUNT_MISMATCH'],
  'disposable run against the application system': [{ mutateRequest: r => { r.postgres.expectedSystemIdentifier = APPLICATION_SYSTEM; return r; } }, ctx => { ctx.state.dbObserved.systemIdentifier = APPLICATION_SYSTEM; return launch(ctx); }, 'APPLICATION_SYSTEM_FORBIDDEN_FOR_DISPOSABLE'],
  'disposable URL not loopback': [{ mutateRequest: r => { r.postgres.url = `postgresql://postgres:${SECRETS.dbPassword}@db.internal:55461/fieldframe`; return r; } }, ctx => launch(ctx), 'DISPOSABLE_TARGET_REQUIRED'],
  'URL port differs from the pinned container': [{ mutateRequest: r => { r.disposablePins.postgres.port = 55469; return r; } }, ctx => launch(ctx), 'URL_CONTAINER_MISMATCH'],
  'storage endpoint differs from the expected one': [{ mutateRequest: r => { r.storage.expectedEndpoint = 'http://127.0.0.1:55470'; return r; } }, ctx => launch(ctx), 'STORAGE_TARGET_MISMATCH'],
  'bucket differs from the expected one': [{ mutateRequest: r => { r.storage.expectedBucket = 'g1-other'; return r; } }, ctx => launch(ctx), 'STORAGE_TARGET_MISMATCH'],
  'storage endpoint is not the pinned container': [{ mutateRequest: r => { r.storage.endpoint = r.storage.expectedEndpoint = 'http://127.0.0.1:55470'; return r; } }, ctx => launch(ctx), 'DISPOSABLE_STORAGE_REQUIRED'],
  'storage bucket is not a disposable bucket': [{ mutateRequest: r => { r.storage.bucket = r.storage.expectedBucket = 'annotation-assets'; return r; } }, ctx => launch(ctx), 'DISPOSABLE_STORAGE_REQUIRED'],
  'storage unavailable': [{}, ctx => { ctx.state.identityFailure = true; return launch(ctx); }, 'STORAGE_UNAVAILABLE'],
  'bucket does not exist': [{}, ctx => { ctx.state.storage = { endpointHost: '127.0.0.1', endpointPort: 55462, useSSL: false, bucket: 'g1-abc', bucketExists: false, configFingerprint: hex('c') }; return launch(ctx); }, 'STORAGE_IDENTITY_MISMATCH'],
  'storage answers from a different port': [{}, ctx => { ctx.state.storage = { endpointHost: '127.0.0.1', endpointPort: 55471, useSSL: false, bucket: 'g1-abc', bucketExists: true, configFingerprint: hex('c') }; return launch(ctx); }, 'STORAGE_IDENTITY_MISMATCH'],
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
      assert.equal(existsSync(join(ctx.request.evidenceDir, 'binding.json')), false, 'no binding was sealed');
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

test('shared-dev kind: refused while disabled; when enabled (offline fakes only) it needs an exact, unexpired authorization for this run', async () => {
  assert.equal(SHARED_DEV_ENABLED, false, 'shared-dev execution is not enabled in the committed launcher');
  const ok = setup({ kind: 'shared-dev', operation: 'apply', sharedDevEnabled: true });
  try { const result = await launch(ok); assert.equal(result.exitCode, 0, 'shared-dev enabled run: ' + result.code); assert.equal(JSON.parse(readFileSync(join(result.evidenceDir, 'binding.json'), 'utf8')).targetKind, 'shared-dev'); } finally { ok.cleanup(); }
  const cases = {
    'authorization hash differs': [ctx => writeFileSync(ctx.authPath, JSON.stringify({ tampered: true })), 'AUTHORIZATION_HASH_MISMATCH'],
    'authorization readable by others': [ctx => chmodSync(ctx.authPath, 0o644), 'AUTHORIZATION_FILE_NOT_PRIVATE'],
  };
  for (const [label, [mutate, expected]] of Object.entries(cases)) {
    const ctx = setup({ kind: 'shared-dev', operation: 'apply', sharedDevEnabled: true });
    try { mutate(ctx); const result = await launch(ctx); assert.equal(result.code, expected, label); assert.equal(ctx.calls.db, 0, 'no database probe before authorization'); } finally { ctx.cleanup(); }
  }
  const request = setup({ kind: 'shared-dev', operation: 'apply', sharedDevEnabled: true });
  try {
    const record = JSON.parse(readFileSync(request.authPath, 'utf8'));
    const bad = { 'other run': { ...record, runToken: 'run-other-00001' }, 'other system': { ...record, systemIdentifier: '1111111111111111111' }, 'other manifest': { ...record, approvedManifestSha256: hex('z') }, 'other bucket': { ...record, bucket: 'elsewhere' }, 'other operation': { ...record, operation: 'observe' },
      expired: { ...record, issuedAt: new Date(Date.now() - 7200000).toISOString(), expiresAt: new Date(Date.now() - 3600000).toISOString() }, 'longer than 4h': { ...record, expiresAt: new Date(Date.now() + 5 * 3600000).toISOString() }, 'extra key': { ...record, extra: 1 } };
    for (const [label, value] of Object.entries(bad)) assert.throws(() => validateAuthorization(value, request.request), /^Error: AUTHORIZATION_/, label);
    assert.doesNotThrow(() => validateAuthorization(record, request.request));
  } finally { request.cleanup(); }
  const wrongSystem = setup({ kind: 'shared-dev', operation: 'observe', sharedDevEnabled: true, mutateRequest: r => { r.postgres.expectedSystemIdentifier = '1111111111111111111'; return r; } });
  try { const result = await launch(wrongSystem); assert.ok(['AUTHORIZATION_SCOPE_MISMATCH'].includes(result.code), result.code); } finally { wrongSystem.cleanup(); }
});

test('ambient rules and request validation are exact', () => {
  assert.doesNotThrow(() => assertNoAmbientTargets({ PATH: '/usr/bin', HOME: '/home/x', LANG: 'C', TMPDIR: '/tmp' }));
  for (const key of ['DATABASE_URL', 'PGPASSWORD', 'PGHOST', 'REDIS_URL', 'MINIO_ROOT_USER', 'S3_ENDPOINT', 'STORAGE_BUCKET', 'BACKFILL_OPERATION', 'DB_SAFETY_RECEIPT', 'G1_RUNTIME_ROLE', 'NODE_OPTIONS', 'BULLMQ_PREFIX']) assert.throws(() => assertNoAmbientTargets({ [key]: 'x' }), /AMBIGUOUS_TARGET_ENVIRONMENT/, key);
  assert.doesNotThrow(() => assertNoAmbientTargets({ DATABASE_URL: '' }));
  assert.throws(() => validateRequest({}), /REQUEST_SHAPE_INVALID|REQUEST_SCHEMA_UNSUPPORTED/);
});

test('the real implementation set: every pinned file exists, is hashed, and the schema-manifest extractor matches the disposable runner', async () => {
  const root = new URL('../../..', import.meta.url).pathname;
  const implementationNow = computeImplementation(root);
  assert.deepEqual(Object.keys(implementationNow.files).sort(), [...IMPLEMENTATION_FILES].sort());
  assert.ok(Object.values(implementationNow.files).every(hash => /^[0-9a-f]{64}$/.test(hash)));
  assert.equal(implementationNow.files[`prisma/migrations/${FROZEN_MIGRATIONS.m24.name}/migration.sql`], FROZEN_MIGRATIONS.m24.checksum);
  assert.equal(implementationNow.files[`prisma/migrations/${FROZEN_MIGRATIONS.m25.name}/migration.sql`], FROZEN_MIGRATIONS.m25.checksum);
  const disposable = await import('../disposable-test.mjs');
  assert.equal(manifestSql(root), disposable.releaseManifestSqlFrom(join(root, disposable.RECOVERY_REVIEW.path)));
});

test('the launcher reads no environment target, no .env file, runs only the pinned child, and writes evidence exclusively', () => {
  const launcher = readFileSync(new URL('../backfill-launcher.mjs', import.meta.url), 'utf8');
  const binding = readFileSync(new URL('../backfill-binding.mjs', import.meta.url), 'utf8');
  for (const text of [launcher, binding]) { assert.doesNotMatch(text, /dotenv|\.env['"`\b]|--env-file|loadEnvFile/); assert.doesNotMatch(text, /process\.env\.(DATABASE_URL|PG|MINIO|S3|AWS|REDIS)/); }
  assert.match(launcher, /assertNoAmbientTargets\(env\)/); assert.match(launcher, /export const SHARED_DEV_ENABLED = false;/);
  assert.match(binding, /'wx'/, 'evidence is created exclusively'); assert.match(binding, /0o400/);
  const spawns = [...launcher.matchAll(/spawnSync\(([^,]+),/g)].map(match => match[1].trim());
  assert.deepEqual(spawns, ["'psql'", 'process.execPath'], 'only a read-only psql probe and the fenced node child are ever spawned');
  assert.match(launcher, /default_transaction_read_only=on/);
  const child = readFileSync(new URL('../../../apps/web/scripts/backfill-run.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(child, /process\.env\.DATABASE_URL|dotenv|loadEnvFile|--env-file|\.env['"`]/);
});
