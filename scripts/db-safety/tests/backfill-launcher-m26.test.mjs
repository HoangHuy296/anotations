import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runLauncher } from '../backfill-launcher.mjs';
import {
  APPLICATION_SYSTEM, CREDENTIALS_SCHEMA, FROZEN_M26, FROZEN_MIGRATIONS, IMPLEMENTATION_FILES, OPERATIONS, OP_PROFILE, REQUEST_SCHEMA, TARGET_KINDS, assertDatabaseTarget, assertHistory, assertM26Delta,
  assertMigrationDelta, assertTablesUnchanged, historyDigest, loadCredentials, manifestDigest, profileFor, sha256, validateRequest,
} from '../backfill-binding.mjs';

// Offline: the database probe, the container proof and the child are injected. Nothing here touches Docker, PostgreSQL, storage or any real target.
const REPO = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const hex = text => createHash('sha256').update(text).digest('hex');
const ADDED = JSON.parse(readFileSync(new URL('./fixtures/m26-added-entries.json', import.meta.url), 'utf8')).entries;
const COPY_SYSTEM = '7694969289833033762';
const names = Array.from({ length: 23 }, (_, index) => `2026010${String(index).padStart(2, '0')}000000_m${index}`);
const history = count => [...names.map((name, index) => ({ name, checksum: hex(`m${index}`) })), { name: FROZEN_MIGRATIONS.m24.name, checksum: FROZEN_MIGRATIONS.m24.checksum }, { name: FROZEN_MIGRATIONS.m25.name, checksum: FROZEN_MIGRATIONS.m25.checksum }, { name: FROZEN_M26.name, checksum: FROZEN_M26.checksum }].slice(0, count);
const observedHistory = count => history(count).map(row => ({ ...row, finished: true, rolledBack: false }));
const base = () => Array.from({ length: 1842 }, (_, index) => ['relation', JSON.stringify(['public', `t${index}`]), [index]]);
const withM26 = (rows = base()) => [...rows, ...ADDED.map(([kind, identity]) => [kind, identity, ['d']])];
const TABLES = [['Asset', 3, hex('asset')], ['Dataset', 5, hex('dataset')], ['User', 1, hex('user')]];
const implementation = () => ({ files: Object.fromEntries(IMPLEMENTATION_FILES.map(file => [file, hex(file)])), clientTreeSha256: hex('client'), migrationsTreeSha256: hex('chain') });

test('the M26 constants are the real migration: bytes, position 26, and the exact reviewed delta size', () => {
  assert.equal(sha256(readFileSync(join(REPO, 'prisma/migrations', FROZEN_M26.name, 'migration.sql'))), FROZEN_M26.checksum);
  const chain = readdirSync(join(REPO, 'prisma/migrations')).filter(name => /^\d{14}_/.test(name)).sort();
  assert.equal(chain.length, 26); assert.equal(chain[25], FROZEN_M26.name); assert.equal(chain[24], FROZEN_MIGRATIONS.m25.name);
  assert.equal(ADDED.length, FROZEN_M26.added); assert.equal(FROZEN_M26.entriesAfter - FROZEN_M26.entriesBefore, FROZEN_M26.added);
  assert.ok(IMPLEMENTATION_FILES.includes(`prisma/migrations/${FROZEN_M26.name}/migration.sql`), 'the M26 bytes are part of the pinned implementation');
  assert.deepEqual(OPERATIONS.filter(op => op.startsWith('migrate-')), ['migrate-m24', 'migrate-m25', 'migrate-m26']);
  assert.ok(TARGET_KINDS.includes('copy'));
});

test('chain-aware profiles: observe/apply accept 25 or 26 migrations and nothing else; migrate-m26 starts from exactly 25', () => {
  for (const op of ['observe', 'apply']) {
    assert.deepEqual([profileFor(op, 25).history, profileFor(op, 25).entries], [25, 1842]);
    assert.deepEqual([profileFor(op, 26).history, profileFor(op, 26).entries], [26, 1942]);
    for (const bad of [23, 24, 27, 0]) assert.throws(() => profileFor(op, bad), /REQUEST_POSTGRES_INVALID/);
  }
  assert.deepEqual([OP_PROFILE['migrate-m26'].history, OP_PROFILE['migrate-m26'].after.history, OP_PROFILE['migrate-m26'].after.entries], [25, 26, 1942]);
  assert.equal(profileFor('migrate-m26', 25), OP_PROFILE['migrate-m26']);
});

