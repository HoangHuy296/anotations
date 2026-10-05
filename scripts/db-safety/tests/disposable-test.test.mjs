import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as guard from '../guard.mjs';
import { loadExpectations } from '../cleanup-verify.mjs';
import { isDeepStrictEqual } from 'node:util';
import {
  SUPPORTED_COMMANDS, PROPOSAL_CHAIN, REHEARSALS, REHEARSAL_ID, FIXTURE_COMMAND, FIXTURE_FILE, FIXTURE_SPEC, FIXTURE_ROWS, HISTORY_SQL,
  RELEASE_ID, RELEASE_COUNTS, RELEASE_SPECS, RELEASE_TOPOLOGY, RECOVERY_REVIEW, assertRelease24, assertRelease25, manifestDiff, extractManifestSql, releaseManifestSqlFrom, releaseExtraSql, captureScript,
  realDeps, runFocusedTest, validateCommand, validateChain, checkHistory, assertMigration25, primaryCleanup, resolvePlan,
  COMPAT_ID, COMPAT_COMMAND, COMPAT_FILE, COMPAT_SPEC, COMPAT_BINDINGS, COMPATIBILITY, T015_ID, T015_COMMAND, T015_FILE, T015_SPEC, T015_ALLOWED_IMPORTS, INGEST_ID, INGEST_COMMAND, INGEST_FILE, INGEST_SPEC, INGEST_ALLOWED_IMPORTS, INGEST_ALLOWED_REQUIRES, verifyCompatBindings, scanCompatTestSource, assertCompatTestSource, assertCompatColumn,
} from '../disposable-test.mjs';
import { readTree, treeHash, CLIENT_DIR, SCHEMA_PATH, ENGINE_FILE } from '../prisma-client-stage.mjs';

// Offline only: a fake docker/node world, a temp repository fixture and fake identity/cleanup checkers.
// Nothing here starts Docker, PostgreSQL, Redis or MinIO or opens a network connection.
const COMMAND = 'web:test:dataset-metadata';
const sha = text => createHash('sha256').update(text).digest('hex');
const PROPOSAL1_SQL = '-- fake migration 24 bytes\n';
const PROPOSAL2_SQL = '-- fake migration 25 bytes\n';
const P1 = PROPOSAL_CHAIN[0], P2 = PROPOSAL_CHAIN[1];
const FAKE_CHAIN = [{ ...P1, sha256: sha(PROPOSAL1_SQL) }, { ...P2, sha256: sha(PROPOSAL2_SQL) }];
const CATALOG = { [COMMAND]: { kind: 'test' }, 'web:test:imports-ui:vitest': { kind: 'test' }, 'web:test:dataset-patch-route': { kind: 'test' }, 'web:test:local-folder-modality-idempotency': { kind: 'test' }, 'web:test:other': { kind: 'test' }, 'worker:test:ingestion-replay-reuse': { kind: 'test' }, ...RELEASE_SPECS, [FIXTURE_COMMAND]: FIXTURE_SPEC, [COMPAT_COMMAND]: COMPAT_SPEC, [T015_COMMAND]: T015_SPEC, [INGEST_COMMAND]: INGEST_SPEC };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dt-root-'));
  const put = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
  put('scripts/db-safety/commands.json', JSON.stringify(CATALOG));
  for (let index = 0; index < 23; index += 1) put(`prisma/migrations/2026010${String(index).padStart(2, '0')}_m/migration.sql`, `-- ${index}\n`);
  put('prisma/migrations/migration_lock.toml', 'provider = "postgresql"\n');
  put('prisma/schema.prisma', 'datasource db { url = env("DATABASE_URL") }\n');
  put(`${P1.path}/migration.sql`, PROPOSAL1_SQL);
  put(`${P2.path}/migration.sql`, PROPOSAL2_SQL);
  for (const file of ['scripts/db-safety/g2-generate.mjs', 'scripts/db-safety/g2-compatibility.mjs', 'apps/web/tests/dataset-modality/g2-baseline.test.ts', 'apps/web/tests/dataset-modality/g2-candidate.test.ts']) put(file, '// release step stub\n');
  put(FIXTURE_FILE, 'import "../../../../scripts/db-safety/test-entry.cjs"; // gate\n// fixture body\n');
  put('lib/generated/prisma/models/Dataset.ts', 'export type X = { modalityContentRevision: bigint }\n');
  for (const rel of ['internal/class.ts', 'internal/prismaNamespace.ts', 'internal/prismaNamespaceBrowser.ts', 'models/PreparedImport.ts']) put(`${CLIENT_DIR}/${rel}`, `generated ${rel}\n`);
  mkdirSync(join(root, CLIENT_DIR), { recursive: true });
  writeFileSync(join(root, CLIENT_DIR, ENGINE_FILE), Buffer.from([1, 2, 3, 4, 5]));
  put(COMPAT_FILE, readFileSync(join(guard.root, COMPAT_FILE), 'utf8'));
  put(T015_FILE, readFileSync(join(guard.root, T015_FILE), 'utf8'));
  put(INGEST_FILE, readFileSync(join(guard.root, INGEST_FILE), 'utf8'));
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  return root;
}
function compatBindingsFor(root) {
  const tree = readTree(join(root, CLIENT_DIR));
  const files = ['internal/class.ts', 'internal/prismaNamespace.ts', 'internal/prismaNamespaceBrowser.ts', 'models/PreparedImport.ts', ENGINE_FILE];
  return { schemaSha256: sha(readFileSync(join(root, SCHEMA_PATH))), generatedTreeSha256: treeHash(tree), generatedFiles: Object.fromEntries(files.map(file => [`${CLIENT_DIR}/${file}`, tree.get(file)])), activeChainTreeSha256: treeHash(readTree(join(root, 'prisma/migrations'))) };
}

function world(overrides = {}) {
  const root = overrides.root ?? fixture();
  const outBase = mkdtempSync(join(tmpdir(), 'dt-out-'));
  const registry = mkdtempSync(join(tmpdir(), 'dt-reg-'));
  const stages = [];
  const w = {
    root, outBase, registry, calls: [], containers: new Map(), stages, removed: [], systemIdentifier: '7000000000000000001',
    testExit: 0, compatExit: 0, onCompatTest: null, deployExit: 0, receiptMode: 'ok', cleanupVerifyStatus: 0, stageRemoveBlocked: false, rmStatus: 0,
    historyMutate: null, m25Mutation: null, fixtureExit: 0, failRunRole: null, failDeployAt: 0, failApproveAt: 0, deployCalls: 0, tamperLabelAfterProvision: false, sawEnv: [],
    ...overrides,
  };
  // A container from some other run/system that must never be touched.
  const foreign = { id: 'f'.repeat(64), name: 'phase029-g1-g3-00000000-postgres', labels: { 'annotation.safety': 'g1-disposable', 'annotation.role': 'postgres', 'annotation.run': '00000000' } };
  w.containers.set(foreign.id, foreign); w.foreign = foreign;
  let nextId = 1;
  const PREPARED_COLUMNS = ['id', 'datasetId', 'jobId', 'createdById', 'status', 'expectedItemCount', 'deadlineAt', 'committedAt', 'idempotencyKey', 'createdAt', 'updatedAt'].map((name, index) => ['PreparedImport', name, 'text', name === 'committedAt' ? 'YES' : 'NO', null, index + 1]);
  w.db = {
    columns: [...PREPARED_COLUMNS, ['Dataset', 'id', 'text', 'NO', null, 1]],
    indexes: [['PreparedImport', 'PreparedImport_pkey', 'CREATE UNIQUE INDEX "PreparedImport_pkey" ON public."PreparedImport" USING btree (id)']],
    constraints: [['PreparedImport', 'PreparedImport_pkey', 'p', 'PRIMARY KEY (id)']],
    triggers: [['Dataset', 'dataset_guard', 'CREATE TRIGGER dataset_guard BEFORE UPDATE ON "Dataset"']],
    routines: [['dataset_guard_fn', 'abc123']],
    enums: [['PreparedImportStatus', 'PREPARING'], ['PreparedImportStatus', 'COMMITTED'], ['PreparedImportStatus', 'EXPIRED']],
    tables: { Dataset: [0, 'empty'], PreparedImportItem: [0, 'empty'], User: [0, 'empty'] },
    manifest: Array.from({ length: RELEASE_COUNTS.baseline }, (_, index) => ['relation', JSON.stringify(['public', `t${index}`]), [index]]), datasets: [],
    preparedImport: [], migrations: [], tableList: ['Dataset', 'PreparedImport', 'PreparedImportItem', 'User', '_prisma_migrations'],
  };
  const deployFrom = receiptFile => {
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    for (const file of Object.keys(receipt.migrationHashes ?? {}).sort()) {
      const name = file.split('/').at(-2);
      if (w.db.migrations.some(row => row.migration_name === name)) continue;
      w.db.migrations.push({ id: `id-${w.db.migrations.length}`, checksum: sha(readFileSync(file)), finished_at: '2026-10-05T00:00:00.000Z', migration_name: name, logs: null, rolled_back_at: null, started_at: `2026-10-05T00:00:${String(w.db.migrations.length).padStart(2, '0')}.000Z`, applied_steps_count: 1 });
      if (name === P1.name) {
        w.db.manifest.push(...[['column', 'modality'], ['column', 'modalityContentRevision'], ['column', 'modalityResolvedAt'], ['column', 'modalityResolverSubject']].map(([kind, n]) => [kind, JSON.stringify(['public', 'Dataset', n]), ['x']]),
          ...['dataset_modality_resolution_shape', 'dataset_modality_revision_nonnegative'].map(n => ['constraint', JSON.stringify(['public', 'relation', '"Dataset"', n]), ['y']]),
          ...['asset_modality_write_guard', 'dataset_modality_assignment_guard', 'dataset_modality_insert_guard'].map(n => ['trigger', JSON.stringify(['public', 'Dataset', n]), ['z']]),
          ...['phase029_guard_asset_write()', 'phase029_guard_dataset_assignment()', 'phase029_guard_dataset_insert()'].map(n => ['routine', JSON.stringify(['public', n]), ['f']]));
        w.m24Mutation?.(w.db);
      }
      if (name === P2.name) {
        w.db.manifest.push(['column', JSON.stringify(['public', 'PreparedImport', 'creationRequestHash']), ['text']]);
        const max = Math.max(...w.db.columns.filter(row => row[0] === 'PreparedImport').map(row => row[5]));
        w.db.columns.push(['PreparedImport', 'creationRequestHash', 'text', 'YES', null, max + 1]);
        w.db.preparedImport = w.db.preparedImport.map(row => ({ ...row, creationRequestHash: null }));
        w.m25Mutation?.(w.db);
      }
    }
  };
  const seedFixture = () => {
    w.db.preparedImport = ['a', 'b', 'c'].map((key, index) => ({ id: `pi-${key}`, datasetId: `ds-${key}`, jobId: `job-${key}`, createdById: 'u1', status: ['PREPARING', 'COMMITTED', 'EXPIRED'][index], expectedItemCount: index + 1, deadlineAt: '2030-01-01T00:00:00', committedAt: index === 1 ? '2029-06-01T12:00:00' : null, idempotencyKey: `k-${key}`, createdAt: 'x', updatedAt: 'y' }));
    w.db.tables.PreparedImportItem = [6, 'items-md5']; w.db.tables.Dataset = [3, 'ds-md5']; w.db.tables.User = [1, 'user-md5'];
  };
  const answer = statement => {
    if (statement.includes('jsonb_build_object(\'n\',migration_name')) {
      const rows = w.db.migrations.map(row => ({ n: row.migration_name, c: row.checksum, f: Boolean(row.finished_at), r: Boolean(row.rolled_back_at) }));
      return JSON.stringify(w.historyMutate ? w.historyMutate(rows) : rows);
    }
    if (statement.includes('FAKE_SCHEMA_MANIFEST')) return JSON.stringify(w.db.manifest);
    if (statement.includes('jsonb_build_object(\'id\',x.id')) return JSON.stringify(w.db.datasets.map(row => ({ id: row.id, ...(w.db.manifest.some(entry => entry[1].includes('modalityResolverSubject')) ? { m: row.m, r: 0, t: null, s: null } : { m: null, r: null, t: null, s: null }) })));
    if (statement.includes('to_jsonb(x) - ARRAY[')) return JSON.stringify([w.db.datasets.length, 'legacy-md5']);
    if (statement.includes('pg_tables')) return JSON.stringify(w.db.tableList);
    if (statement.includes('md5(to_jsonb(x)::text)')) return JSON.stringify(w.db.tables[statement.match(/public\."([^"]+)"/)[1]]);
    if (statement.includes('information_schema.columns')) return JSON.stringify(w.db.columns);
    if (statement.includes('pg_indexes')) return JSON.stringify(w.db.indexes);
    if (statement.includes('pg_constraint')) return JSON.stringify(w.db.constraints);
    if (statement.includes('pg_trigger')) return JSON.stringify(w.db.triggers);
    if (statement.includes('pg_proc')) return JSON.stringify(w.db.routines);
    if (statement.includes('pg_enum')) return JSON.stringify(w.db.enums);
    if (statement.includes('public."PreparedImport" x')) return JSON.stringify(w.db.preparedImport);
    if (statement.includes('_prisma_migrations m')) return JSON.stringify(w.db.migrations);
    throw Error('UNEXPECTED_QUERY ' + statement.slice(0, 60));
  };
  const approveCalls = [];
  const sh = (cmd, args, { env, input } = {}) => {
    w.calls.push({ cmd, args, env });
    if (env) w.sawEnv.push(env);
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (cmd === 'docker') {
      const [verb] = args;
      if (verb === 'run') {
        const name = args[args.indexOf('--name') + 1];
        const labels = {}; args.forEach((arg, index) => { if (arg === '--label') { const [k, v] = args[index + 1].split('='); labels[k] = v; } });
        if (w.failRunRole && name.endsWith('-' + w.failRunRole)) return { status: 125, stdout: '', stderr: 'docker: simulated create failure' };
        const id = String(nextId++).padStart(2, '0').repeat(32);
        w.containers.set(id, { id, name, labels }); return ok(id + '\n');
      }
      if (verb === 'inspect') {
        const key = args.at(-1); const c = [...w.containers.values()].find(entry => entry.id === key || entry.name === key);
        if (!c) return { status: 1, stdout: '', stderr: 'Error: No such object: ' + key };
        const labels = w.tamperLabelAfterProvision ? { ...c.labels, 'annotation.run': 'tampered' } : c.labels;
        return ok(JSON.stringify([{ Id: c.id, Name: '/' + c.name, Config: { Labels: labels }, Mounts: [{ Type: 'volume', Name: 'vol-' + c.id.slice(0, 6) }] }]));
      }
      if (verb === 'exec') {
        if (args.includes('pg_isready')) return ok();
        if (args.includes('sh')) return ok('Database system identifier:           ' + w.systemIdentifier + '\n');
        if (args.includes('psql')) {
          const statements = input.split('\n').filter(line => line && !/^(BEGIN|ROLLBACK)/.test(line));
          return ok(statements.map(answer).join('\n') + '\n');
        }
      }
      if (verb === 'rm') { const id = args.at(-1); w.removed.push(id); if (w.rmStatus) return { status: 1, stdout: '', stderr: 'boom' }; w.containers.delete(id); return ok(); }
    }
    if (cmd === process.execPath) {
      const script = args[0].split('/').at(-1);
      if (script === 'approve-disposable.mjs') {
        approveCalls.push(args);
        if (w.failApproveAt === approveCalls.length) return { status: 1, stdout: '', stderr: 'SAFETY_ABORT UNAPPROVED' };
        const request = JSON.parse(readFileSync(args[1], 'utf8'));
        if (w.receiptMode === 'fail') return { status: 1, stdout: '', stderr: 'SAFETY_ABORT UNAPPROVED' };
        if (w.receiptMode === 'missing') return ok();
        if (w.receiptMode === 'malformed') { writeFileSync(args[2], '{not json'); return ok(); }
        const id = `${String(approveCalls.length).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`;
        const command = w.receiptMode === 'wrong-command' ? 'web:test:other' : request.command ?? null;
        writeFileSync(args[2], JSON.stringify({ id, operation: request.operation, command, postgres: request.postgres, migrationHashes: request.migrationHashes }));
        writeFileSync(join(w.registry, id + '.json'), '{}');
        return ok();
      }
      if (script === 'cli.mjs') {
        if (args[1] === 'deploy') { w.deployCalls += 1; if (w.failDeployAt === w.deployCalls) return { status: 1, stdout: '', stderr: '' }; if (!w.deployExit) deployFrom(env.DB_SAFETY_RECEIPT); return { status: w.deployExit, stdout: '', stderr: '' }; }
        if (args[1] === 'test' && (args[2] === COMPAT_COMMAND || args[2] === T015_COMMAND || args[2] === INGEST_COMMAND)) { w.onCompatTest?.(w.root); return { status: w.compatExit, stdout: 'compat ran', stderr: '' }; }
        if (args[1] === 'test' && args[2] === 'g2:baseline') { if (!w.baselineSeedExit) { w.db.datasets = ['g2-empty', 'g2-single', 'g2-mixed'].map(id => ({ id, m: null })); w.db.tables.Dataset = [3, 'g2-ds-md5']; } return { status: w.baselineSeedExit ?? 0, stdout: 'seeded', stderr: '' }; }
        if (args[1] === 'test' && args[2] === 'g2:compatibility' && w.schemaCompatExit) return { status: w.schemaCompatExit, stdout: '', stderr: '' };
        if (args[1] === 'test' && args[2] === 'g2:candidate' && w.candidateExit) return { status: w.candidateExit, stdout: '', stderr: '' };
        if (args[1] === 'test' && args[2] === FIXTURE_COMMAND) { if (!w.fixtureExit) seedFixture(); return { status: w.fixtureExit, stdout: 'fixture ran', stderr: '' }; }
        if (args[1] === 'test') return { status: w.testExit, stdout: 'tests ran', stderr: '' };
      }
    }
    return { status: 99, stdout: '', stderr: 'UNEXPECTED_COMMAND ' + cmd + ' ' + args.join(' ') };
  };
  const identity = {
    container: (pin, role) => { const c = w.containers.get(pin.id); guard.must(c && c.name === pin.name && c.labels['annotation.role'] === role && c.labels['annotation.safety'] === 'g1-disposable', 'CONTAINER_IDENTITY_MISMATCH'); },
    control: pin => { guard.must(w.systemIdentifier !== guard.applicationSystem && w.systemIdentifier === pin.systemIdentifier, 'SYSTEM_IDENTITY_MISMATCH'); },
  };
  let tokenCounter = 0;
  const deps = {
    root, outBase, registry, uid: 1004, baseEnv: () => ({ PATH: '/usr/bin', HOME: '/home/x' }),
    inheritedUrlPresent: () => Boolean(overrides.inheritedUrl), sh, identity,
    newToken: () => (++tokenCounter === 1 ? 'aabbccdd' : '11223344'), newSecret: () => 'S3CRET'.repeat(8), now: () => new Date('2026-10-05T00:00:00Z'),
    sleep: async () => {}, mkStage: () => { const s = mkdtempSync('/tmp/phase029-g1-'); stages.push(s); return s; },
    pickPorts: async () => [55460, 55461, 55462],
    verifyCleanup: runDir => { w.verifiedRunDir = runDir; return { status: w.cleanupVerifyStatus, output: '' }; },
    pinned: { baseline: 23, chain: FAKE_CHAIN, compat: compatBindingsFor(root) },
    releaseManifestSql: () => "SELECT 'FAKE_SCHEMA_MANIFEST';",
    ...(overrides.deps ?? {}),
  };
  w.deps = deps; w.approveCalls = approveCalls;
  return w;
}
const cleanup = w => { for (const stage of w.stages) rmSync(stage, { recursive: true, force: true }); for (const dir of [w.root, w.outBase, w.registry]) rmSync(dir, { recursive: true, force: true }); };
const dockerRuns = w => w.calls.filter(c => c.cmd === 'docker' && c.args[0] === 'run');

test('allowlisted command: full lifecycle passes, runs exactly the named command, cleans and verifies', async () => {
  const w = world();
  try {
    const out = await runFocusedTest(COMMAND, w.deps);
    assert.equal(out.result, 'PASS', JSON.stringify(out.failures));
    assert.equal(dockerRuns(w).length, 3);
    assert.deepEqual(w.calls.filter(c => c.args[1] === 'test').map(c => c.args.slice(1)), [['test', COMMAND]]);
    assert.deepEqual(w.calls.filter(c => c.args[1] === 'deploy').length, 2); // baseline + candidate
    assert.equal(w.removed.length, 3);
    assert.equal(readdirSync(w.registry).length, 0, 'receipt registrations removed');
    assert.ok(w.stages.every(stage => !existsSync(stage)));
    assert.equal(w.verifiedRunDir, out.runDir);
    for (const name of ['allocation-ownership.json', 'disposable-identities.json', 'owned-volumes.json', 'cleanup.json', 'results.json']) assert.ok(existsSync(join(out.runDir, name)), name);
    assert.ok(!readFileSync(join(out.runDir, 'results.json'), 'utf8').includes('S3CRET'));
    // The committed independent verifier must be able to resolve every identity from this run's manifests.
    const { expect, missing } = loadExpectations(out.runDir);
    assert.deepEqual(missing, []);
    assert.equal(expect.containers.length, 3); assert.deepEqual(expect.ports, [55460, 55461, 55462]);
    assert.equal(expect.runToken, 'aabbccdd'); assert.equal(expect.volumes.length, 3);
    assert.ok(expect.paths.some(entry => entry.kind === 'private-stage' && entry.path === w.stages[0]));
  } finally { cleanup(w); }
});

test('unknown, malformed and injected command names are rejected before any side effect', async () => {
  for (const name of ['web:test:other', 'g2:baseline', 'nope', '', undefined, `${COMMAND}; rm -rf /`, `${COMMAND} --x`, '$(id)', COMMAND.toUpperCase(), 'web:test:../x', ['web:test:dataset-metadata']]) {
    const w = world();
    try {
      await assert.rejects(() => runFocusedTest(name, w.deps), /COMMAND_/);
      assert.equal(w.calls.length, 0, 'no process may run for: ' + String(name));
      assert.equal(readdirSync(w.outBase).length, 0, 'no run directory created');
      assert.equal(w.stages.length, 0);
    } finally { cleanup(w); }
  }
  assert.deepEqual(SUPPORTED_COMMANDS, [COMMAND, 'web:test:dataset-patch-route', 'web:test:local-folder-modality-idempotency', 'web:test:imports-ui:vitest', 'worker:test:ingestion-replay-reuse'], 'the supported set is exactly the intended named commands');
  assert.throws(() => validateCommand(COMMAND, { [COMMAND]: { kind: 'seed' } }), /COMMAND_NOT_ALLOWLISTED/);
});

test('candidate checksum mismatch is rejected before provisioning', async () => {
  const w = world();
  try {
    writeFileSync(join(w.root, P1.path, 'migration.sql'), PROPOSAL1_SQL + '-- tampered\n');
    await assert.rejects(() => runFocusedTest(COMMAND, w.deps), /PROPOSAL_CHECKSUM_MISMATCH/);
    assert.equal(w.calls.length, 0);
  } finally { cleanup(w); }
});

test('wrong baseline size or a stale generated client is rejected before provisioning', async () => {
  const a = world();
  try { rmSync(join(a.root, 'prisma/migrations/20260100_m'.replace('20260100', '2026010' + '00')), { recursive: true, force: true }); await assert.rejects(() => runFocusedTest(COMMAND, a.deps), /BASELINE_MIGRATION_COUNT_MISMATCH/); assert.equal(a.calls.length, 0); } finally { cleanup(a); }
  const b = world();
  try { writeFileSync(join(b.root, 'lib/generated/prisma/models/Dataset.ts'), 'export type X = {}\n'); await assert.rejects(() => runFocusedTest(COMMAND, b.deps), /GENERATED_CLIENT_NOT_PHASE029/); assert.equal(b.calls.length, 0); } finally { cleanup(b); }
});

test('application database system identifier is rejected, no receipt is issued, resources are still cleaned', async () => {
  const w = world({ systemIdentifier: guard.applicationSystem });
  try {
    const out = await runFocusedTest(COMMAND, w.deps);
    assert.equal(out.result, 'FAIL');
    assert.ok(out.failures.includes('SYSTEM_IDENTITY_MISMATCH'));
    assert.equal(w.approveCalls.length, 0, 'receipt must never precede identity verification');
    assert.equal(w.calls.filter(c => c.args[1] === 'test' || c.args[1] === 'deploy').length, 0);
    assert.equal(w.removed.length, 3);
  } finally { cleanup(w); }
});

test('container identity mismatch is rejected before any receipt', async () => {
  const w = world();
  w.deps.identity.container = () => { throw Error('CONTAINER_IDENTITY_MISMATCH'); };
  try {
    const out = await runFocusedTest(COMMAND, w.deps);
    assert.equal(out.result, 'FAIL'); assert.ok(out.failures.includes('CONTAINER_IDENTITY_MISMATCH'));
    assert.equal(w.approveCalls.length, 0); assert.equal(w.removed.length, 3);
  } finally { cleanup(w); }
});

test('missing, malformed, failed or wrongly scoped receipts abort and nothing runs the test', async () => {
  for (const [mode, expected] of [['missing', 'RECEIPT_MISSING_OR_MALFORMED'], ['malformed', 'RECEIPT_MISSING_OR_MALFORMED'], ['fail', 'RECEIPT_ISSUE_FAILED']]) {
    const w = world({ receiptMode: mode });
    try {
      const out = await runFocusedTest(COMMAND, w.deps);
      assert.equal(out.result, 'FAIL'); assert.ok(out.failures.includes(expected), mode + JSON.stringify(out.failures));
      assert.equal(w.calls.filter(c => c.args[1] === 'test').length, 0);
      assert.equal(w.removed.length, 3);
    } finally { cleanup(w); }
  }
  const w = world({ receiptMode: 'wrong-command' });
  try {
    const out = await runFocusedTest(COMMAND, w.deps);
    assert.ok(out.failures.includes('RECEIPT_SCOPE_MISMATCH'), JSON.stringify(out.failures));
    assert.equal(w.calls.filter(c => c.args[1] === 'test').length, 0);
  } finally { cleanup(w); }
});

test('an inherited DATABASE_URL / DB_SAFETY_RECEIPT cannot redirect or authorize anything', async () => {
  const previous = { url: process.env.DATABASE_URL, receipt: process.env.DB_SAFETY_RECEIPT };
  process.env.DATABASE_URL = 'postgresql://app:secret@10.0.0.9:5432/appdb'; process.env.DB_SAFETY_RECEIPT = '/tmp/evil-receipt.json';
  const real = realDeps();
  const w = world({ inheritedUrl: true, deps: { baseEnv: real.baseEnv, inheritedUrlPresent: real.inheritedUrlPresent } });
  try {
    assert.equal('DATABASE_URL' in real.baseEnv(), false);
    assert.equal('DB_SAFETY_RECEIPT' in real.baseEnv(), false);
    const out = await runFocusedTest(COMMAND, w.deps);
    assert.equal(out.result, 'PASS', JSON.stringify(out.failures));
    for (const env of w.sawEnv) assert.ok(!('DATABASE_URL' in env) || false, 'child env must not carry DATABASE_URL');
    for (const call of w.calls.filter(c => c.args[1] === 'deploy' || c.args[1] === 'test')) assert.notEqual(call.env.DB_SAFETY_RECEIPT, '/tmp/evil-receipt.json');
    const config = readFileSync(join(out.runDir, 'baseline-deploy-issue.log'), 'utf8') + JSON.stringify(w.calls.map(c => c.args));
    assert.ok(!config.includes('10.0.0.9') && !config.includes('appdb'));
    assert.ok(existsSync(join(out.runDir, 'ignored-inherited-url.json')));
    assert.ok(!readFileSync(join(out.runDir, 'ignored-inherited-url.json'), 'utf8').includes('10.0.0.9'));
  } finally {
    if (previous.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.url;
    if (previous.receipt === undefined) delete process.env.DB_SAFETY_RECEIPT; else process.env.DB_SAFETY_RECEIPT = previous.receipt;
    cleanup(w);
  }
});

test('non-zero test exit propagates as FAIL and cleanup + independent verification still run', async () => {
  const w = world({ testExit: 3 });
  try {
    const out = await runFocusedTest(COMMAND, w.deps);
    assert.equal(out.result, 'FAIL'); assert.equal(out.testExit, 3);
    assert.ok(out.failures.includes('TEST_COMMAND_FAILED:3'));
    assert.equal(w.removed.length, 3); assert.equal(w.verifiedRunDir, out.runDir);
  } finally { cleanup(w); }
});

test('deploy failure still cleans up and verifies, and never reaches the test command', async () => {
  const w = world({ deployExit: 1 });
  try {
    const out = await runFocusedTest(COMMAND, w.deps);
    assert.equal(out.result, 'FAIL'); assert.ok(out.failures.includes('BASELINE_DEPLOY_FAILED'));
    assert.equal(w.calls.filter(c => c.args[1] === 'test').length, 0);
    assert.equal(w.removed.length, 3); assert.equal(w.verifiedRunDir, out.runDir);
  } finally { cleanup(w); }
});

test('migration history or candidate checksum mismatch after deploy fails closed', async () => {
  const history = world({ historyMutate: rows => rows.slice(0, -1) });
  try { const out = await runFocusedTest(COMMAND, history.deps); assert.equal(out.result, 'FAIL'); assert.ok(out.failures.includes('BASELINE_HISTORY_MISMATCH')); assert.equal(history.calls.filter(c => c.args[1] === 'test').length, 0); } finally { cleanup(history); }
  const checksum = world({ historyMutate: rows => (rows.length === 24 ? rows.map((row, index) => (index === 23 ? { ...row, c: 'a'.repeat(64) } : row)) : rows) });
  try { const out = await runFocusedTest(COMMAND, checksum.deps); assert.equal(out.result, 'FAIL'); assert.ok(out.failures.includes('PROPOSAL_HISTORY_CHECKSUM_MISMATCH')); assert.equal(checksum.calls.filter(c => c.args[1] === 'test').length, 0); } finally { cleanup(checksum); }
});

test('primary cleanup failure makes the run fail', async () => {
  const w = world({ rmStatus: 1 });
  try {
    const out = await runFocusedTest(COMMAND, w.deps);
    assert.equal(out.result, 'FAIL'); assert.ok(out.failures.includes('PRIMARY_CLEANUP_FAILED'));
    assert.equal(w.verifiedRunDir, out.runDir, 'independent verifier still runs');
  } finally { cleanup(w); }
});

test('independent cleanup failure makes the run fail even when the test and primary cleanup pass', async () => {
  const w = world({ cleanupVerifyStatus: 1 });
  try {
    const out = await runFocusedTest(COMMAND, w.deps);
    assert.equal(out.testExit, 0);
    assert.equal(out.result, 'FAIL'); assert.ok(out.failures.includes('INDEPENDENT_CLEANUP_FAILED'));
    assert.ok(!out.failures.includes('PRIMARY_CLEANUP_FAILED'));
  } finally { cleanup(w); }
});

test('cleanup only touches this run: a foreign lookalike container is never removed, and a re-labelled container is refused', async () => {
  const w = world();
  try {
    const out = await runFocusedTest(COMMAND, w.deps);
    assert.equal(out.result, 'PASS');
    assert.ok(!w.removed.includes(w.foreign.id));
    assert.ok(w.containers.has(w.foreign.id));
    assert.ok(w.calls.filter(c => c.args[0] === 'rm').every(c => c.args.at(-1) !== w.foreign.id));
    assert.ok(w.calls.filter(c => c.args[0] === 'rm').every(c => c.args.length === 3 && c.args[1] === '-fv'), 'exact id only, no filters or patterns');
    assert.ok(w.calls.every(c => !(c.cmd === 'docker' && ['ps', 'prune', 'ls'].includes(c.args[0]) || c.args.includes('--filter'))), 'no broad docker queries');
  } finally { cleanup(w); }
  const t = world({ tamperLabelAfterProvision: true });
  try {
    const out = await runFocusedTest(COMMAND, t.deps);
    assert.equal(out.result, 'FAIL');
    assert.ok(out.failures.includes('PRIMARY_CLEANUP_FAILED'), JSON.stringify(out.failures));
    assert.equal(t.removed.length, 0, 'ownership not proven → refuse to remove');
  } finally { cleanup(t); }
});

test('the real defaults reuse the committed G1 primitives and keep the application identity constant', () => {
  const real = realDeps();
  assert.equal(real.identity.container, guard.containerIdentity);
  assert.equal(real.identity.control, guard.controlIdentity);
  assert.equal(guard.applicationSystem, '7662655305624969250');
  assert.deepEqual(real.pinned.chain.map(({ order, name, sha256 }) => [order, name, sha256]), [
    [1, '20260930030000_dataset_modality_g2', '13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7'],
    [2, '20261006000000_prepared_import_creation_request_hash', 'a8ffbc84bde7f18aac93bbb2e87423e6cfcbf6efd95c01e6650824fdcc3ed859'],
  ]);
  assert.equal(real.pinned.baseline, 23);
  assert.ok(real.outBase.includes('verification/focused-runs'));
});

test('partial provisioning: when Redis creation fails the already-created PostgreSQL is cleaned by exact id and verified', async () => {
  const w = world({ failRunRole: 'redis' });
  try {
    const out = await runFocusedTest(COMMAND, w.deps);
    assert.equal(out.result, 'FAIL'); assert.ok(out.failures.includes('DOCKER_COMMAND_FAILED'), JSON.stringify(out.failures));
    assert.equal(dockerRuns(w).length, 2, 'postgres created, redis attempted, minio never attempted');
    assert.equal(w.removed.length, 1, 'only the one recorded container is removed');
    assert.ok(![...w.containers.values()].some(c => c.labels['annotation.run'] === 'aabbccdd'), 'nothing of this run survives');
    assert.ok(w.containers.has(w.foreign.id));
    assert.equal(w.approveCalls.length, 0); assert.equal(w.verifiedRunDir, out.runDir);
  } finally { cleanup(w); }
});

test('failures at candidate deploy, test-receipt issuance and baseline-receipt issuance each reach cleanup + independent verification without widening ownership', async () => {
  for (const [label, options, expected] of [
    ['proposal deploy', { failDeployAt: 2 }, 'PROPOSAL_DEPLOY_FAILED'],
    ['baseline receipt issuance', { failApproveAt: 1 }, 'RECEIPT_ISSUE_FAILED'],
    ['test receipt issuance', { failApproveAt: 3 }, 'RECEIPT_ISSUE_FAILED'],
  ]) {
    const w = world(options);
    try {
      const out = await runFocusedTest(COMMAND, w.deps);
      assert.equal(out.result, 'FAIL', label); assert.ok(out.failures.includes(expected), label + JSON.stringify(out.failures));
      assert.equal(w.calls.filter(c => c.args[1] === 'test').length, 0, label + ': the test command must not run');
      assert.equal(w.removed.length, 3, label); assert.ok(!w.removed.includes(w.foreign.id), label);
      assert.equal(w.verifiedRunDir, out.runDir, label);
      assert.equal(readdirSync(w.registry).length, 0, label + ': receipts issued so far are unregistered');
      assert.ok(w.stages.every(stage => !existsSync(stage)), label);
    } finally { cleanup(w); }
  }
});

test('focused evidence is explicitly not G3/G5 evidence and stays inside its own namespace', async () => {
  const w = world();
  try {
    const out = await runFocusedTest(COMMAND, w.deps);
    for (const name of ['focused-run.json', 'allocation-ownership.json', 'results.json']) {
      const data = JSON.parse(readFileSync(join(out.runDir, name), 'utf8'));
      assert.equal(data.kind, 'focused-disposable-test', name); assert.equal(data.countsAsG3Evidence, false, name); assert.equal(data.countsAsG5Evidence, false, name);
    }
    assert.ok(out.runDir.startsWith(w.outBase + '/'));
    assert.deepEqual(readdirSync(w.outBase).length, 1, 'exactly one run directory, no sibling rehearsal receipts written');
    assert.ok(!readdirSync(out.runDir).some(name => /^(results|final-g3-receipt|g5-)/.test(name) && name !== 'results.json'));
    assert.ok(realDeps().outBase.endsWith('verification/focused-runs'));
  } finally { cleanup(w); }
});

test('a run changes nothing in the repository fixture outside its own run directory (protected sources untouched)', async () => {
  const w = world();
  const snapshot = () => guard.walk(w.root).sort().map(file => file + ':' + sha(readFileSync(file))).join('\n');
  try {
    const before = snapshot();
    const out = await runFocusedTest(COMMAND, w.deps);
    assert.equal(out.result, 'PASS');
    assert.equal(snapshot(), before);
  } finally { cleanup(w); }
});

// --- Receipt / protected-source integrity (the committed guard, exercised offline) ---
test('protectedSources() covers the new runner and its test; the receipt manifest records their current bytes', () => {
  const protectedPaths = guard.protectedSources();
  for (const name of ['scripts/db-safety/disposable-test.mjs', 'scripts/db-safety/tests/disposable-test.test.mjs', 'scripts/db-safety/commands.json', 'apps/web/tests/dataset-metadata/dataset-patch-route.test.ts']) {
    assert.ok(protectedPaths.includes(join(guard.root, name)), name + ' must be a protected source');
    assert.equal(guard.filesHash([join(guard.root, name)])[join(guard.root, name)], sha(readFileSync(join(guard.root, name))));
  }
  const approve = readFileSync(join(guard.root, 'scripts/db-safety/approve-disposable.mjs'), 'utf8');
  assert.match(approve, /sources:filesHash\(protectedSources\(\)\)/, 'receipt issuance records every protected source hash');
  const cli = readFileSync(join(guard.root, 'scripts/db-safety/cli.mjs'), 'utf8');
  assert.equal((cli.match(/await verify\(receipt,operation\)/g) ?? []).length, 2, 'verified once before and once after schema validation');
  assert.match(cli, /Revalidate full identity[\s\S]*await verify\(receipt,operation\)/, 'launcher revalidates after validation, immediately before the mutating child');
  assert.match(readFileSync(join(guard.root, 'scripts/db-safety/entry-check.mjs'), 'utf8'), /await verify\(path,r\.operation\)/, 'every test entry revalidates again');
});

test('guard.verify fails closed when a protected source changes after receipt issuance, before any connection is made', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dt-verify-'));
  const id = '99999999-aaaa-bbbb-cccc-dddddddddddd';
  mkdirSync(guard.registry, { recursive: true, mode: 0o700 });
  const protectedFile = join(dir, 'runner-copy.mjs');
  const receiptFile = join(dir, 'receipt.json');
  const writeReceipt = () => {
    const bytes = JSON.stringify({ id, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), operation: 'test', files: {}, sources: { [protectedFile]: sha(readFileSync(protectedFile)) }, config: join(dir, 'missing-config.ts') });
    writeFileSync(receiptFile, bytes, { mode: 0o600 });
    writeFileSync(join(guard.registry, id + '.json'), JSON.stringify({ receiptPath: receiptFile, sha256: sha(bytes) }), { flag: 'w', mode: 0o600 });
  };
  try {
    writeFileSync(protectedFile, 'export const a = 1;\n');
    writeReceipt();
    // Unchanged source: the file-integrity step passes, so verification only fails LATER (config), never with APPROVED_FILE_CHANGED.
    await assert.rejects(() => guard.verify(receiptFile, 'test'), error => error.message !== 'APPROVED_FILE_CHANGED');
    // Source mutated after approval (receipt itself untouched): fails closed with the exact integrity code.
    writeFileSync(protectedFile, 'export const a = 2; // mutated after approval\n');
    await assert.rejects(() => guard.verify(receiptFile, 'test'), /APPROVED_FILE_CHANGED/);
    // Receipt rewritten to bless the mutation without registry approval: rejected as not approved.
    writeFileSync(receiptFile, readFileSync(receiptFile, 'utf8').replace(sha('export const a = 1;\n'), sha(readFileSync(protectedFile))), { mode: 0o600 });
    await assert.rejects(() => guard.verify(receiptFile, 'test'), /RECEIPT_NOT_APPROVED/);
  } finally { rmSync(join(guard.registry, id + '.json'), { force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('supported set is an explicit allowlist: other kind:"test" entries in the real commands.json are rejected, the patch-route entry is exactly one file', () => {
  const catalog = guard.read(join(guard.root, 'scripts/db-safety/commands.json'));
  const tests = Object.entries(catalog).filter(([, spec]) => spec.kind === 'test').map(([name]) => name);
  assert.ok(tests.length > SUPPORTED_COMMANDS.length, 'the catalog has many more test entries than the runner supports');
  for (const name of tests) {
    if (SUPPORTED_COMMANDS.includes(name)) assert.equal(validateCommand(name, catalog), name);
    else assert.throws(() => validateCommand(name, catalog), /COMMAND_(NOT_SUPPORTED|NAME_INVALID)/, name);
  }
  assert.deepEqual(catalog['web:test:dataset-patch-route'], { kind: 'test', cwd: 'apps/web', args: ['--require', './tests/auth-ownership/register-server-only.cjs', '--import', 'tsx', '--test', '--test-concurrency=1', 'tests/dataset-metadata/dataset-patch-route.test.ts'] });
  const spec = catalog['web:test:dataset-patch-route'];
  const entry = join(guard.root, 'apps/web/tests/dataset-metadata/dataset-patch-route.test.ts');
  assert.doesNotThrow(() => guard.assertEntryScope(spec, entry, []));
  for (const other of ['http-routes.test.ts', 'datasets.test.ts', 'labels.test.ts', 'assets.test.ts']) assert.throws(() => guard.assertEntryScope(spec, join(guard.root, 'apps/web/tests/dataset-metadata', other), []), /ENTRY_COMMAND_SCOPE_MISMATCH/, other);
  assert.throws(() => guard.assertEntryScope(spec, join(guard.root, 'apps/web/tests/workspace/workspace-state.test.ts'), []), /ENTRY_COMMAND_SCOPE_MISMATCH/);
  for (const injected of ['web:test:dataset-patch-route tests/other.test.ts', 'web:test:dataset-patch-route --import x', 'web:test:dataset-patch-route/../x', 'web:test:dataset-patch-route\n', 'web:test:dataset-patch-route&&id']) assert.throws(() => validateCommand(injected, catalog), /COMMAND_/, injected);
  assert.ok(spec.args.every(arg => !/[*?]/.test(arg)), 'no glob in the entry');
  assert.ok(!spec.args.some(arg => arg.includes('--env-file')));
});

test('local-folder idempotency entry is structurally the authorized command, scoped to exactly one file, and injection-proof', () => {
  const name = 'web:test:local-folder-modality-idempotency';
  const catalog = guard.read(join(guard.root, 'scripts/db-safety/commands.json'));
  assert.deepEqual(catalog[name], { kind: 'test', cwd: 'apps/web', args: ['--require', './tests/auth-ownership/register-server-only.cjs', '--import', 'tsx', '--test', '--test-concurrency=1', 'tests/local-folder-import/prepare-modality-idempotency.test.ts'] });
  assert.equal(validateCommand(name, catalog), name);
  const spec = catalog[name];
  const dir = join(guard.root, 'apps/web/tests/local-folder-import');
  assert.doesNotThrow(() => guard.assertEntryScope(spec, join(dir, 'prepare-modality-idempotency.test.ts'), []));
  for (const other of ['start-route.test.ts', 'foundation.test.ts', 'modality-assets.test.ts', 'item-completion.test.ts', 'commit-route.test.ts', 'ownership-matrix.test.ts']) assert.throws(() => guard.assertEntryScope(spec, join(dir, other), []), /ENTRY_COMMAND_SCOPE_MISMATCH/, other);
  for (const unrelated of ['apps/web/tests/dataset-metadata/dataset-patch-route.test.ts', 'apps/web/tests/workspace/workspace-state.test.ts']) assert.throws(() => guard.assertEntryScope(spec, join(guard.root, unrelated), []), /ENTRY_COMMAND_SCOPE_MISMATCH/, unrelated);
  assert.ok(spec.args.every(arg => !/[*?]/.test(arg)) && !spec.args.some(arg => arg.includes('--env-file')));
  for (const injected of [name + ' tests/other.test.ts', name + ' --import x', name + '/../x', name + '\n', name + '&&id', name + ';id', name + '$(id)', name + '`id`', name + '|id', name.toUpperCase()]) assert.throws(() => validateCommand(injected, catalog), /COMMAND_/, injected);
  assert.match(readFileSync(join(dir, 'prepare-modality-idempotency.test.ts'), 'utf8').split('\n')[0], /import .*db-safety\/test-entry.cjs/, 'first-line safety gate');
  assert.ok(guard.protectedSources().includes(join(dir, 'prepare-modality-idempotency.test.ts')), 'the new test is a protected source');
});

// =====================================================================================================================
// Migration-25 rehearsal wiring (frozen ordered proposal chain, fixed rehearsal plan, fixture binding, receipt topology)
// =====================================================================================================================
const failuresOf = async (w, name = REHEARSAL_ID) => runFocusedTest(name, w.deps);
const deployCalls = w => w.calls.filter(c => c.args[1] === 'deploy');
const testCalls = w => w.calls.filter(c => c.args[1] === 'test').map(c => c.args[2]);
const expectCleanedAndVerified = (w, out, containers = 3) => {
  assert.equal(w.removed.length, containers); assert.ok(!w.removed.includes(w.foreign.id));
  assert.equal(w.verifiedRunDir, out.runDir, 'independent cleanup verification ran');
  assert.equal(readdirSync(w.registry).length, 0, 'every receipt registration created by this run was removed');
  assert.ok(w.stages.every(stage => !existsSync(stage)));
};

test('frozen proposal chain is exactly the two approved migrations, in order, with the approved bytes', () => {
  assert.deepEqual(PROPOSAL_CHAIN, [
    { order: 1, name: '20260930030000_dataset_modality_g2', path: 'prisma/migrations/20260930030000_dataset_modality_g2', sha256: '13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7' },
    { order: 2, name: '20261006000000_prepared_import_creation_request_hash', path: 'prisma/migrations/20261006000000_prepared_import_creation_request_hash', sha256: 'a8ffbc84bde7f18aac93bbb2e87423e6cfcbf6efd95c01e6650824fdcc3ed859' },
  ]);
  // The real bytes on disk still match the frozen manifest, and the real migration 25 is the single approved statement.
  for (const entry of PROPOSAL_CHAIN) assert.equal(sha(readFileSync(join(guard.root, entry.path, 'migration.sql'))), entry.sha256, entry.name);
  assert.equal(readFileSync(join(guard.root, P2.path, 'migration.sql'), 'utf8'), 'ALTER TABLE "PreparedImport" ADD COLUMN "creationRequestHash" TEXT;\n');
  assert.deepEqual(readdirSync(join(guard.root, P2.path)), ['migration.sql']);
  // Release-chain promotion: the canonical active chain is the 23 historical migrations followed by exactly these two, in order.
  const active = readdirSync(join(guard.root, 'prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.equal(active.length, 25, 'active chain is 25 migrations');
  assert.deepEqual(active.slice(23), [P1.name, P2.name], 'migrations 24 and 25 are the last two, in order');
  assert.equal(active.at(-3), '20260930020000_revert_dataset_modality');
  assert.ok(!existsSync(join(guard.root, 'specs/proposals/phase029-modality/migrations')), 'promoted migrations are not duplicated under proposals');
});

test('validateChain fails closed on missing, renamed, reordered, extra-file and byte-modified proposals (and only checks the applied slice)', () => {
  const w = world();
  try {
    assert.equal(validateChain(w.deps, 2).length, 2);
    assert.equal(validateChain(w.deps, 1).length, 1);
    const withDeps = chain => ({ ...w.deps, pinned: { ...w.deps.pinned, chain } });
    assert.throws(() => validateChain(withDeps([FAKE_CHAIN[1], FAKE_CHAIN[0]]), 2), /PROPOSAL_ORDER_MISMATCH/, 'reordered');
    assert.throws(() => validateChain(withDeps([FAKE_CHAIN[0], { ...FAKE_CHAIN[1], order: 3 }]), 2), /PROPOSAL_ORDER_MISMATCH/, 'bad order number');
    assert.throws(() => validateChain(withDeps([FAKE_CHAIN[0], { ...FAKE_CHAIN[1], name: '20261006000000_renamed_migration' }]), 2), /PROPOSAL_NAME_MISMATCH|BASELINE_MIGRATION_COUNT_MISMATCH/, 'renamed vs path');
    assert.throws(() => validateChain(withDeps([FAKE_CHAIN[0], { ...FAKE_CHAIN[1], name: '20260101000_m' }]), 2), /PROPOSAL_(NAME_MISMATCH|NOT_AFTER_PREVIOUS)|BASELINE_MIGRATION_COUNT_MISMATCH/, 'not after the historical chain');
    assert.throws(() => validateChain(withDeps([FAKE_CHAIN[0], { ...FAKE_CHAIN[1], sha256: 'b'.repeat(64) }]), 2), /PROPOSAL_CHECKSUM_MISMATCH/, 'pinned hash differs');
    assert.throws(() => validateChain(withDeps([FAKE_CHAIN[0]]), 2), /PROPOSAL_MANIFEST_INVALID/, 'manifest shorter than the plan');
    assert.throws(() => validateChain(w.deps, 0), /PROPOSAL_MANIFEST_INVALID/);
    writeFileSync(join(w.root, P2.path, 'migration.sql'), PROPOSAL2_SQL + '-- modified\n');
    assert.throws(() => validateChain(w.deps, 2), /PROPOSAL_CHECKSUM_MISMATCH/, 'byte-modified migration 25');
    assert.equal(validateChain(w.deps, 1).length, 1, 'migration-24-only plans do not depend on migration 25');
    writeFileSync(join(w.root, P2.path, 'migration.sql'), PROPOSAL2_SQL);
    writeFileSync(join(w.root, P2.path, 'extra.sql'), 'SELECT 1;');
    assert.throws(() => validateChain(w.deps, 2), /PROPOSAL_MISSING_OR_UNEXPECTED_FILES/, 'extra file next to migration.sql');
    rmSync(join(w.root, P2.path), { recursive: true, force: true });
    assert.throws(() => validateChain(w.deps, 2), /PROPOSAL_MISSING_OR_UNEXPECTED_FILES/, 'missing migration 25');
  } finally { cleanup(w); }
});

test('rehearsal: tampered, missing, reordered or renamed proposal migrations are rejected before anything is provisioned', async () => {
  const setups = [
    ['modified m25 bytes', w => writeFileSync(join(w.root, P2.path, 'migration.sql'), PROPOSAL2_SQL + '-- x\n'), /PROPOSAL_CHECKSUM_MISMATCH/],
    ['modified m24 bytes', w => writeFileSync(join(w.root, P1.path, 'migration.sql'), PROPOSAL1_SQL + '-- x\n'), /PROPOSAL_CHECKSUM_MISMATCH/],
    ['missing m25', w => rmSync(join(w.root, P2.path), { recursive: true, force: true }), /PROPOSAL_MISSING_OR_UNEXPECTED_FILES/],
    ['extra file', w => writeFileSync(join(w.root, P2.path, 'x.sql'), 'x'), /PROPOSAL_MISSING_OR_UNEXPECTED_FILES/],
    ['reordered manifest', w => { w.deps.pinned.chain = [FAKE_CHAIN[1], FAKE_CHAIN[0]]; }, /PROPOSAL_ORDER_MISMATCH/],
    ['renamed manifest entry', w => { w.deps.pinned.chain = [FAKE_CHAIN[0], { ...FAKE_CHAIN[1], name: '20261006000000_other_name' }]; }, /PROPOSAL_NAME_MISMATCH|BASELINE_MIGRATION_COUNT_MISMATCH/],
  ];
  for (const [label, mutate, expected] of setups) {
    const w = world();
    try {
      mutate(w);
      await assert.rejects(() => failuresOf(w), expected, label);
      assert.equal(w.calls.length, 0, label + ': no process may run'); assert.equal(w.stages.length, 0, label); assert.equal(readdirSync(w.outBase).length, 0, label);
    } finally { cleanup(w); }
  }
});

test('the three existing focused commands still apply only the historical chain plus migration 24 (migration 25 is never staged or applied)', async () => {
  for (const name of SUPPORTED_COMMANDS) {
    assert.deepEqual(resolvePlan(name), { kind: 'test', id: name, through: 1 });
    const w = world();
    try {
      rmSync(join(w.root, P2.path), { recursive: true, force: true }); // migration 25 absent: test-mode plans must not care
      const out = await runFocusedTest(name, w.deps);
      assert.equal(deployCalls(w).length, 2, name + ': baseline + migration 24 only');
      assert.equal(w.db.migrations.length, 24, name);
      assert.ok(!w.db.migrations.some(row => row.migration_name === P2.name), name);
      assert.deepEqual(testCalls(w), [name], name + ': exactly the named command, never the fixture');
      assert.ok(!testCalls(w).includes(FIXTURE_COMMAND));
      assert.equal(out.result, 'PASS', name + JSON.stringify(out.failures));
    } finally { cleanup(w); }
  }
});

test('rehearsal lifecycle: 23 -> migration 24 -> fixture + pre-fingerprint -> migration 25 -> assertions -> cleanup -> independent verification', async () => {
  const w = world();
  try {
    const out = await failuresOf(w);
    assert.equal(out.result, 'PASS', JSON.stringify(out.failures));
    assert.equal(dockerRuns(w).length, 3);
    assert.equal(deployCalls(w).length, 3, 'baseline, migration 24, migration 25');
    assert.deepEqual(testCalls(w), [FIXTURE_COMMAND], 'the only test child is the fixed fixture; no application test command runs');
    assert.deepEqual(w.db.migrations.map(row => row.migration_name).slice(23), [P1.name, P2.name]);
    // order: fixture must run after migration 24 and before migration 25
    const order = w.calls.filter(c => c.args[1] === 'deploy' || c.args[1] === 'test').map(c => c.args[1] === 'test' ? 'fixture' : 'deploy');
    assert.deepEqual(order, ['deploy', 'deploy', 'fixture', 'deploy']);
    // evidence and classification
    const results = JSON.parse(readFileSync(join(out.runDir, 'results.json'), 'utf8'));
    assert.equal(results.kind, 'migration-rehearsal'); assert.equal(results.countsAsG3Evidence, false); assert.equal(results.countsAsG5Evidence, false);
    assert.equal(results.scope, 'proposal-migration-25'); assert.equal(results.activeChainUnchanged, true); assert.equal(results.notAuthorizationToApplyMigration, true);
    assert.equal(results.migrationChain.active.length, 23); assert.deepEqual(results.migrationChain.proposals.map(entry => entry.name), [P1.name, P2.name]);
    for (const name of ['m25-pre-fingerprint.json', 'm25-post-fingerprint.json', 'm25-assertions.json', 'focused-run.json']) assert.ok(existsSync(join(out.runDir, name)), name);
    assert.ok(JSON.parse(readFileSync(join(out.runDir, 'm25-assertions.json'), 'utf8')).every(item => item.pass));
    // receipt topology: exactly these four, mapped to lifecycle steps
    assert.deepEqual(results.receiptTopology.map(({ step, operation, command }) => [step, operation, command]), [
      ['baseline-deploy', 'deploy', null], ['proposal-1-deploy', 'deploy', null], ['fixture', 'test', FIXTURE_COMMAND], ['proposal-2-deploy', 'deploy', null],
    ]);
    assert.equal(new Set(results.receiptTopology.map(entry => entry.receiptId)).size, 4);
    // cleanup is identity-based: each recorded id removed, listed, and gone
    assert.deepEqual([...results.cleanup.receiptRegistrationIds].sort(), results.receiptTopology.map(entry => entry.receiptId).sort());
    expectCleanedAndVerified(w, out);
    const { expect, missing } = loadExpectations(out.runDir);
    assert.deepEqual(missing, []); assert.equal(expect.containers.length, 3);
    // the active chain (all 25 migrations) and the generated client are untouched (the runner checks this itself; the fixture repo proves it here)
    assert.ok(existsSync(join(w.root, 'prisma/migrations', P1.name)) && existsSync(join(w.root, 'prisma/migrations', P2.name)));
    assert.equal(readFileSync(join(w.root, P2.path, 'migration.sql'), 'utf8'), PROPOSAL2_SQL);
  } finally { cleanup(w); }
});

test('rehearsal fixture is bound: it cannot be substituted, re-pathed, extended or run outside the plan', async () => {
  const mutations = {
    'sibling path': spec => ({ ...spec, args: [...spec.args.slice(0, -1), 'tests/prepared-import-rehearsal/other.test.ts'] }),
    'different directory': spec => ({ ...spec, args: [...spec.args.slice(0, -1), 'tests/local-folder-import/prepare-modality-idempotency.test.ts'] }),
    'glob': spec => ({ ...spec, args: [...spec.args.slice(0, -1), 'tests/prepared-import-rehearsal/*.test.ts'] }),
    'added argument': spec => ({ ...spec, args: [...spec.args, '--import', 'evil'] }),
    'added flag': spec => ({ ...spec, args: ['--env-file', '.env', ...spec.args] }),
    'different cwd': spec => ({ ...spec, cwd: '.' }),
    'dropped rehearsalOnly marker': ({ rehearsalOnly, ...rest }) => rest,
    'different marker': spec => ({ ...spec, rehearsalOnly: 'web:test:dataset-metadata' }),
    'kind seed': spec => ({ ...spec, kind: 'seed' }),
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const w = world();
    try {
      writeFileSync(join(w.root, 'scripts/db-safety/commands.json'), JSON.stringify({ ...CATALOG, [FIXTURE_COMMAND]: mutate(FIXTURE_SPEC) }));
      await assert.rejects(() => failuresOf(w), /FIXTURE_COMMAND_TAMPERED/, label);
      assert.equal(w.calls.length, 0, label);
    } finally { cleanup(w); }
  }
  const missing = world();
  try { rmSync(join(missing.root, FIXTURE_FILE)); await assert.rejects(() => failuresOf(missing), /FIXTURE_FILE_MISSING_OR_UNGATED/); assert.equal(missing.calls.length, 0); } finally { cleanup(missing); }
  const ungated = world();
  try { writeFileSync(join(ungated.root, FIXTURE_FILE), '// no gate\\nimport x from "y";\\n'); await assert.rejects(() => failuresOf(ungated), /FIXTURE_FILE_MISSING_OR_UNGATED/); assert.equal(ungated.calls.length, 0); } finally { cleanup(ungated); }
  const absent = world();
  try { const { [FIXTURE_COMMAND]: _removed, ...rest } = CATALOG; writeFileSync(join(absent.root, 'scripts/db-safety/commands.json'), JSON.stringify(rest)); await assert.rejects(() => failuresOf(absent), /FIXTURE_COMMAND_TAMPERED/); } finally { cleanup(absent); }
});

test('the fixture command and unknown/injected rehearsal ids are not selectable from the CLI', async () => {
  const catalog = guard.read(join(guard.root, 'scripts/db-safety/commands.json'));
  assert.throws(() => validateCommand(FIXTURE_COMMAND, catalog), /COMMAND_/);
  assert.equal(validateCommand(REHEARSAL_ID, catalog), REHEARSAL_ID);
  assert.deepEqual(Object.keys(REHEARSALS), [REHEARSAL_ID]);
  assert.ok(Object.isFrozen(REHEARSALS) && Object.isFrozen(REHEARSALS[REHEARSAL_ID]));
  for (const bad of ['rehearse:other-migration', 'rehearse:', 'rehearse', REHEARSAL_ID + ' --x', REHEARSAL_ID + ';id', REHEARSAL_ID + '&&id', REHEARSAL_ID + '\n', REHEARSAL_ID + '/../x', REHEARSAL_ID.toUpperCase(), '$(' + REHEARSAL_ID + ')', REHEARSAL_ID + ' ' + FIXTURE_COMMAND, FIXTURE_COMMAND + ' ' + REHEARSAL_ID, 'rehearse:__proto__', 'rehearse:constructor']) {
    assert.throws(() => validateCommand(bad, catalog), /COMMAND_/, JSON.stringify(bad));
  }
  const w = world();
  try { await assert.rejects(() => runFocusedTest(FIXTURE_COMMAND, w.deps), /COMMAND_/); assert.equal(w.calls.length, 0); } finally { cleanup(w); }
});

test('real catalog: the internal fixture entry equals FIXTURE_SPEC, resolves to exactly one gated file, and is a protected source', () => {
  const catalog = guard.read(join(guard.root, 'scripts/db-safety/commands.json'));
  assert.deepEqual(catalog[FIXTURE_COMMAND], FIXTURE_SPEC);
  assert.equal(catalog[FIXTURE_COMMAND].rehearsalOnly, REHEARSAL_ID);
  assert.ok(!SUPPORTED_COMMANDS.includes(FIXTURE_COMMAND));
  assert.deepEqual(SUPPORTED_COMMANDS, [COMMAND, 'web:test:dataset-patch-route', 'web:test:local-folder-modality-idempotency', 'web:test:imports-ui:vitest', 'worker:test:ingestion-replay-reuse']);
  const dir = join(guard.root, 'apps/web/tests/prepared-import-rehearsal');
  assert.doesNotThrow(() => guard.assertEntryScope(catalog[FIXTURE_COMMAND], join(dir, 'seed-prepared-imports.test.ts'), []));
  for (const other of [join(dir, 'other.test.ts'), join(guard.root, 'apps/web/tests/local-folder-import/prepare-modality-idempotency.test.ts'), join(guard.root, 'apps/web/tests/dataset-metadata/dataset-patch-route.test.ts')]) assert.throws(() => guard.assertEntryScope(catalog[FIXTURE_COMMAND], other, []), /ENTRY_COMMAND_SCOPE_MISMATCH/, other);
  assert.match(readFileSync(join(guard.root, FIXTURE_FILE), 'utf8').split('\n')[0], /import .*db-safety\/test-entry.cjs/);
  assert.ok(guard.protectedSources().includes(join(guard.root, FIXTURE_FILE)));
  assert.ok(guard.protectedSources().includes(join(guard.root, 'scripts/db-safety/commands.json')));
  // no other catalog entry points at the fixture or carries a rehearsal marker
  for (const [name, spec] of Object.entries(catalog)) if (name !== FIXTURE_COMMAND) { assert.ok(!JSON.stringify(spec.args).includes('prepared-import-rehearsal'), name); assert.equal(spec.rehearsalOnly, undefined, name); }
});

test('history verification is explicit about identities and order, and adds no new historical invariant', () => {
  const baseline = [{ name: 'a', sha256: '1'.repeat(64) }, { name: 'b', sha256: '2'.repeat(64) }];
  const rows = baseline.map(entry => ({ n: entry.name, c: entry.sha256, f: true, r: false }));
  assert.doesNotThrow(() => checkHistory(rows, baseline, 'BASELINE'));
  assert.throws(() => checkHistory([rows[1], rows[0]], baseline, 'BASELINE'), /BASELINE_HISTORY_MISMATCH/, 'reordered');
  assert.throws(() => checkHistory(rows.slice(0, 1), baseline, 'BASELINE'), /BASELINE_HISTORY_MISMATCH/, 'missing');
  assert.throws(() => checkHistory([...rows, { n: 'c', c: '3'.repeat(64), f: true, r: false }], baseline, 'PROPOSAL'), /PROPOSAL_HISTORY_MISMATCH/, 'unexpected extra');
  assert.throws(() => checkHistory([{ ...rows[0], n: 'z' }, rows[1]], baseline, 'BASELINE'), /BASELINE_HISTORY_MISMATCH/, 'renamed');
  assert.throws(() => checkHistory([{ ...rows[0], f: false }, rows[1]], baseline, 'BASELINE'), /BASELINE_HISTORY_INCOMPLETE/);
  assert.throws(() => checkHistory([rows[0], { ...rows[1], r: true }], baseline, 'BASELINE'), /BASELINE_HISTORY_INCOMPLETE/);
  assert.throws(() => checkHistory([rows[0], { ...rows[1], c: '9'.repeat(64) }], baseline, 'PROPOSAL'), /PROPOSAL_HISTORY_CHECKSUM_MISMATCH/);
  assert.ok(!/applied_steps_count/.test(HISTORY_SQL), 'applied_steps_count is not a historical invariant');
});

// ---- schema/data assertion unit tests -------------------------------------------------------------------------------
function m25Models() {
  const rowsPre = ['a', 'b', 'c'].map((key, index) => ({ id: `pi-${key}`, status: ['PREPARING', 'COMMITTED', 'EXPIRED'][index], idempotencyKey: `k-${key}`, committedAt: index === 1 ? '2029-01-01' : null }));
  const columns = [['PreparedImport', 'id', 'text', 'NO', null, 1], ['PreparedImport', 'status', 'USER-DEFINED', 'NO', null, 2], ['PreparedImport', 'idempotencyKey', 'text', 'NO', null, 3], ['PreparedImport', 'committedAt', 'timestamp without time zone', 'YES', null, 4], ['Dataset', 'id', 'text', 'NO', null, 1]];
  const migrationsPre = Array.from({ length: 24 }, (_, index) => ({ id: `m${index}`, migration_name: `n${String(index).padStart(2, '0')}`, checksum: String(index).repeat(64).slice(0, 64), finished_at: 't', rolled_back_at: null }));
  const pre = {
    columns, indexes: [['PreparedImport', 'pk', 'CREATE UNIQUE INDEX pk']], constraints: [['PreparedImport', 'pk', 'p', 'PRIMARY KEY (id)']], triggers: [['Dataset', 'g', 'CREATE TRIGGER g']], routines: [['f', 'md5']], enums: [['S', 'A']],
    preparedImport: rowsPre, migrations: migrationsPre, tables: { Dataset: [3, 'x'], PreparedImportItem: [6, 'y'], User: [1, 'z'] },
  };
  const post = structuredClone(pre);
  post.columns.push(['PreparedImport', 'creationRequestHash', 'text', 'YES', null, 5]);
  post.preparedImport = post.preparedImport.map(row => ({ ...row, creationRequestHash: null }));
  post.migrations.push({ id: 'new', migration_name: P2.name, checksum: P2.sha256, finished_at: 't2', rolled_back_at: null });
  return { pre, post };
}
const M25_CTX = { newColumn: ['PreparedImport', 'creationRequestHash'], fixtureRows: FIXTURE_ROWS, proposal: { name: P2.name, sha256: P2.sha256 } };

test('assertMigration25 accepts exactly the approved change and reports evidence for every property', () => {
  const { pre, post } = m25Models();
  const evidence = assertMigration25(pre, post, M25_CTX);
  assert.deepEqual(evidence.map(item => item.name), ['migration-history', 'column', 'no-indexes-change', 'no-constraints-change', 'no-triggers-change', 'no-routines-change', 'no-enums-change', 'prepared-import-rows', 'unrelated-tables']);
  assert.ok(evidence.every(item => item.pass));
});

test('assertMigration25 rejects every deviation: extra/wrong column, index, uniqueness, FK, trigger, routine, enum, backfill, row or data change, history drift', () => {
  const cases = {
    'extra column': [post => post.columns.push(['PreparedImport', 'other', 'text', 'YES', null, 6]), 'M25_COLUMN_SHAPE_UNEXPECTED'],
    'wrong type': [post => { post.columns.find(row => row[1] === 'creationRequestHash')[2] = 'jsonb'; }, 'M25_COLUMN_SHAPE_UNEXPECTED'],
    'NOT NULL': [post => { post.columns.find(row => row[1] === 'creationRequestHash')[3] = 'NO'; }, 'M25_COLUMN_SHAPE_UNEXPECTED'],
    'has default': [post => { post.columns.find(row => row[1] === 'creationRequestHash')[4] = "''::text"; }, 'M25_COLUMN_SHAPE_UNEXPECTED'],
    'wrong ordinal': [post => { post.columns.find(row => row[1] === 'creationRequestHash')[5] = 9; }, 'M25_COLUMN_SHAPE_UNEXPECTED'],
    'column missing': [post => { post.columns.pop(); }, 'M25_COLUMN_SHAPE_UNEXPECTED'],
    'other column dropped': [post => { post.columns = post.columns.filter(row => row[1] !== 'status'); }, 'M25_COLUMN_SHAPE_UNEXPECTED'],
    'other column altered': [post => { post.columns.find(row => row[1] === 'status')[3] = 'YES'; }, 'M25_COLUMN_SHAPE_UNEXPECTED'],
    'index added': [post => post.indexes.push(['PreparedImport', 'ix', 'CREATE INDEX ix']), 'M25_INDEX_CHANGED'],
    'unique index added': [post => post.indexes.push(['PreparedImport', 'ux', 'CREATE UNIQUE INDEX ux']), 'M25_INDEX_CHANGED'],
    'uniqueness constraint added': [post => post.constraints.push(['PreparedImport', 'uq', 'u', 'UNIQUE ("creationRequestHash")']), 'M25_CONSTRAINT_CHANGED'],
    'FK added': [post => post.constraints.push(['PreparedImport', 'fk', 'f', 'FOREIGN KEY ("creationRequestHash") REFERENCES "Dataset"(id)']), 'M25_CONSTRAINT_CHANGED'],
    'trigger added': [post => post.triggers.push(['PreparedImport', 't', 'CREATE TRIGGER t']), 'M25_TRIGGER_CHANGED'],
    'migration-24 trigger changed': [post => { post.triggers[0][2] = 'CREATE TRIGGER g2'; }, 'M25_TRIGGER_CHANGED'],
    'routine changed': [post => { post.routines[0][1] = 'other'; }, 'M25_ROUTINE_CHANGED'],
    'enum label added': [post => post.enums.push(['S', 'B']), 'M25_ENUM_CHANGED'],
    'backfilled value': [post => { post.preparedImport[1].creationRequestHash = 'deadbeef'; }, 'M25_BACKFILL_DETECTED'],
    'new column absent from a row': [post => { delete post.preparedImport[0].creationRequestHash; }, 'M25_BACKFILL_DETECTED'],
    'row deleted': [post => post.preparedImport.pop(), 'M25_ROW_COUNT_CHANGED'],
    'row added': [post => post.preparedImport.push({ id: 'x', status: 'PREPARING', idempotencyKey: 'x', committedAt: null, creationRequestHash: null }), 'M25_ROW_COUNT_CHANGED'],
    'old field changed': [post => { post.preparedImport[2].status = 'COMMITTED'; }, 'M25_PREPARED_IMPORT_ROWS_CHANGED'],
    'old field nulled': [post => { post.preparedImport[1].committedAt = null; }, 'M25_PREPARED_IMPORT_ROWS_CHANGED'],
    'unrelated table changed': [post => { post.tables.Dataset = [3, 'changed']; }, 'M25_UNRELATED_DATA_CHANGED'],
    'unrelated table rows added': [post => { post.tables.PreparedImportItem = [7, 'y']; }, 'M25_UNRELATED_DATA_CHANGED'],
    'unrelated table disappears': [post => { delete post.tables.User; }, 'M25_UNRELATED_DATA_CHANGED'],
    'prior history row changed': [post => { post.migrations[3].checksum = 'f'.repeat(64); }, 'M25_HISTORY_UNEXPECTED'],
    'wrong new migration checksum': [post => { post.migrations.at(-1).checksum = 'e'.repeat(64); }, 'M25_HISTORY_UNEXPECTED'],
    'wrong new migration name': [post => { post.migrations.at(-1).migration_name = 'zzz'; }, 'M25_HISTORY_UNEXPECTED'],
    'new migration unfinished': [post => { post.migrations.at(-1).finished_at = null; }, 'M25_HISTORY_UNEXPECTED'],
    'new migration rolled back': [post => { post.migrations.at(-1).rolled_back_at = 'x'; }, 'M25_HISTORY_UNEXPECTED'],
    'two migrations added': [post => post.migrations.push({ id: 'y', migration_name: 'zz', checksum: 'a'.repeat(64), finished_at: 't', rolled_back_at: null }), 'M25_HISTORY_UNEXPECTED'],
  };
  for (const [label, [mutate, code]] of Object.entries(cases)) {
    const { pre, post } = m25Models();
    mutate(post);
    assert.throws(() => assertMigration25(pre, post, M25_CTX), new RegExp(code), label);
  }
  const preCases = {
    'fixture rows missing': [pre => { pre.preparedImport = pre.preparedImport.slice(0, 2); }, 'M25_FIXTURE_ROWS_MISSING'],
    'fixture items missing': [pre => { pre.tables.PreparedImportItem = [0, 'y']; }, 'M25_FIXTURE_ITEMS_MISSING'],
    'column already present before migration 25': [pre => { pre.preparedImport[0].creationRequestHash = null; }, 'M25_PRE_ALREADY_HAS_COLUMN'],
  };
  for (const [label, [mutate, code]] of Object.entries(preCases)) {
    const { pre, post } = m25Models();
    mutate(pre);
    assert.throws(() => assertMigration25(pre, post, M25_CTX), new RegExp(code), label);
  }
});

// ---- rehearsal failure paths: always cleanup + independent verification, never broader ownership ----------------------
test('rehearsal failure paths each reach primary cleanup and independent verification without widening ownership', async () => {
  const cases = [
    ['fixture command fails', { fixtureExit: 1 }, 'FIXTURE_FAILED'],
    ['migration 24 deploy fails', { failDeployAt: 2 }, 'PROPOSAL_DEPLOY_FAILED'],
    ['migration 25 deploy fails', { failDeployAt: 3 }, 'PROPOSAL_DEPLOY_FAILED'],
    ['baseline receipt issuance fails', { failApproveAt: 1 }, 'RECEIPT_ISSUE_FAILED'],
    ['fixture receipt issuance fails', { failApproveAt: 3 }, 'RECEIPT_ISSUE_FAILED'],
    ['migration 25 receipt issuance fails', { failApproveAt: 4 }, 'RECEIPT_ISSUE_FAILED'],
    ['history drift after migration 25', { historyMutate: rows => (rows.length === 25 ? rows.slice(0, 24) : rows) }, 'PROPOSAL_HISTORY_MISMATCH'],
    ['migration 25 adds an index', { m25Mutation: db => db.indexes.push(['PreparedImport', 'ix', 'CREATE INDEX ix']) }, 'M25_INDEX_CHANGED'],
    ['migration 25 backfills', { m25Mutation: db => { db.preparedImport[0].creationRequestHash = 'x'; } }, 'M25_BACKFILL_DETECTED'],
    ['migration 25 touches another table', { m25Mutation: db => { db.tables.Dataset = [3, 'changed']; } }, 'M25_UNRELATED_DATA_CHANGED'],
    ['PreparedImport row changed', { m25Mutation: db => { db.preparedImport[1].status = 'EXPIRED'; } }, 'M25_PREPARED_IMPORT_ROWS_CHANGED'],
    ['application system identifier', { systemIdentifier: guard.applicationSystem }, 'SYSTEM_IDENTITY_MISMATCH'],
  ];
  for (const [label, options, expected] of cases) {
    const w = world(options);
    try {
      const out = await failuresOf(w);
      assert.equal(out.result, 'FAIL', label); assert.ok(out.failures.includes(expected), label + JSON.stringify(out.failures));
      expectCleanedAndVerified(w, out);
      assert.ok(!testCalls(w).some(name => name !== FIXTURE_COMMAND), label + ': no application test ever runs in a rehearsal');
    } finally { cleanup(w); }
  }
  const partial = world({ failRunRole: 'minio' });
  try {
    const out = await failuresOf(partial);
    assert.equal(out.result, 'FAIL'); expectCleanedAndVerified(partial, out, 2);
    assert.equal(partial.approveCalls.length, 0);
  } finally { cleanup(partial); }
  const cleanupFail = world({ rmStatus: 1 });
  try { const out = await failuresOf(cleanupFail); assert.equal(out.result, 'FAIL'); assert.ok(out.failures.includes('PRIMARY_CLEANUP_FAILED')); assert.equal(cleanupFail.verifiedRunDir, out.runDir); } finally { cleanup(cleanupFail); }
  const independentFail = world({ cleanupVerifyStatus: 1 });
  try { const out = await failuresOf(independentFail); assert.equal(out.result, 'FAIL'); assert.ok(out.failures.includes('INDEPENDENT_CLEANUP_FAILED')); assert.ok(!out.failures.includes('PRIMARY_CLEANUP_FAILED')); } finally { cleanup(independentFail); }
});

test('receipt-registration cleanup is identity-based: only this run\'s recorded ids are removed, a leftover is detected, foreign entries are never touched', () => {
  const registry = mkdtempSync(join(tmpdir(), 'dt-reg-'));
  const outDir = mkdtempSync(join(tmpdir(), 'dt-save-'));
  const mine = ['11111111-aaaa-bbbb-cccc-dddddddddddd', '22222222-aaaa-bbbb-cccc-dddddddddddd'];
  const foreign = '99999999-aaaa-bbbb-cccc-dddddddddddd';
  const noContainers = () => ({ status: 1, stdout: '', stderr: 'No such object' });
  const saved = {};
  try {
    for (const id of [...mine, foreign]) writeFileSync(join(registry, id + '.json'), '{}');
    const ok = primaryCleanup({ pins: [], receiptIds: mine, token: 'aabbccdd' }, '/tmp/phase029-g1-never-created', { run: noContainers, registry, save: (name, value) => { saved[name] = value; } });
    assert.equal(ok.ok, true); assert.deepEqual(ok.receiptRegistrationIds, mine);
    assert.deepEqual(readdirSync(registry), [foreign + '.json'], 'the foreign registration is untouched');
    // a registration that cannot be removed (here: a directory in its place) is reported, not counted
    mkdirSync(join(registry, mine[0] + '.json'));
    const stuck = primaryCleanup({ pins: [], receiptIds: mine, token: 'aabbccdd' }, '/tmp/phase029-g1-never-created', { run: noContainers, registry, save: () => {} });
    assert.equal(stuck.ok, false); assert.ok(!stuck.receiptRegistrationIds.includes(mine[0]));
    // unsafe ids are never turned into paths
    const unsafe = primaryCleanup({ pins: [], receiptIds: ['../../etc/passwd'], token: 'aabbccdd' }, '/tmp/phase029-g1-never-created', { run: noContainers, registry, save: () => {} });
    assert.equal(unsafe.ok, false);
  } finally { rmSync(registry, { recursive: true, force: true }); rmSync(outDir, { recursive: true, force: true }); }
});

test('protected sources include the rehearsal wiring and cover its bytes (post-receipt mutation is covered by the guard tamper test)', () => {
  const protectedPaths = guard.protectedSources();
  for (const name of ['scripts/db-safety/disposable-test.mjs', 'scripts/db-safety/tests/disposable-test.test.mjs', 'scripts/db-safety/commands.json', FIXTURE_FILE]) assert.ok(protectedPaths.includes(join(guard.root, name)), name);
  assert.ok(!protectedPaths.some(path => path.includes('specs/proposals')), 'proposal migrations are pinned by the runner manifest, not by protectedSources');
});

// =====================================================================================================================
// Prisma client compatibility plan (compat:prepared-import-creation-request-hash)
// =====================================================================================================================
const snapshot = root => guard.walk(root).sort().map(file => `${file}:${sha(readFileSync(file))}`).join('\n');
const COMPAT_TOPOLOGY = [['baseline-deploy', 'deploy', null], ['proposal-1-deploy', 'deploy', null], ['proposal-2-deploy', 'deploy', null], ['compat-test', 'test', COMPAT_COMMAND]];
const compatRun = (w) => runFocusedTest(COMPAT_ID, w.deps);
const readJson = (dir, name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const expectNothingStarted = (w, label) => { assert.equal(w.calls.length, 0, label + ': no process may run'); assert.equal(w.stages.length, 0, label); assert.equal(readdirSync(w.outBase).length, 0, label + ': no run directory'); };

test('compat plan: ordered chain through migration 25, column check, one guarded compat test; classification, topology, evidence and cleanup', async () => {
  const w = world();
  try {
    const before = snapshot(w.root);
    const out = await compatRun(w);
    assert.equal(out.result, 'PASS', JSON.stringify(out.failures));
    assert.equal(deployCalls(w).length, 3, 'baseline, migration 24, migration 25');
    assert.deepEqual(testCalls(w), [COMPAT_COMMAND], 'the compat test is the only child test; no fixture, no application test');
    assert.deepEqual(w.calls.filter(c => c.args[1] === 'deploy' || c.args[1] === 'test').map(c => c.args[1]), ['deploy', 'deploy', 'deploy', 'test']);
    assert.deepEqual(w.db.migrations.map(row => row.migration_name).slice(23), [P1.name, P2.name]);
    const results = readJson(out.runDir, 'results.json'), initial = readJson(out.runDir, 'focused-run.json');
    for (const record of [initial, results]) {
      assert.equal(record.kind, 'prisma-client-compatibility'); assert.equal(record.scope, 'prepared-import-creation-request-hash');
      assert.equal(record.countsAsG3Evidence, false); assert.equal(record.countsAsG5Evidence, false);
      assert.equal(record.migrationBehaviorAlreadyProvenSeparately, true); assert.equal(record.notAuthorizationToApplyMigration, true);
    }
    assert.equal(initial.clientCompatibilityProven, false, 'false until PASS'); assert.equal(results.clientCompatibilityProven, true);
    assert.deepEqual(results.receiptTopology.map(({ step, operation, command }) => [step, operation, command]), COMPAT_TOPOLOGY);
    assert.equal(new Set(results.receiptTopology.map(entry => entry.receiptId)).size, 4);
    assert.deepEqual([...results.cleanup.receiptRegistrationIds].sort(), results.receiptTopology.map(entry => entry.receiptId).sort(), 'identity-based cleanup');
    const evidence = readJson(out.runDir, 'compat-evidence.json');
    assert.deepEqual({ schemaSha256: evidence.schemaSha256, generatedTreeSha256: evidence.generatedTreeSha256, activeChainTreeSha256: evidence.activeChainTreeSha256 }, { schemaSha256: w.deps.pinned.compat.schemaSha256, generatedTreeSha256: w.deps.pinned.compat.generatedTreeSha256, activeChainTreeSha256: w.deps.pinned.compat.activeChainTreeSha256 });
    assert.deepEqual(evidence.migrations.map(({ order, name, sha256 }) => [order, name, sha256]), FAKE_CHAIN.map(({ order, name, sha256 }) => [order, name, sha256]));
    assert.equal(evidence.historical, 23); assert.equal(evidence.clientCompatibilityProven, false);
    assert.deepEqual(results.migrationChain.proposals.map(entry => entry.name), [P1.name, P2.name]);
    assert.ok(!existsSync(join(out.runDir, 'm25-assertions.json')) && !existsSync(join(out.runDir, 'm25-pre-fingerprint.json')), 'no migration-rehearsal evidence is produced or touched');
    assert.equal(snapshot(w.root), before, 'repository fixture untouched');
    expectCleanedAndVerified(w, out);
  } finally { cleanup(w); }
});

test('compat plan: every frozen source binding aborts before provisioning (schema, each bound generated file, added/deleted generated files, active chain, migrations 24 and 25)', async () => {
  const drifts = {
    'schema edited': [root => writeFileSync(join(root, SCHEMA_PATH), SCHEMA_TEXT_DRIFT()), /FROZEN_SCHEMA_DRIFT/],
    'class.ts edited': [root => writeFileSync(join(root, CLIENT_DIR, 'internal/class.ts'), 'tampered\n'), /FROZEN_CLIENT_FILE_DRIFT/],
    'prismaNamespace.ts edited': [root => writeFileSync(join(root, CLIENT_DIR, 'internal/prismaNamespace.ts'), 'tampered\n'), /FROZEN_CLIENT_FILE_DRIFT/],
    'prismaNamespaceBrowser.ts edited': [root => writeFileSync(join(root, CLIENT_DIR, 'internal/prismaNamespaceBrowser.ts'), 'tampered\n'), /FROZEN_CLIENT_FILE_DRIFT/],
    'PreparedImport.ts edited': [root => writeFileSync(join(root, CLIENT_DIR, 'models/PreparedImport.ts'), 'tampered\n'), /FROZEN_CLIENT_FILE_DRIFT/],
    'engine binary edited': [root => writeFileSync(join(root, CLIENT_DIR, ENGINE_FILE), Buffer.from([9])), /FROZEN_CLIENT_FILE_DRIFT/],
    'bound file deleted': [root => rmSync(join(root, CLIENT_DIR, 'models/PreparedImport.ts')), /FROZEN_CLIENT_FILE_DRIFT/],
    'unbound generated file edited': [root => writeFileSync(join(root, CLIENT_DIR, 'models/Dataset.ts'), 'tampered\n'), /FROZEN_CLIENT_DRIFT/],
    'unbound generated file deleted': [root => rmSync(join(root, CLIENT_DIR, 'models/Dataset.ts')), /FROZEN_CLIENT_DRIFT/],
    'generated file added': [root => writeFileSync(join(root, CLIENT_DIR, 'models/Extra.ts'), 'x'), /FROZEN_CLIENT_DRIFT/],
    'active chain: historical migration edited': [root => writeFileSync(join(root, 'prisma/migrations/202601000_m/migration.sql'), 'SELECT 99;\n'), /FROZEN_ACTIVE_CHAIN_DRIFT/],
    'active chain: lock file edited': [root => writeFileSync(join(root, 'prisma/migrations/migration_lock.toml'), 'provider = "other"\n'), /FROZEN_ACTIVE_CHAIN_DRIFT/],
    'active chain: extra file': [root => writeFileSync(join(root, 'prisma/migrations/202601000_m/extra.sql'), 'x'), /FROZEN_ACTIVE_CHAIN_DRIFT|PROPOSAL|BASELINE/],
    'active chain: unlisted 26th migration added': [root => { mkdirSync(join(root, 'prisma/migrations/20261007000000_extra')); writeFileSync(join(root, 'prisma/migrations/20261007000000_extra/migration.sql'), 'SELECT 1;\n'); }, /BASELINE_MIGRATION_COUNT_MISMATCH/],
    'migration 24 bytes': [root => writeFileSync(join(root, P1.path, 'migration.sql'), PROPOSAL1_SQL + '-- x\n'), /PROPOSAL_CHECKSUM_MISMATCH/],
    'migration 25 bytes': [root => writeFileSync(join(root, P2.path, 'migration.sql'), PROPOSAL2_SQL + '-- x\n'), /PROPOSAL_CHECKSUM_MISMATCH/],
    'migration 25 missing': [root => rmSync(join(root, P2.path), { recursive: true, force: true }), /PROPOSAL_MISSING_OR_UNEXPECTED_FILES/],
  };
  for (const [label, [mutate, expected]] of Object.entries(drifts)) {
    const w = world();
    try { mutate(w.root); await assert.rejects(() => compatRun(w), expected, label); expectNothingStarted(w, label); } finally { cleanup(w); }
  }
  const missingBindings = world({ deps: { pinned: { baseline: 23, chain: FAKE_CHAIN } } });
  try { await assert.rejects(() => compatRun(missingBindings), /COMPAT_BINDINGS_MISSING/); expectNothingStarted(missingBindings, 'no bindings'); } finally { cleanup(missingBindings); }
});
function SCHEMA_TEXT_DRIFT() { return 'datasource db { url = env("DATABASE_URL") }\n// drifted\n'; }

test('compat plan: migration chain ordering, naming and checksum pins fail closed', async () => {
  const setups = [
    ['reordered manifest', w => { w.deps.pinned.chain = [FAKE_CHAIN[1], FAKE_CHAIN[0]]; }, /PROPOSAL_ORDER_MISMATCH/],
    ['renamed manifest entry', w => { w.deps.pinned.chain = [FAKE_CHAIN[0], { ...FAKE_CHAIN[1], name: '20261006000000_other_name' }]; }, /PROPOSAL_NAME_MISMATCH|BASELINE_MIGRATION_COUNT_MISMATCH/],
    ['pinned checksum differs', w => { w.deps.pinned.chain = [FAKE_CHAIN[0], { ...FAKE_CHAIN[1], sha256: 'b'.repeat(64) }]; }, /PROPOSAL_CHECKSUM_MISMATCH/],
    ['manifest too short', w => { w.deps.pinned.chain = [FAKE_CHAIN[0]]; }, /PROPOSAL_MANIFEST_INVALID/],
  ];
  for (const [label, mutate, expected] of setups) { const w = world(); try { mutate(w); await assert.rejects(() => compatRun(w), expected, label); expectNothingStarted(w, label); } finally { cleanup(w); } }
  const history = [
    ['history missing a row after migration 25', rows => (rows.length === 25 ? rows.slice(0, 24) : rows), 'PROPOSAL_HISTORY_MISMATCH'],
    ['migration 25 checksum differs in history', rows => (rows.length === 25 ? rows.map((row, index) => (index === 24 ? { ...row, c: 'a'.repeat(64) } : row)) : rows), 'PROPOSAL_HISTORY_CHECKSUM_MISMATCH'],
    ['migration 24 renamed in history', rows => (rows.length === 24 ? rows.map((row, index) => (index === 23 ? { ...row, n: 'zzz' } : row)) : rows), 'PROPOSAL_HISTORY_MISMATCH'],
    ['historical migration unfinished', rows => rows.map((row, index) => (index === 3 ? { ...row, f: false } : row)), 'BASELINE_HISTORY_INCOMPLETE'],
  ];
  for (const [label, historyMutate, code] of history) {
    const w = world({ historyMutate });
    try {
      const out = await compatRun(w);
      assert.equal(out.result, 'FAIL', label); assert.ok(out.failures.includes(code), label + JSON.stringify(out.failures));
      assert.deepEqual(testCalls(w), [], label + ': the compat test never runs after a history failure');
      assert.equal(readJson(out.runDir, 'results.json').clientCompatibilityProven, false, label);
      expectCleanedAndVerified(w, out);
    } finally { cleanup(w); }
  }
});

test('compat command binding: no substitution, extra argument, sibling path or catalog tampering; not selectable from the CLI; fixed id only', async () => {
  const mutations = {
    'sibling path': spec => ({ ...spec, args: [...spec.args.slice(0, -1), 'tests/prepared-import-compat/other.test.ts'] }),
    'rehearsal fixture path': spec => ({ ...spec, args: [...spec.args.slice(0, -1), 'tests/prepared-import-rehearsal/seed-prepared-imports.test.ts'] }),
    'other directory': spec => ({ ...spec, args: [...spec.args.slice(0, -1), 'tests/local-folder-import/prepare-modality-idempotency.test.ts'] }),
    'glob': spec => ({ ...spec, args: [...spec.args.slice(0, -1), 'tests/prepared-import-compat/*.test.ts'] }),
    'added argument': spec => ({ ...spec, args: [...spec.args, '--import', 'evil'] }),
    'added flag': spec => ({ ...spec, args: ['--env-file', '.env', ...spec.args] }),
    'different cwd': spec => ({ ...spec, cwd: '.' }),
    'dropped compatOnly': ({ compatOnly, ...rest }) => rest,
    'different marker': spec => ({ ...spec, compatOnly: REHEARSAL_ID }),
    'kind seed': spec => ({ ...spec, kind: 'seed' }),
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const w = world();
    try { writeFileSync(join(w.root, 'scripts/db-safety/commands.json'), JSON.stringify({ ...CATALOG, [COMPAT_COMMAND]: mutate(COMPAT_SPEC) })); await assert.rejects(() => compatRun(w), /COMPAT_COMMAND_TAMPERED/, label); expectNothingStarted(w, label); } finally { cleanup(w); }
  }
  const absent = world();
  try { const { [COMPAT_COMMAND]: _x, ...rest } = CATALOG; writeFileSync(join(absent.root, 'scripts/db-safety/commands.json'), JSON.stringify(rest)); await assert.rejects(() => compatRun(absent), /COMPAT_COMMAND_TAMPERED/); } finally { cleanup(absent); }
  const missing = world();
  try { rmSync(join(missing.root, COMPAT_FILE)); await assert.rejects(() => compatRun(missing), /COMPAT_TEST_MISSING/); expectNothingStarted(missing, 'missing file'); } finally { cleanup(missing); }
  const catalog = guard.read(join(guard.root, 'scripts/db-safety/commands.json'));
  assert.throws(() => validateCommand(COMPAT_COMMAND, catalog), /COMMAND_/);
  assert.equal(validateCommand(COMPAT_ID, catalog), COMPAT_ID);
  assert.deepEqual(Object.keys(COMPATIBILITY), [COMPAT_ID, T015_ID, INGEST_ID]); assert.ok(Object.isFrozen(COMPATIBILITY) && Object.isFrozen(COMPATIBILITY[COMPAT_ID]) && Object.isFrozen(COMPAT_BINDINGS) && Object.isFrozen(COMPAT_BINDINGS.generatedFiles));
  assert.ok(!Object.hasOwn(REHEARSALS, COMPAT_ID) && !Object.hasOwn(COMPATIBILITY, REHEARSAL_ID), 'plans are disjoint');
  for (const bad of ['compat:other', 'compat:', COMPAT_ID + ' --x', COMPAT_ID + ';id', COMPAT_ID + '&&id', COMPAT_ID + '\n', COMPAT_ID + '/../x', COMPAT_ID.toUpperCase(), '$(' + COMPAT_ID + ')', COMPAT_ID + ' ' + COMPAT_COMMAND, COMPAT_COMMAND + ' ' + COMPAT_ID, 'compat:__proto__', 'compat:constructor']) assert.throws(() => validateCommand(bad, catalog), /COMMAND_/, JSON.stringify(bad));
  const standalone = world();
  try { await assert.rejects(() => runFocusedTest(COMPAT_COMMAND, standalone.deps), /COMMAND_/); expectNothingStarted(standalone, 'standalone child command'); } finally { cleanup(standalone); }
});

test('compat test source scan: only @/lib/db reaches the database; raw SQL, drivers, process spawning, alternate clients and sockets are rejected', async () => {
  const real = readFileSync(join(guard.root, COMPAT_FILE), 'utf8');
  assert.deepEqual(scanCompatTestSource(real), [], 'the real compatibility test is clean (it uses @/lib/db and the generated enums only)');
  assert.ok(/from "@\/lib\/db"/.test(real) && /from "@internal\/db"/.test(real), 'the required application client import is allowed');
  const gate = 'import "../../../../scripts/db-safety/test-entry.cjs";\n';
  const base = gate + 'import test from "node:test";\nimport { db } from "@/lib/db";\n';
  assert.deepEqual(scanCompatTestSource(base + 'test("x", async () => { await db.user.count(); });\n'), []);
  const bad = {
    'raw query': [base + 'await db.$queryRaw`select 1`;\n', 'RAW_SQL'],
    'raw execute': [base + 'await db.$executeRawUnsafe("select 1");\n', 'RAW_SQL'],
    'query unsafe': [base + 'await db.$queryRawUnsafe("x");\n', 'RAW_SQL'],
    'Prisma.sql': [base + 'const q = Prisma.sql`x`;\n', 'RAW_SQL'],
    'Prisma.raw': [base + 'const q = Prisma.raw("x");\n', 'RAW_SQL'],
    'pg driver': [base + 'import { Client } from "pg";\n', 'IMPORT_NOT_ALLOWED:pg'],
    'pg driver (violation code)': [base + 'import { Client } from "pg";\n', 'DIRECT_POSTGRES_DRIVER'],
    'postgres driver': [base + 'import postgres from "postgres";\n', 'DIRECT_POSTGRES_DRIVER'],
    'child_process import': [base + 'import { spawnSync } from "node:child_process";\n', 'PROCESS_SPAWN'],
    'child_process not allowed import': [base + 'import { spawnSync } from "node:child_process";\n', 'IMPORT_NOT_ALLOWED:node:child_process'],
    'spawn psql': [base + 'spawnSync("psql", ["-c", "select 1"]);\n', 'DB_OR_CONTAINER_TOOL'],
    'pg_dump': [base + '// pg_dump is not allowed\n', 'DB_OR_CONTAINER_TOOL'],
    'docker': [base + 'const t = "docker";\n', 'DB_OR_CONTAINER_TOOL'],
    'new PrismaClient': [base + 'const other = new PrismaClient();\n', 'ALTERNATE_PRISMA_CLIENT'],
    'PrismaClient import': [base + 'import { PrismaClient } from "@internal/db";\n', 'ALTERNATE_PRISMA_CLIENT'],
    '@prisma/client': [base + 'import { PrismaClient } from "@prisma/client";\n', 'ALTERNATE_PRISMA_CLIENT'],
    'generated client path': [base + 'import { PrismaClient } from "../../../../lib/generated/prisma/client";\n', 'ALTERNATE_PRISMA_CLIENT'],
    'generated client path (import allowlist)': [base + 'import * as c from "../../../../lib/generated/prisma/client";\n', 'IMPORT_NOT_ALLOWED:../../../../lib/generated/prisma/client'],
    'generated internal': [base + 'import { x } from "../../../../lib/generated/prisma/internal/class";\n', 'ALTERNATE_PRISMA_CLIENT'],
    'net socket': [base + 'import net from "node:net";\n', 'SOCKET_OR_DRIVER'],
    'tls': [base + 'import tls from "node:tls";\n', 'SOCKET_OR_DRIVER'],
    'fetch': [base + 'await fetch("http://127.0.0.1:1");\n', 'SOCKET_OR_DRIVER'],
    'ioredis': [base + 'import Redis from "ioredis";\n', 'SOCKET_OR_DRIVER'],
    'minio': [base + 'import { Client } from "minio";\n', 'SOCKET_OR_DRIVER'],
    'require': [base + 'const x = require("pg");\n', 'DYNAMIC_LOADING'],
    'dynamic import': [base + 'const x = await import("pg");\n', 'DYNAMIC_LOADING'],
    'eval': [base + 'eval("1");\n', 'DYNAMIC_LOADING'],
    'other relative helper': [base + 'import { createWorkspaceUser } from "../workspace/helpers.js";\n', 'IMPORT_NOT_ALLOWED:../workspace/helpers.js'],
    'other app module': [base + 'import { thing } from "@/lib/imports/prepare-local-folder-import";\n', 'IMPORT_NOT_ALLOWED:@/lib/imports/prepare-local-folder-import'],
    'missing gate': [base.replace(gate, ''), 'MISSING_FIRST_LINE_GATE'],
    'gate not first': ['// c\n' + base, 'MISSING_FIRST_LINE_GATE'],
    'no application db import': [gate + 'import test from "node:test";\n', 'MUST_USE_APPLICATION_DB'],
  };
  for (const [label, [source, code]] of Object.entries(bad)) { assert.ok(scanCompatTestSource(source).includes(code), `${label}: ${code} in ${JSON.stringify(scanCompatTestSource(source))}`); assert.throws(() => assertCompatTestSource(source), /COMPAT_TEST_SOURCE_FORBIDDEN/, label); }
  // at run time a violating test source aborts before provisioning
  const w = world();
  try { writeFileSync(join(w.root, COMPAT_FILE), bad['raw query'][0]); await assert.rejects(() => compatRun(w), /COMPAT_TEST_SOURCE_FORBIDDEN/); expectNothingStarted(w, 'violating source'); } finally { cleanup(w); }
});

test('compat column-shape validation (read-only) rejects a missing, mistyped, NOT NULL, defaulted or misplaced column; the compat test never runs then', async () => {
  const good = [['PreparedImport', 'id', 'text', 'NO', null, 1], ['PreparedImport', 'idempotencyKey', 'text', 'NO', null, 2], ['PreparedImport', 'creationRequestHash', 'text', 'YES', null, 3], ['Dataset', 'creationRequestHash', 'text', 'YES', null, 9]];
  assert.doesNotThrow(() => assertCompatColumn(good));
  const variants = {
    missing: good.filter(row => !(row[0] === 'PreparedImport' && row[1] === 'creationRequestHash')),
    'wrong type': good.map(row => (row[1] === 'creationRequestHash' && row[0] === 'PreparedImport' ? [...row.slice(0, 2), 'jsonb', ...row.slice(3)] : row)),
    'NOT NULL': good.map(row => (row[1] === 'creationRequestHash' && row[0] === 'PreparedImport' ? [row[0], row[1], row[2], 'NO', row[4], row[5]] : row)),
    'has default': good.map(row => (row[1] === 'creationRequestHash' && row[0] === 'PreparedImport' ? [row[0], row[1], row[2], row[3], "''::text", row[5]] : row)),
    'not last': good.map(row => (row[1] === 'creationRequestHash' && row[0] === 'PreparedImport' ? [row[0], row[1], row[2], row[3], row[4], 1] : row)),
    duplicated: [...good, ['PreparedImport', 'creationRequestHash', 'text', 'YES', null, 4]],
    'only the Dataset column exists': [['PreparedImport', 'id', 'text', 'NO', null, 1], ['Dataset', 'creationRequestHash', 'text', 'YES', null, 9]],
  };
  for (const [label, rows] of Object.entries(variants)) assert.throws(() => assertCompatColumn(rows), /COMPAT_COLUMN_SHAPE_UNEXPECTED/, label);
  for (const [label, m25Mutation] of [['column NOT NULL', db => { db.columns.find(row => row[1] === 'creationRequestHash').splice(3, 1, 'NO'); }], ['column removed', db => { db.columns = db.columns.filter(row => row[1] !== 'creationRequestHash'); }], ['column has default', db => { db.columns.find(row => row[1] === 'creationRequestHash').splice(4, 1, "''::text"); }]]) {
    const w = world({ m25Mutation });
    try {
      const out = await compatRun(w);
      assert.equal(out.result, 'FAIL', label); assert.ok(out.failures.includes('COMPAT_COLUMN_SHAPE_UNEXPECTED'), label + JSON.stringify(out.failures));
      assert.deepEqual(testCalls(w), [], label); assert.equal(readJson(out.runDir, 'results.json').clientCompatibilityProven, false, label);
      expectCleanedAndVerified(w, out);
    } finally { cleanup(w); }
  }
});

test('compat plan failure paths: clientCompatibilityProven stays false, primary and independent cleanup always run, ownership never widens', async () => {
  const cases = [
    ['compat test fails', { compatExit: 1 }, 'COMPAT_TEST_FAILED'],
    ['migration 24 deploy fails', { failDeployAt: 2 }, 'PROPOSAL_DEPLOY_FAILED'],
    ['migration 25 deploy fails', { failDeployAt: 3 }, 'PROPOSAL_DEPLOY_FAILED'],
    ['baseline deploy fails', { failDeployAt: 1 }, 'BASELINE_DEPLOY_FAILED'],
    ['baseline receipt issuance fails', { failApproveAt: 1 }, 'RECEIPT_ISSUE_FAILED'],
    ['migration 24 receipt issuance fails', { failApproveAt: 2 }, 'RECEIPT_ISSUE_FAILED'],
    ['migration 25 receipt issuance fails', { failApproveAt: 3 }, 'RECEIPT_ISSUE_FAILED'],
    ['compat receipt issuance fails', { failApproveAt: 4 }, 'RECEIPT_ISSUE_FAILED'],
    ['wrongly scoped receipt', { receiptMode: 'wrong-command' }, 'RECEIPT_SCOPE_MISMATCH'],
    ['application system identifier', { systemIdentifier: guard.applicationSystem }, 'SYSTEM_IDENTITY_MISMATCH'],
    ['schema drifts during the run', { onCompatTest: root => writeFileSync(join(root, SCHEMA_PATH), SCHEMA_TEXT_DRIFT()) }, 'FROZEN_SCHEMA_DRIFT'],
    ['generated client drifts during the run', { onCompatTest: root => writeFileSync(join(root, CLIENT_DIR, 'internal/class.ts'), 'tampered\n') }, 'FROZEN_CLIENT_FILE_DRIFT'],
    ['active chain drifts during the run', { onCompatTest: root => writeFileSync(join(root, 'prisma/migrations/202601000_m/migration.sql'), 'SELECT 99;\n') }, 'FROZEN_ACTIVE_CHAIN_DRIFT'],
  ];
  for (const [label, options, expected] of cases) {
    const w = world(options);
    try {
      const out = await compatRun(w);
      assert.equal(out.result, 'FAIL', label); assert.ok(out.failures.includes(expected) || out.failures.some(failure => failure.startsWith(expected)), label + JSON.stringify(out.failures));
      if (existsSync(join(out.runDir, 'results.json'))) { const results = readJson(out.runDir, 'results.json'); assert.equal(results.clientCompatibilityProven, false, label); assert.equal(results.result, 'FAIL'); }
      assert.equal(readJson(out.runDir, 'focused-run.json').clientCompatibilityProven, false, label);
      assert.ok(testCalls(w).every(name => name === COMPAT_COMMAND), label + ': nothing but the compat test ever runs');
      expectCleanedAndVerified(w, out);
    } finally { cleanup(w); }
  }
  const partial = world({ failRunRole: 'redis' });
  try { const out = await compatRun(partial); assert.equal(out.result, 'FAIL'); expectCleanedAndVerified(partial, out, 1); assert.equal(partial.approveCalls.length, 0); assert.equal(readJson(out.runDir, 'results.json').clientCompatibilityProven, false); } finally { cleanup(partial); }
  const cleanupFail = world({ rmStatus: 1 });
  try { const out = await compatRun(cleanupFail); assert.equal(out.result, 'FAIL'); assert.ok(out.failures.includes('PRIMARY_CLEANUP_FAILED')); assert.equal(readJson(out.runDir, 'results.json').clientCompatibilityProven, false, 'a cleanup failure revokes the verdict'); assert.equal(cleanupFail.verifiedRunDir, out.runDir); } finally { cleanup(cleanupFail); }
  const independentFail = world({ cleanupVerifyStatus: 1 });
  try { const out = await compatRun(independentFail); assert.equal(out.result, 'FAIL'); assert.ok(out.failures.includes('INDEPENDENT_CLEANUP_FAILED')); assert.equal(readJson(out.runDir, 'results.json').clientCompatibilityProven, false); } finally { cleanup(independentFail); }
});

test('existing plans are unchanged: the three focused commands stay migration-24-only and the migration-25 rehearsal keeps its own evidence and topology', async () => {
  for (const name of SUPPORTED_COMMANDS) assert.deepEqual(resolvePlan(name), { kind: 'test', id: name, through: 1 });
  assert.equal(resolvePlan(REHEARSAL_ID).kind, 'rehearsal'); assert.equal(resolvePlan(COMPAT_ID).kind, 'compat'); assert.equal(resolvePlan(COMPAT_ID).through, 2);
  assert.deepEqual(SUPPORTED_COMMANDS, [COMMAND, 'web:test:dataset-patch-route', 'web:test:local-folder-modality-idempotency', 'web:test:imports-ui:vitest', 'worker:test:ingestion-replay-reuse']);
  const rehearsal = world();
  try {
    const out = await runFocusedTest(REHEARSAL_ID, rehearsal.deps);
    assert.equal(out.result, 'PASS', JSON.stringify(out.failures));
    const results = readJson(out.runDir, 'results.json');
    assert.equal(results.kind, 'migration-rehearsal'); assert.equal(results.clientCompatibilityProven, undefined, 'the rehearsal never claims client compatibility');
    assert.deepEqual(results.receiptTopology.map(({ step, operation, command }) => [step, operation, command]), [['baseline-deploy', 'deploy', null], ['proposal-1-deploy', 'deploy', null], ['fixture', 'test', FIXTURE_COMMAND], ['proposal-2-deploy', 'deploy', null]]);
    assert.deepEqual(testCalls(rehearsal), [FIXTURE_COMMAND]); assert.ok(!existsSync(join(out.runDir, 'compat-evidence.json')));
  } finally { cleanup(rehearsal); }
  const focused = world();
  try { const out = await runFocusedTest(COMMAND, focused.deps); assert.equal(out.result, 'PASS'); assert.equal(deployCalls(focused).length, 2); assert.equal(readJson(out.runDir, 'results.json').kind, 'focused-disposable-test'); } finally { cleanup(focused); }
});

test('real repository: the compat plan bindings equal the accepted frozen values and verify against the repository, the catalog entry is pinned, and the test is clean', () => {
  assert.equal(COMPAT_BINDINGS.schemaSha256, '4fe3d96a334e18e504ea14fd5519a1a363fae5ea6d9845355c9d548698eed174');
  assert.equal(COMPAT_BINDINGS.generatedTreeSha256, 'a750e6b900e00991e818b660f7af67866d1c8ea2ec7774ff2f92f0b40fb54a52');
  assert.deepEqual(COMPAT_BINDINGS.generatedFiles, {
    'lib/generated/prisma/internal/class.ts': 'f194d490baba32627a971828abadbcdecb904b0a96ce1e1ca73824019614ec11',
    'lib/generated/prisma/internal/prismaNamespace.ts': '059962520fae3aa7dbabf3f704e278e0d832c8307101fa8d5f02fa147406866b',
    'lib/generated/prisma/internal/prismaNamespaceBrowser.ts': '247578b6c493d6fd8a69ff0f55d6beb2a3b943c62091ff1f9459671195f95a47',
    'lib/generated/prisma/models/PreparedImport.ts': 'd48ac861e7e8d6020d614a6faf706f9f4a146447c0599faabe798a02251af45d',
    'lib/generated/prisma/libquery_engine-debian-openssl-3.0.x.so.node': 'a2924eab1c78a0a7bb67edac5738939fa10589ef073af5542f53812a22e4a7d8',
  });
  assert.doesNotThrow(() => verifyCompatBindings(realDeps()));
  assert.deepEqual(PROPOSAL_CHAIN.map(entry => entry.sha256), ['13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7', 'a8ffbc84bde7f18aac93bbb2e87423e6cfcbf6efd95c01e6650824fdcc3ed859']);
  const catalog = guard.read(join(guard.root, 'scripts/db-safety/commands.json'));
  assert.deepEqual(catalog[COMPAT_COMMAND], COMPAT_SPEC); assert.equal(catalog[COMPAT_COMMAND].compatOnly, COMPAT_ID); assert.ok(!SUPPORTED_COMMANDS.includes(COMPAT_COMMAND));
  const dir = join(guard.root, 'apps/web/tests/prepared-import-compat');
  assert.doesNotThrow(() => guard.assertEntryScope(catalog[COMPAT_COMMAND], join(dir, 'client-compat.test.ts'), []));
  for (const other of [join(dir, 'other.test.ts'), join(guard.root, 'apps/web/tests/prepared-import-rehearsal/seed-prepared-imports.test.ts'), join(guard.root, 'apps/web/tests/dataset-metadata/dataset-patch-route.test.ts')]) assert.throws(() => guard.assertEntryScope(catalog[COMPAT_COMMAND], other, []), /ENTRY_COMMAND_SCOPE_MISMATCH/, other);
  for (const [name, spec] of Object.entries(catalog)) if (name !== COMPAT_COMMAND) { assert.equal(spec.compatOnly, undefined, name); assert.ok(!JSON.stringify(spec.args).includes('prepared-import-compat'), name); }
  assert.deepEqual(scanCompatTestSource(readFileSync(join(guard.root, COMPAT_FILE), 'utf8')), []);
  assert.ok(guard.protectedSources().includes(join(guard.root, COMPAT_FILE)));
});


// =====================================================================================================================
// T015 confirmed-taxonomy verification plan (verify:confirmed-taxonomy-creation): same frozen bindings, one different bound test
// =====================================================================================================================
const T015_TOPOLOGY = [['baseline-deploy', 'deploy', null], ['proposal-1-deploy', 'deploy', null], ['proposal-2-deploy', 'deploy', null], ['t015-test', 'test', T015_COMMAND]];
const t015Run = w => runFocusedTest(T015_ID, w.deps);

test('T015 plan: chain through migration 25, the one bound creation-paths test, classification, flag semantics, topology and cleanup', async () => {
  const w = world();
  try {
    const before = snapshot(w.root);
    const out = await t015Run(w);
    assert.equal(out.result, 'PASS', JSON.stringify(out.failures));
    assert.equal(deployCalls(w).length, 3);
    assert.deepEqual(testCalls(w), [T015_COMMAND], 'only the T015 test runs: no compat test, no fixture, no application test');
    const results = readJson(out.runDir, 'results.json'), initial = readJson(out.runDir, 'focused-run.json'), evidence = readJson(out.runDir, 'compat-evidence.json');
    for (const record of [initial, results]) {
      assert.equal(record.kind, 'confirmed-taxonomy-verification'); assert.equal(record.scope, 'confirmed-taxonomy-creation');
      assert.equal(record.countsAsG3Evidence, false); assert.equal(record.countsAsG5Evidence, false);
      assert.equal(record.migrationBehaviorAlreadyProvenSeparately, true); assert.equal(record.notAuthorizationToApplyMigration, true);
      assert.equal('clientCompatibilityProven' in record, false, 'the T015 verification never claims client compatibility');
    }
    assert.equal(initial.t015DisposableVerified, false); assert.equal(evidence.t015DisposableVerified, false); assert.equal(results.t015DisposableVerified, true);
    assert.deepEqual(results.receiptTopology.map(({ step, operation, command }) => [step, operation, command]), T015_TOPOLOGY);
    assert.deepEqual([...results.cleanup.receiptRegistrationIds].sort(), results.receiptTopology.map(entry => entry.receiptId).sort());
    assert.equal(evidence.schemaSha256, w.deps.pinned.compat.schemaSha256); assert.equal(evidence.generatedTreeSha256, w.deps.pinned.compat.generatedTreeSha256);
    assert.equal(snapshot(w.root), before);
    expectCleanedAndVerified(w, out);
  } finally { cleanup(w); }
});

test('T015 plan: frozen bindings, chain, command binding and test source are enforced before provisioning; failures keep the flag false', async () => {
  const drifts = {
    'schema edited': root => writeFileSync(join(root, SCHEMA_PATH), SCHEMA_TEXT_DRIFT()),
    'generated file edited': root => writeFileSync(join(root, CLIENT_DIR, 'models/PreparedImport.ts'), 'tampered\n'),
    'generated file added': root => writeFileSync(join(root, CLIENT_DIR, 'models/Extra.ts'), 'x'),
    'active chain edited': root => writeFileSync(join(root, 'prisma/migrations/202601000_m/migration.sql'), 'SELECT 99;\n'),
    'migration 24 bytes': root => writeFileSync(join(root, P1.path, 'migration.sql'), PROPOSAL1_SQL + '-- x\n'),
    'migration 25 bytes': root => writeFileSync(join(root, P2.path, 'migration.sql'), PROPOSAL2_SQL + '-- x\n'),
    'test file missing': root => rmSync(join(root, T015_FILE)),
  };
  for (const [label, mutate] of Object.entries(drifts)) { const w = world(); try { mutate(w.root); await assert.rejects(() => t015Run(w), /FROZEN_|PROPOSAL_|COMPAT_TEST_MISSING/, label); expectNothingStarted(w, label); } finally { cleanup(w); } }
  const mutations = {
    'sibling path': spec => ({ ...spec, args: [...spec.args.slice(0, -1), 'tests/confirmed-taxonomy/other.test.ts'] }),
    'compat test path': spec => ({ ...spec, args: [...spec.args.slice(0, -1), 'tests/prepared-import-compat/client-compat.test.ts'] }),
    'glob': spec => ({ ...spec, args: [...spec.args.slice(0, -1), 'tests/confirmed-taxonomy/*.test.ts'] }),
    'added argument': spec => ({ ...spec, args: [...spec.args, '--import', 'evil'] }),
    'different cwd': spec => ({ ...spec, cwd: '.' }),
    'dropped marker': ({ verifyOnly, ...rest }) => rest,
    'compat marker instead': ({ verifyOnly, ...rest }) => ({ ...rest, compatOnly: COMPAT_ID }),
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const w = world();
    try { writeFileSync(join(w.root, 'scripts/db-safety/commands.json'), JSON.stringify({ ...CATALOG, [T015_COMMAND]: mutate(T015_SPEC) })); await assert.rejects(() => t015Run(w), /COMPAT_COMMAND_TAMPERED/, label); expectNothingStarted(w, label); } finally { cleanup(w); }
  }
  const violating = world();
  try { writeFileSync(join(violating.root, T015_FILE), readFileSync(join(guard.root, T015_FILE), 'utf8') + '\nawait db.$queryRaw`select 1`;\n'); await assert.rejects(() => t015Run(violating), /COMPAT_TEST_SOURCE_FORBIDDEN/); expectNothingStarted(violating, 'raw sql'); } finally { cleanup(violating); }
  const cases = [
    ['T015 test fails', { compatExit: 1 }, 'COMPAT_TEST_FAILED'], ['migration 25 deploy fails', { failDeployAt: 3 }, 'PROPOSAL_DEPLOY_FAILED'], ['receipt issuance fails', { failApproveAt: 4 }, 'RECEIPT_ISSUE_FAILED'],
    ['schema drifts during the run', { onCompatTest: root => writeFileSync(join(root, SCHEMA_PATH), SCHEMA_TEXT_DRIFT()) }, 'FROZEN_SCHEMA_DRIFT'], ['column shape wrong', { m25Mutation: db => db.columns.find(row => row[1] === 'creationRequestHash').splice(3, 1, 'NO') }, 'COMPAT_COLUMN_SHAPE_UNEXPECTED'],
    ['cleanup fails', { rmStatus: 1 }, 'PRIMARY_CLEANUP_FAILED'], ['independent cleanup fails', { cleanupVerifyStatus: 1 }, 'INDEPENDENT_CLEANUP_FAILED'],
  ];
  for (const [label, options, expected] of cases) {
    const w = world(options);
    try {
      const out = await t015Run(w);
      assert.equal(out.result, 'FAIL', label); assert.ok(out.failures.includes(expected), label + JSON.stringify(out.failures));
      assert.equal(readJson(out.runDir, 'results.json').t015DisposableVerified, false, label); assert.equal(readJson(out.runDir, 'focused-run.json').t015DisposableVerified, false);
      assert.ok(testCalls(w).every(name => name === T015_COMMAND), label); expectCleanedAndVerified(w, out);
    } finally { cleanup(w); }
  }
});

test('T015 test source scan: only @/lib/db reaches the database; the extra imports are an explicit allowlist and raw SQL, drivers, processes and sockets stay forbidden', () => {
  const real = readFileSync(join(guard.root, T015_FILE), 'utf8');
  assert.deepEqual(scanCompatTestSource(real, 't015'), []);
  assert.ok(scanCompatTestSource(real, 'compat').some(violation => violation.startsWith('IMPORT_NOT_ALLOWED')), 'the narrower compat profile does not allow those imports');
  assert.ok([...T015_ALLOWED_IMPORTS].every(specifier => !/^(pg|postgres|node:child_process|node:net|node:tls)/.test(specifier)));
  const gate = 'import "../../../../scripts/db-safety/test-entry.cjs";\n';
  const base = gate + 'import test from "node:test";\nimport { db } from "@/lib/db";\n';
  assert.deepEqual(scanCompatTestSource(base, 't015'), []);
  const bad = {
    'raw query': [base + 'await db.$queryRaw`x`;\n', 'RAW_SQL'], 'raw unsafe': [base + 'await db.$executeRawUnsafe("x");\n', 'RAW_SQL'],
    'pg import': [base + 'import { Client } from "pg";\n', 'DIRECT_POSTGRES_DRIVER'], 'child_process': [base + 'import { spawnSync } from "node:child_process";\n', 'PROCESS_SPAWN'],
    'psql': [base + 'const x = "psql";\n', 'DB_OR_CONTAINER_TOOL'], 'new PrismaClient': [base + 'const c = new PrismaClient();\n', 'ALTERNATE_PRISMA_CLIENT'],
    'net': [base + 'import net from "node:net";\n', 'SOCKET_OR_DRIVER'], 'fetch': [base + 'await fetch("http://x");\n', 'SOCKET_OR_DRIVER'],
    'dynamic import': [base + 'await import("pg");\n', 'DYNAMIC_LOADING'], 'eval': [base + 'eval("1");\n', 'DYNAMIC_LOADING'],
    'require of a driver': [base + 'const x = require("pg");\n', 'REQUIRE_NOT_ALLOWED:pg'], 'require of child_process': [base + 'const x = require("node:child_process");\n', 'REQUIRE_NOT_ALLOWED:node:child_process'],
    'computed require': [base + 'const x = require(name);\n', 'DYNAMIC_LOADING'], 'other app module import': [base + 'import { x } from "@/lib/auth";\n', 'IMPORT_NOT_ALLOWED:@/lib/auth'],
    'missing gate': [base.replace(gate, ''), 'MISSING_FIRST_LINE_GATE'], 'no app db': [gate + 'import test from "node:test";\n', 'MUST_USE_APPLICATION_DB'],
  };
  for (const [label, [source, code]] of Object.entries(bad)) assert.ok(scanCompatTestSource(source, 't015').includes(code), `${label}: ${code} in ${JSON.stringify(scanCompatTestSource(source, 't015'))}`);
  assert.deepEqual(scanCompatTestSource(base + 'const require = createRequire(import.meta.url);\nconst a = require("@/app/api/datasets/route");\n', 't015').filter(v => v !== 'IMPORT_NOT_ALLOWED:node:module'), [], 'the route-load pattern is allowed');
});

test('T015 plan wiring is fixed: not selectable as a bare child command, disjoint from the other plans, injection-proof, and the real catalog entry is pinned', () => {
  const catalog = guard.read(join(guard.root, 'scripts/db-safety/commands.json'));
  assert.throws(() => validateCommand(T015_COMMAND, catalog), /COMMAND_/);
  assert.equal(validateCommand(T015_ID, catalog), T015_ID);
  assert.deepEqual(resolvePlan(T015_ID).kind, 'compat'); assert.equal(resolvePlan(T015_ID).stepName, 't015-test'); assert.equal(resolvePlan(T015_ID).provenFlag, 't015DisposableVerified');
  assert.ok(Object.isFrozen(COMPATIBILITY[T015_ID]) && !Object.hasOwn(REHEARSALS, T015_ID));
  for (const bad of ['verify:other', 'verify:', T015_ID + ' --x', T015_ID + ';id', T015_ID + '&&id', T015_ID + '\n', T015_ID + '/../x', T015_ID.toUpperCase(), '$(' + T015_ID + ')', T015_ID + ' ' + T015_COMMAND, T015_COMMAND + ' ' + T015_ID, 'verify:__proto__']) assert.throws(() => validateCommand(bad, catalog), /COMMAND_/, JSON.stringify(bad));
  assert.deepEqual(catalog[T015_COMMAND], T015_SPEC); assert.equal(catalog[T015_COMMAND].verifyOnly, T015_ID); assert.ok(!SUPPORTED_COMMANDS.includes(T015_COMMAND));
  const dir = join(guard.root, 'apps/web/tests/confirmed-taxonomy');
  assert.doesNotThrow(() => guard.assertEntryScope(catalog[T015_COMMAND], join(dir, 'creation-paths.test.ts'), []));
  for (const other of [join(dir, 'other.test.ts'), join(guard.root, 'apps/web/tests/prepared-import-compat/client-compat.test.ts'), join(guard.root, 'apps/web/tests/local-folder-import/prepare-modality-idempotency.test.ts')]) assert.throws(() => guard.assertEntryScope(catalog[T015_COMMAND], other, []), /ENTRY_COMMAND_SCOPE_MISMATCH/, other);
  for (const [name, spec] of Object.entries(catalog)) if (name !== T015_COMMAND && name !== INGEST_COMMAND) { assert.equal(spec.verifyOnly, undefined, name); assert.ok(!JSON.stringify(spec.args).includes('confirmed-taxonomy'), name); }
  assert.ok(guard.protectedSources().includes(join(guard.root, T015_FILE)));
  assert.doesNotThrow(() => verifyCompatBindings(realDeps()), 'T015 reuses the unchanged frozen schema/client bindings');
});


// =====================================================================================================================
// web:test:imports-ui:vitest: the one sanctioned command for the import UI / pure-model Vitest specs
// =====================================================================================================================
const UI_COMMAND = 'web:test:imports-ui:vitest';
const UI_SPECS = ['class-combobox-state.vitest.spec.ts', 'confirmed-classes.vitest.spec.ts', 'creation-form-model.vitest.spec.ts', 'modality-class-card.vitest.spec.tsx', 'source-import-preflight-schema.vitest.spec.ts'];
const UI_SPEC = { kind: 'test', cwd: 'apps/web', args: ['node_modules/vitest/vitest.mjs', 'run', ...UI_SPECS.map(file => `tests/imports/${file}`), '--pool=threads', '--environment', 'node'] };

test('imports-ui vitest command: exact structural binding, explicit files only, no glob, watch, config, filter or environment override', () => {
  const catalog = guard.read(join(guard.root, 'scripts/db-safety/commands.json'));
  assert.deepEqual(catalog[UI_COMMAND], UI_SPEC);
  assert.ok(UI_SPEC.args.every(arg => !/[*?]/.test(arg)) && !UI_SPEC.args.filter(arg => arg !== '--environment' && arg !== '--pool=threads').some(arg => /--(watch|config|env|root|dir|reporter|coverage|ui)|^-[a-z]$/.test(arg)));
  assert.deepEqual(UI_SPEC.args.filter(arg => arg.startsWith('-')), ['--pool=threads', '--environment']);
  assert.deepEqual(UI_SPEC.args.filter(arg => arg.endsWith('.ts') || arg.endsWith('.tsx')), UI_SPECS.map(file => `tests/imports/${file}`));
  assert.ok(SUPPORTED_COMMANDS.includes(UI_COMMAND));
  assert.equal(validateCommand(UI_COMMAND, catalog), UI_COMMAND);
  assert.deepEqual(resolvePlan(UI_COMMAND), { kind: 'test', id: UI_COMMAND, through: 1 });
  for (const injected of [UI_COMMAND + ' --watch', UI_COMMAND + ' tests/x.spec.ts', UI_COMMAND + ';id', UI_COMMAND + '&&id', UI_COMMAND + '\n', UI_COMMAND + '/../x', UI_COMMAND.toUpperCase(), '$(' + UI_COMMAND + ')']) assert.throws(() => validateCommand(injected, catalog), /COMMAND_/, JSON.stringify(injected));
});

test('imports-ui vitest command: the receipt scope binds the exact files and flags (the existing source-connections vitest command is untouched)', () => {
  const catalog = guard.read(join(guard.root, 'scripts/db-safety/commands.json'));
  const spec = catalog[UI_COMMAND];
  const entry = join(guard.root, 'apps/web', spec.args[0]);
  const flags = spec.args.slice(1);
  assert.doesNotThrow(() => guard.assertEntryScope(spec, entry, flags));
  const attempts = {
    'extra spec file': [...flags.slice(0, -2), 'tests/workspace/ai-batch-selection.vitest.spec.ts', ...flags.slice(-2)],
    'a spec file removed': flags.filter(arg => arg !== 'tests/imports/creation-form-model.vitest.spec.ts'),
    'reordered files': [flags[0], flags[2], flags[1], ...flags.slice(3)],
    'a glob': ['run', 'tests/imports/*.vitest.spec.ts', '--pool=threads', '--environment', 'node'],
    'forks pool': flags.map(arg => (arg === '--pool=threads' ? '--pool=forks' : arg)), 'pool removed': flags.filter(arg => arg !== '--pool=threads'), 'isolate off': [...flags, '--no-isolate'],
    'watch': [...flags, '--watch'], 'config override': [...flags, '--config', 'evil.config.ts'], 'name filter': [...flags, '-t', 'x'],
    'jsdom environment': [...flags.slice(0, -1), 'jsdom'], 'no environment': flags.slice(0, -2), 'reporter': [...flags, '--reporter=verbose'], 'root': [...flags, '--root', '/'],
  };
  for (const [label, args] of Object.entries(attempts)) assert.throws(() => guard.assertEntryScope(spec, entry, args), /ENTRY_ARGUMENT_SCOPE_MISMATCH|ENTRY_COMMAND_SCOPE_MISMATCH/, label);
  assert.throws(() => guard.assertEntryScope(spec, join(guard.root, 'apps/web/node_modules/vitest/other.mjs'), flags), /ENTRY_COMMAND_SCOPE_MISMATCH/);
  // the pre-existing Vitest command is not broadened
  assert.deepEqual(catalog['web:test:source-connections:vitest'].args, ['node_modules/vitest/vitest.mjs', 'run', 'tests/source-connections/source-access-policy.vitest.spec.ts', '--environment', 'node']);
  for (const [name, other] of Object.entries(catalog)) if (name !== UI_COMMAND) assert.ok(!UI_SPECS.some(file => JSON.stringify(other.args).includes(file)), `${name} must not run the UI specs`);
});

test('imports-ui vitest command: every bound spec exists with the first-line gate, and the Vitest configuration and shim are protected sources', () => {
  for (const file of UI_SPECS) {
    const path = join(guard.root, 'apps/web/tests/imports', file);
    assert.ok(existsSync(path), file);
    assert.match(readFileSync(path, 'utf8').split('\n')[0], /import .*db-safety\/test-entry.cjs/, file);
    assert.ok(guard.protectedSources().includes(path), file + ' is a protected source');
  }
  const protectedPaths = guard.protectedSources();
  assert.ok(protectedPaths.includes(join(guard.root, 'apps/web/vitest.config.ts')), 'the Vitest configuration is covered by every receipt');
  assert.ok(protectedPaths.includes(join(guard.root, 'apps/web/tests/setup/server-only-shim.ts')), 'the server-only shim is covered');
  assert.ok(existsSync(join(guard.root, 'apps/web/vitest.config.ts')));
});

test('imports-ui vitest command runs through the unchanged migration-24-only focused lifecycle and cleanup', async () => {
  const w = world();
  try {
    const out = await runFocusedTest(UI_COMMAND, w.deps);
    assert.equal(out.result, 'PASS', JSON.stringify(out.failures));
    assert.deepEqual(testCalls(w), [UI_COMMAND]); assert.equal(deployCalls(w).length, 2);
    assert.equal(readJson(out.runDir, 'results.json').kind, 'focused-disposable-test');
    expectCleanedAndVerified(w, out);
  } finally { cleanup(w); }
  const failing = world({ testExit: 1 });
  try { const out = await runFocusedTest(UI_COMMAND, failing.deps); assert.equal(out.result, 'FAIL'); assert.ok(out.failures.includes('TEST_COMMAND_FAILED:1')); expectCleanedAndVerified(failing, out); } finally { cleanup(failing); }
});

// =====================================================================================================================
// T019/T020 ingestion replay + commit summary plan (verify:ingestion-replay-summary): same frozen bindings, chain through migration 25
// =====================================================================================================================
const INGEST_TOPOLOGY = [['baseline-deploy', 'deploy', null], ['proposal-1-deploy', 'deploy', null], ['proposal-2-deploy', 'deploy', null], ['ingest-test', 'test', INGEST_COMMAND]];
const ingestRun = w => runFocusedTest(INGEST_ID, w.deps);

test('ingestion plan: chain through migration 25, the one bound test, flag semantics, topology and cleanup', async () => {
  const w = world();
  try {
    const before = snapshot(w.root);
    const out = await ingestRun(w);
    assert.equal(out.result, 'PASS', JSON.stringify(out.failures));
    assert.equal(deployCalls(w).length, 3);
    assert.deepEqual(testCalls(w), [INGEST_COMMAND], 'only the ingestion test runs');
    const results = readJson(out.runDir, 'results.json'), initial = readJson(out.runDir, 'focused-run.json');
    for (const record of [initial, results]) {
      assert.equal(record.kind, 'ingestion-replay-summary-verification'); assert.equal(record.scope, 'ingestion-replay-summary');
      assert.equal(record.countsAsG3Evidence, false); assert.equal(record.countsAsG5Evidence, false); assert.equal(record.notAuthorizationToApplyMigration, true);
      assert.equal('clientCompatibilityProven' in record, false); assert.equal('t015DisposableVerified' in record, false);
    }
    assert.equal(initial.ingestionReplaySummaryDisposableVerified, false); assert.equal(results.ingestionReplaySummaryDisposableVerified, true);
    assert.deepEqual(results.receiptTopology.map(({ step, operation, command }) => [step, operation, command]), INGEST_TOPOLOGY);
    assert.equal(snapshot(w.root), before);
    expectCleanedAndVerified(w, out);
  } finally { cleanup(w); }
});

test('ingestion plan: drift, tampered command and forbidden source are refused before provisioning; failures keep the flag false', async () => {
  const drifts = {
    'schema edited': root => writeFileSync(join(root, SCHEMA_PATH), SCHEMA_TEXT_DRIFT()),
    'migration 25 bytes': root => writeFileSync(join(root, P2.path, 'migration.sql'), PROPOSAL2_SQL + '-- x\n'),
    'test file missing': root => rmSync(join(root, INGEST_FILE)),
  };
  for (const [label, mutate] of Object.entries(drifts)) { const w = world(); try { mutate(w.root); await assert.rejects(() => ingestRun(w), /FROZEN_|PROPOSAL_|COMPAT_TEST_MISSING/, label); expectNothingStarted(w, label); } finally { cleanup(w); } }
  const mutations = {
    'sibling path': spec => ({ ...spec, args: [...spec.args.slice(0, -1), 'tests/dataset-modality/other.test.ts'] }),
    'plain M24 test path': spec => ({ ...spec, args: [...spec.args.slice(0, -1), 'tests/dataset-modality/g4-upload-publisher.test.ts'] }),
    'glob': spec => ({ ...spec, args: [...spec.args.slice(0, -1), 'tests/dataset-modality/*.test.ts'] }),
    'added argument': spec => ({ ...spec, args: [...spec.args, '--import', 'evil'] }),
    'dropped marker': ({ verifyOnly, ...rest }) => rest,
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const w = world();
    try { writeFileSync(join(w.root, 'scripts/db-safety/commands.json'), JSON.stringify({ ...CATALOG, [INGEST_COMMAND]: mutate(INGEST_SPEC) })); await assert.rejects(() => ingestRun(w), /COMPAT_COMMAND_TAMPERED/, label); expectNothingStarted(w, label); } finally { cleanup(w); }
  }
  const violating = world();
  try { writeFileSync(join(violating.root, INGEST_FILE), readFileSync(join(guard.root, INGEST_FILE), 'utf8') + '\nawait db.$queryRaw`select 1`;\n'); await assert.rejects(() => ingestRun(violating), /COMPAT_TEST_SOURCE_FORBIDDEN/); expectNothingStarted(violating, 'raw sql'); } finally { cleanup(violating); }
  for (const [label, options, expected] of [['ingestion test fails', { compatExit: 1 }, 'COMPAT_TEST_FAILED'], ['migration 25 deploy fails', { failDeployAt: 3 }, 'PROPOSAL_DEPLOY_FAILED'], ['cleanup fails', { rmStatus: 1 }, 'PRIMARY_CLEANUP_FAILED'], ['independent cleanup fails', { cleanupVerifyStatus: 1 }, 'INDEPENDENT_CLEANUP_FAILED']]) {
    const w = world(options);
    try {
      const out = await ingestRun(w);
      assert.equal(out.result, 'FAIL', label); assert.ok(out.failures.includes(expected), label + JSON.stringify(out.failures));
      assert.equal(readJson(out.runDir, 'results.json').ingestionReplaySummaryDisposableVerified, false, label);
      assert.ok(testCalls(w).every(name => name === INGEST_COMMAND), label); expectCleanedAndVerified(w, out);
    } finally { cleanup(w); }
  }
});

test('ingestion test source scan: exact allowlists; the real test passes, providers/db stubs are limited to literal allowed specifiers, everything else stays forbidden', () => {
  const real = readFileSync(join(guard.root, INGEST_FILE), 'utf8');
  assert.deepEqual(scanCompatTestSource(real, 'ingest'), []);
  assert.ok(scanCompatTestSource(real, 't015').some(v => v.startsWith('IMPORT_NOT_ALLOWED')), 'the t015 profile does not admit this test');
  assert.ok([...INGEST_ALLOWED_IMPORTS, ...INGEST_ALLOWED_REQUIRES].every(specifier => !/^(pg|postgres|node:child_process|node:net|node:tls|minio|ioredis)/.test(specifier)));
  const bad = {
    'raw query': ['await db.$queryRaw`x`;', 'RAW_SQL'], 'child_process import': ['import "node:child_process";', 'PROCESS_SPAWN'], 'net import': ['import "node:net";', 'SOCKET_OR_DRIVER'],
    'dynamic import': ['await import("x");', 'DYNAMIC_LOADING'], 'bare require': ['const a = require("x");', 'DYNAMIC_LOADING'], 'computed nodeRequire': ['nodeRequire(name);', 'DYNAMIC_LOADING'],
    'unlisted nodeRequire': ['nodeRequire("@/lib/auth");', 'REQUIRE_NOT_ALLOWED:@/lib/auth'], 'unlisted import': ['import "@/lib/auth";', 'IMPORT_NOT_ALLOWED:@/lib/auth'],
    'typeof import of unlisted module': ['type T = typeof import("@/lib/auth");', 'DYNAMIC_LOADING'],
  };
  for (const [label, [snippet, code]] of Object.entries(bad)) assert.ok(scanCompatTestSource(real + '\n' + snippet + '\n', 'ingest').includes(code), `${label}: ${code}`);
  assert.ok(scanCompatTestSource(real.split('\n').slice(1).join('\n'), 'ingest').includes('MISSING_FIRST_LINE_GATE'));
});

test('ingestion plan wiring is fixed: not a bare command, disjoint, injection-proof, the real catalog entry is pinned and the plain M24 command set is unchanged', () => {
  const catalog = guard.read(join(guard.root, 'scripts/db-safety/commands.json'));
  assert.throws(() => validateCommand(INGEST_COMMAND, catalog), /COMMAND_/);
  assert.equal(validateCommand(INGEST_ID, catalog), INGEST_ID);
  assert.deepEqual(catalog[INGEST_COMMAND], INGEST_SPEC);
  assert.equal(catalog['web:test:ingestion-replay'], undefined, 'the plain M24 form is removed: its commit-success control cannot pass without migration 25');
  assert.ok(!SUPPORTED_COMMANDS.includes(INGEST_COMMAND) && !SUPPORTED_COMMANDS.includes('web:test:ingestion-replay'));
  assert.deepEqual(resolvePlan(INGEST_ID), { kind: 'compat', id: INGEST_ID, ...COMPATIBILITY[INGEST_ID] });
  assert.equal(COMPATIBILITY[INGEST_ID].through, 2);
  for (const bad of [INGEST_ID + ' --x', INGEST_ID + ';id', INGEST_ID + '&&id', INGEST_ID + '\n', INGEST_ID + '/../x', INGEST_ID.toUpperCase(), 'verify:ingestion', INGEST_ID + ' ' + INGEST_COMMAND]) assert.throws(() => validateCommand(bad, catalog), /COMMAND_/, JSON.stringify(bad));
});

test('ingestion test file is covered by the protected-source set and the frozen bindings are reused unchanged', () => {
  assert.ok(guard.protectedSources().includes(join(guard.root, INGEST_FILE)));
  assert.equal(guard.read(join(guard.root, 'scripts/db-safety/commands.json'))[INGEST_COMMAND].verifyOnly, INGEST_ID);
  assert.doesNotThrow(() => verifyCompatBindings(realDeps()));
});

// =====================================================================================================================
// Release-chain proof (release:phase029-chain): 23 historical -> synthetic history -> migration 24 -> fixture -> migration 25 -> drift/compat/contracts
// =====================================================================================================================
const baseManifest = () => Array.from({ length: RELEASE_COUNTS.baseline }, (_, index) => ['relation', JSON.stringify(['public', `t${index}`]), [index]]);
const m24Added = () => [
  ...['modality', 'modalityContentRevision', 'modalityResolvedAt', 'modalityResolverSubject'].map(n => ['column', JSON.stringify(['public', 'Dataset', n]), ['x']]),
  ...['dataset_modality_resolution_shape', 'dataset_modality_revision_nonnegative'].map(n => ['constraint', JSON.stringify(['public', 'relation', '"Dataset"', n]), ['y']]),
  ...['asset_modality_write_guard', 'dataset_modality_assignment_guard', 'dataset_modality_insert_guard'].map(n => ['trigger', JSON.stringify(['public', 'Dataset', n]), ['z']]),
  ...['phase029_guard_asset_write()', 'phase029_guard_dataset_assignment()', 'phase029_guard_dataset_insert()'].map(n => ['routine', JSON.stringify(['public', n]), ['f']]),
];
const m25Added = () => [['column', JSON.stringify(['public', 'PreparedImport', 'creationRequestHash']), ['text']]];
const historyRows = count => Array.from({ length: count }, (_, index) => ({ migration_name: `m${index}`, checksum: 'c'.repeat(64), finished_at: 't', rolled_back_at: null }));
const captureOf = (overrides = {}) => ({
  schemaManifest: baseManifest(), migrations: historyRows(23), tables: { Asset: [1, 'a'], Dataset: [3, 'd'], User: [1, 'u'] }, preparedImport: [],
  datasetLegacy: [3, 'legacy'], datasetModality: ['a', 'b', 'c'].map(id => ({ id, m: null, r: null, t: null, s: null })), ...overrides,
});
const p1Ctx = { proposal: { name: PROPOSAL_CHAIN[0].name, sha256: PROPOSAL_CHAIN[0].sha256 } };
const after24 = (mutate = x => x) => {
  const pre = captureOf();
  const post = captureOf({ schemaManifest: [...baseManifest(), ...m24Added()], migrations: [...historyRows(23), { migration_name: PROPOSAL_CHAIN[0].name, checksum: PROPOSAL_CHAIN[0].sha256, finished_at: 't', rolled_back_at: null }], datasetModality: ['a', 'b', 'c'].map(id => ({ id, m: null, r: 0, t: null, s: null })) });
  mutate(post);
  return [pre, post];
};

test('release counts and the manifest definition are pinned: 1829 -> 1841 -> 1842, reviewed CTE bytes, single-line extraction', () => {
  assert.deepEqual(RELEASE_COUNTS, { baseline: 1829, m24: 1841, m25: 1842 });
  assert.equal(RELEASE_COUNTS.m24 - RELEASE_COUNTS.baseline, 12); assert.equal(RELEASE_COUNTS.m25 - RELEASE_COUNTS.m24, 1);
  const sql = releaseManifestSqlFrom(join(guard.root, RECOVERY_REVIEW.path));
  assert.ok(!sql.includes('\n') && !sql.includes('expected_after') && sql.startsWith('WITH objects AS (') && sql.endsWith('FROM objects;'));
  assert.throws(() => extractManifestSql('nothing here'), /RECOVERY_REVIEW_MANIFEST_NOT_FOUND/);
  assert.throws(() => extractManifestSql('WITH objects AS ( SELECT 1 )'), /RECOVERY_REVIEW_MANIFEST_NOT_FOUND/);
  const dir = mkdtempSync(join(tmpdir(), 'rv-'));
  try { writeFileSync(join(dir, 'x.sql'), readFileSync(join(guard.root, RECOVERY_REVIEW.path), 'utf8') + '-- edited\n'); assert.throws(() => releaseManifestSqlFrom(join(dir, 'x.sql')), /RECOVERY_REVIEW_DRIFT/); } finally { rmSync(dir, { recursive: true, force: true }); }
  const extra = releaseExtraSql('SELECT 1;');
  assert.deepEqual(Object.keys(extra), ['schemaManifest', 'datasetLegacy', 'datasetModality']);
  const script = captureScript(['Dataset', 'User'], extra);
  assert.equal(script.keys.length, 8 + 3); assert.equal(script.statements.length, 8 + 3 + 2);
  assert.ok(Object.values(extra).every(statement => !statement.includes('\n') && !/INSERT|UPDATE|DELETE|DROP|ALTER|CREATE/i.test(statement.replace('SELECT 1;', ''))), 'extra captures are read-only single-line selects');
});

test('assertRelease24: accepts exactly the 12 expected additions and an unchanged, unresolved historical state', () => {
  const [pre, post] = after24();
  const evidence = assertRelease24(pre, post, p1Ctx);
  assert.deepEqual(evidence.map(item => item.name), ['schema-delta', 'migration-history', 'no-data-change', 'historical-datasets-unresolved']);
  assert.deepEqual(evidence[0], { name: 'schema-delta', pass: true, from: 1829, to: 1841, columns: 4, constraints: 2, triggers: 3, functions: 3, removed: 0, changed: 0 });
});
test('assertRelease24 fails closed on every deviation', () => {
  const cases = {
    'wrong baseline count': [pre => { pre.schemaManifest.pop(); }, 'RELEASE_M24_SCHEMA_COUNT_UNEXPECTED'],
    'extra added entry': [(pre, post) => { post.schemaManifest.push(['index', '["public","x"]', 'i']); }, 'RELEASE_M24_SCHEMA_COUNT_UNEXPECTED'],
    'changed existing entry': [(pre, post) => { post.schemaManifest[5] = [...post.schemaManifest[5].slice(0, 2), ['changed']]; }, 'RELEASE_M24_SCHEMA_DELTA_UNEXPECTED'],
    'removed existing entry': [(pre, post) => { post.schemaManifest.splice(5, 1, ['relation', '["public","other"]', [1]]); }, 'RELEASE_M24_SCHEMA_DELTA_UNEXPECTED'],
    'wrong column name': [(pre, post) => { post.schemaManifest[post.schemaManifest.length - 12] = ['column', '["public","Dataset","modalityX"]', ['x']]; }, 'RELEASE_M24_COLUMNS_UNEXPECTED'],
    'wrong table for a column': [(pre, post) => { post.schemaManifest[post.schemaManifest.length - 12] = ['column', '["public","Asset","modality"]', ['x']]; }, 'RELEASE_M24_COLUMNS_UNEXPECTED'],
    'wrong constraint': [(pre, post) => { post.schemaManifest[post.schemaManifest.length - 8] = ['constraint', '["public","relation","\\"Dataset\\"","other"]', ['y']]; }, 'RELEASE_M24_CONSTRAINTS_UNEXPECTED'],
    'wrong trigger': [(pre, post) => { post.schemaManifest[post.schemaManifest.length - 6] = ['trigger', '["public","Dataset","other"]', ['z']]; }, 'RELEASE_M24_TRIGGERS_UNEXPECTED'],
    'wrong function': [(pre, post) => { post.schemaManifest[post.schemaManifest.length - 1] = ['routine', '["public","other()"]', ['f']]; }, 'RELEASE_M24_ROUTINES_UNEXPECTED'],
    'history: extra row': [(pre, post) => { post.migrations.push(historyRows(1)[0]); }, 'RELEASE_M24_HISTORY_UNEXPECTED'],
    'history: earlier record changed': [(pre, post) => { post.migrations[3] = { ...post.migrations[3], checksum: 'd'.repeat(64) }; }, 'RELEASE_M24_HISTORY_UNEXPECTED'],
    'history: wrong checksum': [(pre, post) => { post.migrations.at(-1).checksum = 'e'.repeat(64); }, 'RELEASE_M24_HISTORY_UNEXPECTED'],
    'history: unfinished': [(pre, post) => { post.migrations.at(-1).finished_at = null; }, 'RELEASE_M24_HISTORY_UNEXPECTED'],
    'other table changed': [(pre, post) => { post.tables.Asset = [2, 'a2']; }, 'RELEASE_M24_DATA_CHANGED'],
    'table set changed': [(pre, post) => { post.tables.Extra = [0, 'e']; }, 'RELEASE_M24_DATA_CHANGED'],
    'dataset legacy changed': [(pre, post) => { post.datasetLegacy = [3, 'different']; }, 'RELEASE_M24_DATASET_CHANGED'],
    'no historical datasets seeded': [(pre, post) => { pre.datasetLegacy = [0, 'x']; post.datasetLegacy = [0, 'x']; post.datasetModality = []; }, 'RELEASE_M24_DATASET_CHANGED'],
    'dataset resolved by the migration': [(pre, post) => { post.datasetModality[1].m = 'IMAGE'; }, 'RELEASE_M24_DATASET_NOT_UNRESOLVED'],
    'dataset revision not zero': [(pre, post) => { post.datasetModality[0].r = 1; }, 'RELEASE_M24_DATASET_NOT_UNRESOLVED'],
    'dataset resolver subject set': [(pre, post) => { post.datasetModality[2].s = 'u'; }, 'RELEASE_M24_DATASET_NOT_UNRESOLVED'],
    'prepared imports changed': [(pre, post) => { post.preparedImport = [{ id: 'x' }]; }, 'RELEASE_M24_DATA_CHANGED'],
  };
  for (const [label, [mutate, code]] of Object.entries(cases)) {
    const [pre, post] = after24();
    mutate(pre, post);
    assert.throws(() => assertRelease24(pre, post, p1Ctx), new RegExp(code), label);
  }
  assert.throws(() => manifestDiff(null, []), /RELEASE_MANIFEST_MISSING/);
  assert.throws(() => manifestDiff([['a', 'b', 1], ['a', 'b', 2]], []), /RELEASE_MANIFEST_DUPLICATE_IDENTITY/);
});
test('assertRelease25: exactly one added column, nothing changed, historical datasets untouched', () => {
  const pre = captureOf({ schemaManifest: [...baseManifest(), ...m24Added()], datasetModality: [{ id: 'a', m: null, r: 0, t: null, s: null }, { id: 'b', m: 'IMAGE', r: 0, t: '2026-10-05T00:00:00', s: 'u1' }] });
  const post = captureOf({ schemaManifest: [...baseManifest(), ...m24Added(), ...m25Added()], datasetModality: pre.datasetModality });
  const ctx = { newColumn: ['PreparedImport', 'creationRequestHash'] };
  assert.deepEqual(assertRelease25(pre, post, ctx).map(item => item.name), ['schema-delta', 'datasets-unchanged']);
  const cases = {
    'wrong count': post => { post.schemaManifest.push(['index', '["public","y"]', 'i']); },
    'wrong column': post => { post.schemaManifest[post.schemaManifest.length - 1] = ['column', '["public","PreparedImport","other"]', ['text']]; },
    'existing entry changed': post => { post.schemaManifest[3] = [...post.schemaManifest[3].slice(0, 2), ['changed']]; },
    'dataset modified': post => { post.datasetModality = [{ ...post.datasetModality[0], m: 'IMAGE' }, post.datasetModality[1]]; },
    'dataset removed': post => { post.datasetModality = post.datasetModality.slice(0, 1); },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const copy = captureOf({ schemaManifest: [...post.schemaManifest], datasetModality: post.datasetModality.map(row => ({ ...row })) });
    mutate(copy);
    assert.throws(() => assertRelease25(pre, copy, ctx), /RELEASE_M25_/, label);
  }
});

test('release plan is a fixed plan resolved by name; catalog specs and topology are pinned', () => {
  assert.equal(validateCommand(RELEASE_ID, CATALOG), RELEASE_ID);
  assert.equal(resolvePlan(RELEASE_ID).kind, 'release'); assert.equal(resolvePlan(RELEASE_ID).through, 2);
  assert.deepEqual(Object.keys(RELEASE_SPECS), ['g2:generate', 'g2:baseline', 'g2:compatibility', 'g2:candidate']);
  const catalog = JSON.parse(readFileSync(join(guard.root, 'scripts/db-safety/commands.json'), 'utf8'));
  for (const [name, spec] of Object.entries(RELEASE_SPECS)) assert.deepEqual(catalog[name], spec, `${name} in the real catalog equals its pinned spec`);
  assert.equal(RELEASE_TOPOLOGY.length, 9);
  assert.ok(!SUPPORTED_COMMANDS.includes(RELEASE_ID), 'not selectable as a plain command');
});
test('release lifecycle: 23 -> seed -> 24 -> fixture -> 25 -> drift/compat/contracts -> cleanup -> independent verification', async () => {
  const w = world();
  try {
    const out = await failuresOf(w, RELEASE_ID);
    assert.equal(out.result, 'PASS', JSON.stringify(out.failures));
    assert.equal(dockerRuns(w).length, 3);
    assert.equal(deployCalls(w).length, 3, 'baseline, migration 24, migration 25');
    assert.deepEqual(testCalls(w), ['g2:generate', 'g2:baseline', FIXTURE_COMMAND, 'g2:compatibility', COMPAT_COMMAND, 'g2:candidate']);
    const order = w.calls.filter(c => c.args[1] === 'deploy' || c.args[1] === 'test').map(c => c.args[1] === 'deploy' ? 'deploy' : c.args[2]);
    assert.deepEqual(order, ['deploy', 'g2:generate', 'g2:baseline', 'deploy', FIXTURE_COMMAND, 'deploy', 'g2:compatibility', COMPAT_COMMAND, 'g2:candidate']);
    assert.equal(w.db.migrations.length, 25);
    const results = JSON.parse(readFileSync(join(out.runDir, 'results.json'), 'utf8'));
    assert.equal(results.kind, 'release-chain-proof'); assert.equal(results.scope, 'release-chain-25'); assert.equal(results.releaseChainProven, true);
    assert.equal(results.countsAsG3Evidence, false); assert.equal(results.countsAsG5Evidence, false); assert.equal(results.notAuthorizationToApplyMigration, true);
    assert.deepEqual(results.receiptTopology.map(({ step, operation, command }) => [step, operation, command]), RELEASE_TOPOLOGY.map(row => [...row]));
    assert.equal(new Set(results.receiptTopology.map(entry => entry.receiptId)).size, 9);
    const summary = JSON.parse(readFileSync(join(out.runDir, 'release-summary.json'), 'utf8'));
    assert.deepEqual(summary.schemaEntries, [1829, 1841, 1842]); assert.equal(summary.historicalMigrations, 23); assert.equal(summary.activeChainMigrations, 25); assert.equal(summary.migrationChecksums.length, 25);
    assert.deepEqual(summary.migrationChecksums.slice(23).map(row => [row.name, row.checksum]), PROPOSAL_CHAIN.map((entry, index) => [entry.name, FAKE_CHAIN[index].sha256]));
    for (const name of ['release-m24-assertions.json', 'release-m25-assertions.json', 'release-seeded-datasets.json', 'release-m24-datasets.json', 'release-baseline-schema-count.json']) assert.ok(existsSync(join(out.runDir, name)), name);
    expectCleanedAndVerified(w, out);
    assert.ok(existsSync(join(w.root, 'prisma/migrations', P1.name)) && existsSync(join(w.root, 'prisma/migrations', P2.name)), 'canonical chain untouched');
  } finally { cleanup(w); }
});
test('release plan: every preflight tamper aborts before anything is provisioned', async () => {
  const setups = {
    'tampered g2:baseline spec': w => { const catalog = JSON.parse(readFileSync(join(w.root, 'scripts/db-safety/commands.json'), 'utf8')); catalog['g2:baseline'].args.push('x'); writeFileSync(join(w.root, 'scripts/db-safety/commands.json'), JSON.stringify(catalog)); },
    'tampered g2:generate spec': w => { const catalog = JSON.parse(readFileSync(join(w.root, 'scripts/db-safety/commands.json'), 'utf8')); catalog['g2:generate'].cwd = 'apps/web'; writeFileSync(join(w.root, 'scripts/db-safety/commands.json'), JSON.stringify(catalog)); },
    'tampered fixture spec': w => { const catalog = JSON.parse(readFileSync(join(w.root, 'scripts/db-safety/commands.json'), 'utf8')); catalog[FIXTURE_COMMAND].args.push('x'); writeFileSync(join(w.root, 'scripts/db-safety/commands.json'), JSON.stringify(catalog)); },
    'missing step file': w => rmSync(join(w.root, 'apps/web/tests/dataset-modality/g2-candidate.test.ts')),
    'frozen schema drift': w => writeFileSync(join(w.root, 'prisma/schema.prisma'), 'drift\n'),
    'frozen client drift': w => writeFileSync(join(w.root, CLIENT_DIR, 'models/Dataset.ts'), 'export type X = { modalityContentRevision: bigint, extra: 1 }\n'),
    'migration 25 bytes': w => writeFileSync(join(w.root, P2.path, 'migration.sql'), PROPOSAL2_SQL + '-- x\n'),
    'manifest definition drift': w => { w.deps.releaseManifestSql = () => { throw Error('RECOVERY_REVIEW_DRIFT'); }; },
  };
  for (const [label, setup] of Object.entries(setups)) {
    const w = world();
    try { setup(w); await assert.rejects(() => failuresOf(w, RELEASE_ID), /./, label); assert.equal(w.calls.length, 0, label + ': no process'); assert.equal(w.stages.length, 0, label); assert.equal(readdirSync(w.outBase).length, 0, label); } finally { cleanup(w); }
  }
});
test('release plan: failures at each stage fail the run, still clean up and are independently verified', async () => {
  const scenarios = {
    'baseline seed fails': [{ baselineSeedExit: 1 }, 'RELEASE_BASELINE_SEED_FAILED'],
    'schema compatibility step fails': [{ schemaCompatExit: 1 }, 'RELEASE_SCHEMA_COMPAT_FAILED'],
    'contract tests fail': [{ candidateExit: 1 }, 'RELEASE_CANDIDATE_CONTRACTS_FAILED'],
    'compat test fails': [{ compatExit: 1 }, 'COMPAT_TEST_FAILED'],
    'fixture fails': [{ fixtureExit: 1 }, 'FIXTURE_FAILED'],
    'migration 24 adds an unexpected entry': [{ m24Mutation: db => db.manifest.push(['index', '["public","x"]', 'i']) }, 'RELEASE_M24_SCHEMA_COUNT_UNEXPECTED'],
    'migration 24 resolves a historical dataset': [{ m24Mutation: db => { db.datasets[0].m = 'IMAGE'; } }, 'RELEASE_M24_DATASET_NOT_UNRESOLVED'],
    'migration 25 modifies a historical dataset': [{ m25Mutation: db => { db.datasets[0].m = 'IMAGE'; } }, 'RELEASE_M25_DATASETS_CHANGED'],
    'migration 25 adds a second entry': [{ m25Mutation: db => db.manifest.push(['index', '["public","y"]', 'i']) }, 'RELEASE_M25_SCHEMA_COUNT_UNEXPECTED'],
    'history checksum differs': [{ historyMutate: rows => (rows.length === 25 ? rows.map((row, index) => (index === 24 ? { ...row, c: 'a'.repeat(64) } : row)) : rows) }, 'PROPOSAL_HISTORY_CHECKSUM_MISMATCH'],
  };
  for (const [label, [overrides, code]] of Object.entries(scenarios)) {
    const w = world();
    try {
      Object.assign(w, overrides);
      const out = await failuresOf(w, RELEASE_ID);
      assert.equal(out.result, 'FAIL', label); assert.ok(out.failures.includes(code), `${label}: ${JSON.stringify(out.failures)}`);
      expectCleanedAndVerified(w, out);
    } finally { cleanup(w); }
  }
});