test('history: a 26-row history must end with the frozen M26 bytes; M26 may not appear in a 25-row history', () => {
  assertHistory(history(26), observedHistory(26), 26);
  assert.throws(() => assertHistory(history(26), observedHistory(26).map((row, i) => (i === 25 ? { ...row, checksum: hex('tampered') } : row)), 26), /HISTORY_MISMATCH/);
  const renamed = observedHistory(26).map((row, i) => (i === 25 ? { ...row, name: '20261007000000_other' } : row));
  assert.throws(() => assertHistory(renamed.map(({ name, checksum }) => ({ name, checksum })), renamed, 26), /FROZEN_MIGRATION_MISMATCH/);
  const early = [...observedHistory(24), { name: FROZEN_M26.name, checksum: FROZEN_M26.checksum, finished: true, rolledBack: false }];
  assert.throws(() => assertHistory(early.map(({ name, checksum }) => ({ name, checksum })), early, 25), /FROZEN_MIGRATION_MISMATCH/);
  assert.throws(() => assertHistory(history(26), observedHistory(26).map((row, i) => (i === 25 ? { ...row, finished: false } : row)), 26), /HISTORY_INCOMPLETE/);
});

test('the M26 delta is exact: 100 pinned additions, nothing removed, nothing changed', () => {
  const pre = base(), post = withM26(pre);
  const result = assertMigrationDelta('migrate-m26', pre, post);
  assert.deepEqual(result, assertM26Delta(pre, post)); assert.equal(result.added, 100); assert.equal(result.removed, 0); assert.equal(result.changed, 0); assert.equal(result.kinds.column, 58);
  const faults = {
    'one addition missing': [pre, post.slice(0, -1), /MIGRATION_SCHEMA_DELTA_UNEXPECTED/],
    'one extra addition': [pre, [...post, ['index', '["public","extra"]', 'i']], /MIGRATION_SCHEMA_DELTA_UNEXPECTED/],
    'a different addition of the same count': [pre, [...post.slice(0, -1), ['column', '["public","Dataset","sneaky"]', 'c']], /MIGRATION_SCHEMA_DELTA_UNEXPECTED/],
    'an existing entry changed': [pre, post.map((row, i) => (i === 7 ? [row[0], row[1], ['changed']] : row)), /MIGRATION_CHANGED_EXISTING_SCHEMA/],
    'an existing entry removed': [pre, [...post.slice(1), ['relation', '["public","replacement"]', [0]]], /MIGRATION_CHANGED_EXISTING_SCHEMA/],
    'wrong starting size': [pre.slice(1), withM26(pre.slice(1)), /MIGRATION_SCHEMA_DELTA_UNEXPECTED/],
    'duplicate identity': [[...pre, pre[0]], post, /MANIFEST_DUPLICATE_IDENTITY/],
  };
  for (const [label, [a, b, error]] of Object.entries(faults)) assert.throws(() => assertMigrationDelta('migrate-m26', a, b), error, label);
});

test('tables: M26 may add only the empty MediaVerification table; every existing table must be identical', () => {
  const post = [...TABLES, ['MediaVerification', 0, hex('')]].sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(assertTablesUnchanged(TABLES, post, FROZEN_M26.newTables), { tables: 3, newTables: ['MediaVerification'] });
  assert.throws(() => assertTablesUnchanged(TABLES, [...TABLES, ['MediaVerification', 2, hex('x')]], FROZEN_M26.newTables), /MIGRATION_TABLE_SET_CHANGED/, 'the new table must be empty');
  assert.throws(() => assertTablesUnchanged(TABLES, [...TABLES, ['MediaVerification', 0, hex('')], ['Surprise', 0, hex('')]], FROZEN_M26.newTables), /MIGRATION_TABLE_SET_CHANGED/);
  assert.throws(() => assertTablesUnchanged(TABLES, [...TABLES], FROZEN_M26.newTables), /MIGRATION_TABLE_SET_CHANGED/, 'the expected table must actually appear');
  assert.throws(() => assertTablesUnchanged(TABLES, [['Asset', 3, hex('asset')], ['Dataset', 6, hex('other')], ['User', 1, hex('user')], ['MediaVerification', 0, hex('')]], FROZEN_M26.newTables), /MIGRATION_DATA_CHANGED/);
  assert.throws(() => assertTablesUnchanged(TABLES, [...TABLES, ['MediaVerification', 0, hex('')]]), /MIGRATION_TABLE_SET_CHANGED/, 'M24/M25 (no new tables) still refuse any new table');
});

const copyRequest = (operation, mutate = r => r) => {
  const profile = profileFor(operation, operation === 'migrate-m26' ? 25 : 26);
  const count = profile.history;
  const request = {
    schema: REQUEST_SCHEMA, operation, targetKind: 'copy', requestId: randomUUID(), issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), runToken: 'run-20261010-copy',
    evidenceDir: '/tmp/x', postgres: { host: '127.0.0.1', port: 55481, database: 'fieldframe', user: 'fieldframe', expectedSystemIdentifier: COPY_SYSTEM, expectedHistory: history(count), expectedSchemaManifestSha256: hex('schema'), expectedSchemaEntries: profile.entries },
    ...(profile.storage ? { storage: { endpoint: 'http://127.0.0.1:59210', bucket: 'annotation-assets', expectedEndpoint: 'http://127.0.0.1:59210', expectedBucket: 'annotation-assets' } } : {}),
    credentials: { path: '/tmp/c', sha256: hex('c') }, implementation: implementation(), manifests: profile.manifests ? { observedPath: '/tmp/o', observedSha256: hex('o'), approvedPath: '/tmp/a', approvedSha256: hex('a') } : {},
    copyPins: { postgres: { container: 'devcopy-postgres-1', id: 'a'.repeat(64) }, ...(profile.storage ? { minio: { container: 'devcopy-minio-1', id: 'b'.repeat(64) } } : {}) },
  };
  return mutate(request) ?? request;
};

test('request validation: a copy request carries container pins and no authorization; observe/apply accept the 26-chain; the unsupported lengths keep their specific refusal', () => {
  for (const op of ['observe', 'apply', 'migrate-m26']) assert.equal(validateRequest(copyRequest(op)).targetKind, 'copy', op);
  assert.throws(() => validateRequest(copyRequest('observe', r => ({ ...r, authorization: { path: '/tmp/a', sha256: hex('a') } }))), /REQUEST_PINS_INVALID/);
  assert.throws(() => validateRequest(copyRequest('observe', r => ({ ...r, sharedDevPins: r.copyPins }))), /REQUEST_PINS_INVALID/);
  assert.throws(() => validateRequest(copyRequest('observe', r => { delete r.copyPins; return r; })), /REQUEST_PINS_INVALID/);
  assert.throws(() => validateRequest(copyRequest('observe', r => ({ ...r, copyPins: { ...r.copyPins, minio: undefined } }))), /REQUEST_PINS_INVALID/);
  assert.throws(() => validateRequest(copyRequest('migrate-m26', r => ({ ...r, copyPins: { ...r.copyPins, minio: { container: 'devcopy-minio-1', id: 'b'.repeat(64) } } }))), /REQUEST_PINS_INVALID/, 'a migration step has no storage target');
  assert.throws(() => validateRequest(copyRequest('observe', r => ({ ...r, copyPins: { postgres: { container: 'x y', id: 'a'.repeat(64) }, minio: r.copyPins.minio } }))), /REQUEST_PINS_INVALID/);
  assert.throws(() => validateRequest(copyRequest('observe', r => ({ ...r, postgres: { ...r.postgres, expectedHistory: history(24), expectedSchemaEntries: 1842 } }))), /REQUEST_HISTORY_INVALID/);
  assert.throws(() => validateRequest(copyRequest('observe', r => ({ ...r, postgres: { ...r.postgres, expectedSchemaEntries: 1842 } }))), /REQUEST_SCHEMA_PIN_INVALID/, '26 rows with the 25-chain entry count');
  assert.throws(() => validateRequest(copyRequest('observe', r => ({ ...r, targetKind: 'disposable', disposablePins: { postgres: { port: 55461 }, minio: { port: 55462 } } }))), /REQUEST_PINS_INVALID/, 'a disposable request may not also carry copy pins');
});

test('target rules: a copy is loopback, named like the application database, and never the shared-dev system', () => {
  const ok = copyRequest('observe'), observed = { systemIdentifier: COPY_SYSTEM, database: 'fieldframe' };
  assert.doesNotThrow(() => assertDatabaseTarget(ok, observed));
  assert.throws(() => assertDatabaseTarget(copyRequest('observe', r => ({ ...r, postgres: { ...r.postgres, expectedSystemIdentifier: APPLICATION_SYSTEM } })), { systemIdentifier: APPLICATION_SYSTEM, database: 'fieldframe' }), /APPLICATION_SYSTEM_FORBIDDEN_FOR_COPY/);
  assert.throws(() => assertDatabaseTarget(copyRequest('observe', r => ({ ...r, postgres: { ...r.postgres, host: '10.0.0.5' } })), observed), /COPY_TARGET_REQUIRED/);
  assert.throws(() => assertDatabaseTarget(copyRequest('observe', r => ({ ...r, postgres: { ...r.postgres, database: 'postgres' } })), { ...observed, database: 'postgres' }), /COPY_TARGET_REQUIRED/);
  assert.throws(() => assertDatabaseTarget(ok, { ...observed, systemIdentifier: '7694969289833033763' }), /SYSTEM_IDENTITY_MISMATCH/);
});

function launch26(operation, { mutateState = () => {}, system = COPY_SYSTEM, datasets = { total: 120, unresolved: 120, resolved: 0, live: 75 } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bl26-test-'));
  const evidenceRoot = join(dir, 'evidence-root'); mkdirSync(evidenceRoot, { mode: 0o700 });
  const credDir = join(dir, 'private'); mkdirSync(credDir, { mode: 0o700 });
  const credPath = join(credDir, 'maintenance.credentials.json');
  const credText = JSON.stringify({ schema: CREDENTIALS_SCHEMA, postgresPassword: 's3cr3t-db-password' }); writeFileSync(credPath, credText, { mode: 0o600 });
  const pre = base(), post = withM26(pre);
  const request = copyRequest(operation, r => ({ ...r, evidenceDir: join(evidenceRoot, 'run-1'), credentials: { path: credPath, sha256: sha256(credText) }, postgres: { ...r.postgres, expectedSystemIdentifier: system, expectedSchemaManifestSha256: manifestDigest(pre) } }));
  const requestPath = join(dir, 'request.json'); writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
  const state = { db: { systemIdentifier: system, database: 'fieldframe', history: observedHistory(25), manifestRows: pre, schemaEntries: pre.length, schemaManifestSha256: manifestDigest(pre), datasets: { ...datasets }, tables: TABLES.map(row => [...row]) }, migrationStatus: 0 };
  const calls = { migrations: 0, targets: 0 };
  const deps = {
    root: REPO, now: () => Date.now(), sharedDevEnabled: false, evidenceRoots: () => [evidenceRoot], computeImplementation: () => implementation(), loadCredentials: r => loadCredentials(r, REPO),
    verifyTarget: async () => { calls.targets += 1; return { postgres: { container: 'devcopy-postgres-1', id: 'a'.repeat(64), systemIdentifier: system } }; },
    probeDatabase: () => structuredClone(state.db),
    runMigration: () => { calls.migrations += 1; state.db = { ...state.db, history: observedHistory(26), manifestRows: post, schemaEntries: post.length, schemaManifestSha256: manifestDigest(post), tables: [...TABLES.map(row => [...row]), ['MediaVerification', 0, hex('')]] }; mutateState(state); return { status: state.migrationStatus, output: 'Applying migration\n' }; },
    spawnChild: () => ({ status: 1, stdout: '', stderr: 'unused' }),
  };
  return { request, requestPath, deps, state, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const run = ctx => runLauncher([ctx.request.operation, ctx.requestPath], {}, ctx.deps);

test('migrate-m26 on a copy: applies exactly one step, seals a COMPLETED receipt with the verified delta, and records the 26th migration', async () => {
  const ctx = launch26('migrate-m26');
  try {
    const result = await run(ctx);
    assert.equal(result.exitCode, 0, result.code); assert.equal(result.code, 'COMPLETED'); assert.equal(ctx.calls.migrations, 1); assert.equal(ctx.calls.targets, 1);
    const receipt = JSON.parse(readFileSync(join(result.evidenceDir, 'receipt.json'), 'utf8')), verification = JSON.parse(readFileSync(join(result.evidenceDir, 'verification.json'), 'utf8'));
    assert.equal(receipt.targetKind, 'copy'); assert.equal(receipt.postState.migrationCount, 26); assert.equal(receipt.postState.schemaEntries, 1942); assert.equal(receipt.authorizationSha256, null);
    assert.equal(verification.delta.added, 100); assert.deepEqual(verification.tables.newTables, ['MediaVerification']); assert.equal(verification.historyMatchesExpected, true);
    const binding = JSON.parse(readFileSync(join(result.evidenceDir, 'binding.json'), 'utf8'));
    assert.equal(binding.postgres.migrationCount, 25); assert.equal(binding.postgres.m26, null, 'bound BEFORE the step: M26 is not yet applied');
    assert.ok(!readdirSync(result.evidenceDir).some(name => readFileSync(join(result.evidenceDir, name), 'utf8').includes('s3cr3t-db-password')));
  } finally { ctx.cleanup(); }
});

test('migrate-m26 on a copy may run after a backfill: resolved Datasets are allowed but must be left exactly as they were', async () => {
  const resolved = { total: 120, unresolved: 53, resolved: 67, live: 75 };
  const ok = launch26('migrate-m26', { datasets: resolved });
  try { assert.equal((await run(ok)).exitCode, 0); } finally { ok.cleanup(); }
  const changed = launch26('migrate-m26', { datasets: resolved, mutateState: state => { state.db.datasets = { ...resolved, resolved: 68, unresolved: 52 }; } });
  try {
    const result = await run(changed);
    assert.equal(result.exitCode, 1); assert.equal(JSON.parse(readFileSync(join(result.evidenceDir, 'receipt.json'), 'utf8')).childFailureCode, 'MIGRATION_DATASETS_RESOLVED');
  } finally { changed.cleanup(); }
});

const M26_FAULTS = {
  'an unexpected extra schema object': [s => { s.db.manifestRows = [...s.db.manifestRows, ['index', '["public","x"]', 'i']]; s.db.schemaEntries += 1; s.db.schemaManifestSha256 = manifestDigest(s.db.manifestRows); }, 'MIGRATION_SCHEMA_DELTA_UNEXPECTED'],
  'an existing table row fingerprint changed': [s => { s.db.tables[1] = ['Dataset', 6, hex('d2')]; }, 'MIGRATION_DATA_CHANGED'],
  'the new table is not empty': [s => { s.db.tables[3] = ['MediaVerification', 1, hex('x')]; }, 'MIGRATION_TABLE_SET_CHANGED'],
  'history did not gain the frozen row': [s => { s.db.history = observedHistory(25); }, 'HISTORY_COUNT_MISMATCH'],
  'wrong checksum recorded for M26': [s => { s.db.history = observedHistory(26).map((row, i) => (i === 25 ? { ...row, checksum: hex('wrong') } : row)); }, 'HISTORY_MISMATCH'],
};
for (const [label, [fault, expected]] of Object.entries(M26_FAULTS)) test(`migrate-m26 verification fails closed (${label}) with ${expected}`, async () => {
  const ctx = launch26('migrate-m26', { mutateState: fault });
  try {
    const result = await run(ctx);
    assert.equal(result.exitCode, 1, label); const receipt = JSON.parse(readFileSync(join(result.evidenceDir, 'receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'FAILED'); assert.equal(receipt.childFailureCode, expected); assert.equal(receipt.postState, null); assert.equal(ctx.calls.migrations, 1, 'never retried');
  } finally { ctx.cleanup(); }
});

test('refusals happen before anything is probed or run: the shared-dev system id on a copy request, a pre-state that is not 25 migrations', async () => {
  const wrongSystem = launch26('migrate-m26', { system: APPLICATION_SYSTEM });
  try { const r = await run(wrongSystem); assert.equal(r.exitCode, 1); assert.match(r.code, /APPLICATION_SYSTEM_FORBIDDEN_FOR_COPY/); assert.equal(wrongSystem.calls.migrations, 0); } finally { wrongSystem.cleanup(); }
  const wrongPre = launch26('migrate-m26');
  try { wrongPre.state.db.history = observedHistory(26); const r = await run(wrongPre); assert.equal(r.exitCode, 1); assert.equal(wrongPre.calls.migrations, 0); assert.match(r.code, /HISTORY_(COUNT_)?MISMATCH/); } finally { wrongPre.cleanup(); }
});

test('source contract: the copy proof checks the compose project, devcopy_ volumes, loopback bindings and the container control file; the real shared-dev switch is still off', () => {
  const launcher = readFileSync(join(REPO, 'scripts/db-safety/backfill-launcher.mjs'), 'utf8');
  const body = launcher.slice(launcher.indexOf('function verifyCopyTarget'), launcher.indexOf('async function verifyDisposableTarget'));
  for (const required of ["'com.docker.compose.project'] === 'devcopy'", '/^devcopy_[a-z0-9-]+$/', "bind.HostIp === '127.0.0.1'", 'pgControlIdentifier(request.copyPins.postgres.container)', 'COPY_VOLUME_NOT_ISOLATED', 'COPY_PROJECT_MISMATCH']) assert.ok(body.includes(required), required);
  assert.match(launcher, /export const SHARED_DEV_ENABLED = false;/);
  assert.ok(!/SHARED_DEV_ENABLED = true/.test(launcher));
});
