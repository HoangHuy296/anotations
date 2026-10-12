// Disposable rehearsal of the maintenance launcher against REAL PostgreSQL and REAL MinIO (plan `release:phase029-backfill-maintenance` in disposable-test.mjs):
// the guarded migration steps (M24, M25 and, on the 26-migration chain, M26) through the launcher, then T029 observe, the offline approval, and T031 apply with storage metadata changing between runs.
// Orchestration only: the launcher, the child runner and the storage adapter under test are the committed maintenance path, unmodified.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CREDENTIALS_SCHEMA, REQUEST_SCHEMA, computeImplementation, historyDigest, manifestDigest, sha256, storageConfigFingerprint } from './backfill-binding.mjs';

export const EXPECTED_CANDIDATES = ['mn-a-image', 'mn-b-video', 'mn-c-audio', 'mn-d-text', 'mn-e-etag-match', 'mn-m-mutate-size', 'mn-n-mutate-etag', 'mn-o-mutate-missing', 'mn-p-unapproved', 'mn-q-last', 'mn-y-primary'];
export const UNAPPROVED = 'mn-p-unapproved';
export const APPROVED = EXPECTED_CANDIDATES.filter(id => id !== UNAPPROVED);
export const EXPECTED_REJECTED = { 'mn-r-missing': 'OBJECT_MISSING', 'mn-s-size-mismatch': 'SIZE_MISMATCH', 'mn-t-etag-mismatch': 'ETAG_MISMATCH', 'mn-u-bucket-foreign': 'BUCKET_NOT_APPROVED', 'mn-v-size-unrecorded': 'SIZE_UNRECORDED', 'mn-w-empty': 'EMPTY_DATASET', 'mn-x-mixed': 'MIXED_MODALITY' };
/** apply runs against the same approved manifest; storage is repaired one target at a time, so each run stops at the next one. Statuses are in approved-id order. */
export const APPLY_EXPECTATIONS = [
  { name: 'apply-1', exit: 3, statuses: ['COMMITTED', 'COMMITTED', 'COMMITTED', 'COMMITTED', 'COMMITTED', 'STOPPED:SIZE_MISMATCH', 'NOT_ATTEMPTED', 'NOT_ATTEMPTED', 'NOT_ATTEMPTED', 'NOT_ATTEMPTED'], phase: 'after-apply-1', repair: 'restore-m' },
  { name: 'apply-2', exit: 3, statuses: ['COMMITTED_REPLAY', 'COMMITTED_REPLAY', 'COMMITTED_REPLAY', 'COMMITTED_REPLAY', 'COMMITTED_REPLAY', 'COMMITTED', 'STOPPED:ETAG_MISMATCH', 'NOT_ATTEMPTED', 'NOT_ATTEMPTED', 'NOT_ATTEMPTED'], phase: 'after-apply-2', repair: 'restore-n' },
  { name: 'apply-3', exit: 3, statuses: ['COMMITTED_REPLAY', 'COMMITTED_REPLAY', 'COMMITTED_REPLAY', 'COMMITTED_REPLAY', 'COMMITTED_REPLAY', 'COMMITTED_REPLAY', 'COMMITTED', 'STOPPED:OBJECT_MISSING', 'NOT_ATTEMPTED', 'NOT_ATTEMPTED'], phase: 'after-apply-3', repair: 'restore-o' },
  { name: 'apply-4', exit: 0, statuses: ['COMMITTED_REPLAY', 'COMMITTED_REPLAY', 'COMMITTED_REPLAY', 'COMMITTED_REPLAY', 'COMMITTED_REPLAY', 'COMMITTED_REPLAY', 'COMMITTED_REPLAY', 'COMMITTED', 'COMMITTED', 'COMMITTED'], phase: 'final', repair: null },
];

const outcomeLabel = outcome => (outcome.status === 'STOPPED' ? `STOPPED:${outcome.code}` : outcome.status);

/**
 * ctx: { root, stage, runDir, save, sh(cmd,args,{env,cwd}), cleanEnv(), pins, token, password, minioUser, bucket, pgPort, minioPort, historyRows,
 *        chainLength (25 | 26: how many migrations are applied when observe/apply run),
 *        captures (live object: seeded, m24, m25 and, for the 26 chain, m26 as the runner captures them), childStep(name, kind, payload) }
 */
export function createMaintenance(ctx) {
  const evidenceRoot = join(ctx.root, 'specs/029-modality-specific-datasets/verification/maintenance-runs');
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  const pg = ctx.pins.find(pin => pin.role === 'postgres'), minio = ctx.pins.find(pin => pin.role === 'minio');
  const runToken = `maint-${ctx.token}`;
  const secrets = [ctx.password, ctx.minioUser];
  const check = (value, code, detail) => { if (!value) { if (detail !== undefined) ctx.save('maintenance-failure-detail.json', { code, detail: String(detail).slice(0, 2000) }); throw Error(code); } };
  let counter = 0;

  // ---- the private runtime credential path: files outside the repository (inside the run's private stage), owner-only, hash-pinned, never in a request or evidence
  const credDir = join(ctx.stage, 'maintenance-credentials'); mkdirSync(credDir, { mode: 0o700 });
  const writeCredentials = (name, withStorage) => {
    const record = { schema: CREDENTIALS_SCHEMA, postgresPassword: ctx.password, ...(withStorage ? { storageAccessKey: ctx.minioUser, storageSecretKey: ctx.password } : {}) };
    const path = join(credDir, name), text = JSON.stringify(record);
    writeFileSync(path, text, { mode: 0o600 });
    return { path, sha256: sha256(text), record };
  };
  const storageCreds = writeCredentials('storage.credentials.json', true), dbOnlyCreds = writeCredentials('database.credentials.json', false);
  const chainLength = ctx.chainLength ?? 25;
  check(chainLength === 25 || chainLength === 26, 'MAINTENANCE_CHAIN_LENGTH_INVALID');
  const finalCapture = () => (chainLength === 26 ? ctx.captures.m26 : ctx.captures.m25);
  const historyLength = { observe: chainLength, apply: chainLength, 'migrate-m24': 23, 'migrate-m25': 24, 'migrate-m26': 25 };
  const preState = operation => ({ 'migrate-m24': ctx.captures.seeded, 'migrate-m25': ctx.captures.m24, 'migrate-m26': ctx.captures.m25 }[operation] ?? finalCapture());

  const baseRequest = (operation, overrides = {}, preCapture = null) => {
    counter += 1;
    const name = `${operation}-${counter}-${ctx.token}`;
    const pre = preCapture ?? preState(operation);
    const migration = operation.startsWith('migrate');
    const creds = migration ? dbOnlyCreds : storageCreds;
    const request = {
      schema: REQUEST_SCHEMA, operation, targetKind: 'disposable', requestId: randomUUID(), issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 20 * 60000).toISOString(), runToken,
      postgres: { host: '127.0.0.1', port: ctx.pgPort, database: 'fieldframe', user: 'postgres', expectedSystemIdentifier: pg.systemIdentifier, expectedHistory: ctx.historyRows.slice(0, historyLength[operation]).map(row => ({ name: row.name, checksum: row.sha256 })), expectedSchemaManifestSha256: manifestDigest(pre.schemaManifest), expectedSchemaEntries: pre.schemaManifest.length },
      ...(migration ? {} : { storage: { endpoint: `http://127.0.0.1:${ctx.minioPort}`, bucket: ctx.bucket, expectedEndpoint: `http://127.0.0.1:${ctx.minioPort}`, expectedBucket: ctx.bucket } }),
      credentials: { path: creds.path, sha256: creds.sha256 },
      implementation: computeImplementation(ctx.root), manifests: {}, evidenceDir: join(evidenceRoot, name), disposablePins: { postgres: pg, ...(migration ? {} : { minio }) },
    };
    return { request: { ...request, ...overrides }, name };
  };
  const writeRequest = (name, request) => { const path = join(ctx.stage, `${name}-request.json`); writeFileSync(path, JSON.stringify(request), { mode: 0o600 }); return path; };
  const launch = (operation, request, name, env = ctx.cleanEnv()) => {
    const path = writeRequest(name, request);
    const result = ctx.sh(process.execPath, [join(ctx.root, 'scripts/db-safety/backfill-launcher.mjs'), operation, path], { env, cwd: ctx.root });
    check(!secrets.some(secret => secret && (result.stdout + result.stderr).includes(secret)), 'MAINTENANCE_SECRET_IN_LAUNCHER_OUTPUT');
    ctx.save(`launcher-${name}.log`, `${result.stdout}${result.stderr}`.slice(0, 4000));
    return result;
  };
  const evidenceFiles = dir => readdirSync(dir).sort();
  const readJson = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const assertEvidenceSealed = dir => {
    for (const file of evidenceFiles(dir)) {
      check((statSync(join(dir, file)).mode & 0o777) === 0o400, 'MAINTENANCE_EVIDENCE_NOT_READ_ONLY', file);
      check(!secrets.some(secret => readFileSync(join(dir, file), 'utf8').includes(secret)), 'MAINTENANCE_SECRET_IN_EVIDENCE', file);
    }
  };
  const refused = (name, operation, request, expectedCode, env) => {
    const result = launch(operation, request, name, env);
    check(result.status === 1 && result.stderr.includes(`SAFETY_ABORT ${expectedCode}`), 'MAINTENANCE_REFUSAL_UNEXPECTED', `${name}: exit ${result.status} ${result.stderr}`);
    check(!existsSync(request.evidenceDir) || !readdirSync(request.evidenceDir).includes('binding.json'), 'MAINTENANCE_REFUSAL_LEFT_EVIDENCE', name);
    return result.stderr.trim();
  };

  /** One guarded migration step through the launcher (real PostgreSQL). The caller's independent capture runs afterwards. */
  const migrate = operation => {
    // A real refusal first, from the live database: a step must not run on a database that is not in its exact pre-state.
    if (operation === 'migrate-m24') {
      const wrong = baseRequest('migrate-m25', {}, { schemaManifest: new Array(1841).fill(null) }); // expects 24 migrations; the database has 23 (the M24 capture does not exist yet; only the pin shape is validated before the history check)
      refused(`refuse-wrong-prestate-${wrong.name}`, 'migrate-m25', wrong.request, 'HISTORY_COUNT_MISMATCH');
    }
    const { request, name } = baseRequest(operation);
    const result = launch(operation, request, name);
    check(result.status === 0, 'MAINTENANCE_MIGRATE_FAILED', `${operation}: ${result.stderr}`);
    const dir = request.evidenceDir;
    check(JSON.stringify(evidenceFiles(dir)) === JSON.stringify(['binding.json', 'migration-output.log', 'receipt.json', 'verification.json']), 'MAINTENANCE_MIGRATE_EVIDENCE_SET', operation);
    assertEvidenceSealed(dir);
    const verification = readJson(dir, 'verification.json'), receipt = readJson(dir, 'receipt.json'), binding = readJson(dir, 'binding.json');
    const expectedAdded = { 'migrate-m24': 12, 'migrate-m25': 1, 'migrate-m26': 100 }[operation];
    check(receipt.status === 'COMPLETED' && verification.historyMatchesExpected === true && verification.delta.added === expectedAdded && verification.delta.removed === 0 && verification.delta.changed === 0, 'MAINTENANCE_MIGRATE_RECEIPT', JSON.stringify(verification));
    check(binding.postgres.systemIdentifier === pg.systemIdentifier && binding.storage === null && binding.postgres.migrationCount === historyLength[operation], 'MAINTENANCE_MIGRATE_BINDING');
    return { evidenceDir: dir, operation, postState: receipt.postState, delta: verification.delta, tables: verification.tables };
  };

  const run = () => {
    const summary = { runToken, observe: null, refusals: {}, applies: [] };
    // ---- 1. observe (T029) with real storage; nothing may change in PostgreSQL or in the bucket
    ctx.childStep('maintenance-snapshot', 'check', { phase: 'snapshot' });
    const observe = baseRequest('observe');
    const observed = launch('observe', observe.request, observe.name);
    check(observed.status === 0, 'MAINTENANCE_OBSERVE_FAILED', observed.stderr);
    const observeDir = observe.request.evidenceDir;
    check(JSON.stringify(evidenceFiles(observeDir)) === JSON.stringify(['binding.json', 'observed-manifest.json', 'receipt.json']), 'MAINTENANCE_OBSERVE_EVIDENCE_SET');
    assertEvidenceSealed(observeDir);
    const manifest = readJson(observeDir, 'observed-manifest.json');
    check(JSON.stringify(manifest.candidates.map(candidate => candidate.datasetId)) === JSON.stringify(EXPECTED_CANDIDATES), 'MAINTENANCE_CANDIDATES_UNEXPECTED');
    const rejected = Object.fromEntries(manifest.rejected.filter(entry => entry.datasetId.startsWith('mn-')).map(entry => [entry.datasetId, entry.code]));
    check(JSON.stringify(rejected) === JSON.stringify(EXPECTED_REJECTED), 'MAINTENANCE_REJECTIONS_UNEXPECTED');
    const withEtag = manifest.candidates.filter(candidate => candidate.datasetId === 'mn-e-etag-match' || candidate.datasetId === 'mn-n-mutate-etag');
    check(withEtag.every(candidate => candidate.objects.every(object => typeof object.etag === 'string')), 'MAINTENANCE_ETAG_NOT_OBSERVED');
    check(manifest.candidates.find(candidate => candidate.datasetId === 'mn-a-image').objects.length === 2, 'MAINTENANCE_OBJECT_COUNT_UNEXPECTED');
    const receipt = readJson(observeDir, 'receipt.json'), binding = readJson(observeDir, 'binding.json');
    check(receipt.status === 'COMPLETED' && receipt.counts.candidates === EXPECTED_CANDIDATES.length && receipt.implementationStable === true, 'MAINTENANCE_OBSERVE_RECEIPT');
    check(binding.postgres.systemIdentifier === pg.systemIdentifier && binding.postgres.migrationCount === chainLength && binding.storage.bucket === ctx.bucket && binding.storage.bucketExists === true && binding.resolverSubject === `system:phase029-backfill:${runToken}`, 'MAINTENANCE_BINDING_UNEXPECTED');
    // cross-implementation checks: the launcher's own derivations equal what the independent runner captured
    check(binding.postgres.schemaManifestSha256 === manifestDigest(finalCapture().schemaManifest), 'MAINTENANCE_SCHEMA_DIGEST_MISMATCH');
    check(binding.postgres.historySha256 === historyDigest(finalCapture().migrations.map(row => ({ name: row.migration_name, checksum: row.checksum, finished: Boolean(row.finished_at), rolledBack: Boolean(row.rolled_back_at) }))), 'MAINTENANCE_HISTORY_DIGEST_MISMATCH');
    check(binding.storage.configFingerprint === storageConfigFingerprint(observe.request, storageCreds.record), 'MAINTENANCE_STORAGE_FINGERPRINT_MISMATCH');
    check(binding.containers.postgres.systemIdentifier === pg.systemIdentifier, 'MAINTENANCE_CONTAINER_IDENTITY_MISSING');
    summary.observe = { evidenceDir: observeDir, candidates: manifest.candidates.length, rejected: manifest.rejected.length, manifestSha256: manifest.manifestSha256 };
    ctx.childStep('maintenance-check', 'check', { phase: 'after-observe', token: null });

    // ---- 2. release-owner approval: a separate artifact derived offline from the observed manifest (the unapproved candidate is deliberately left out)
    const observedPath = join(observeDir, 'observed-manifest.json'), observedSha = sha256(readFileSync(observedPath));
    const idsFile = join(ctx.stage, 'approved-ids.txt'); writeFileSync(idsFile, `${APPROVED.join('\n')}\n`, { mode: 0o600 });
    const approvedPath = join(ctx.stage, 'approved-manifest.json');
    const approveEnv = ctx.cleanEnv();
    const approve = ctx.sh(process.execPath, ['--require', './tests/auth-ownership/register-server-only.cjs', '--import', 'tsx', 'scripts/backfill-approve.ts', observedPath, idsFile, approvedPath, 'release owner (disposable rehearsal)', 'rehearsal approval of every candidate except the deliberately unapproved one'], { env: approveEnv, cwd: join(ctx.root, 'apps/web') });
    check(approve.status === 0, 'MAINTENANCE_APPROVE_FAILED', approve.stderr);
    const approvedSha = sha256(readFileSync(approvedPath));
    const approved = JSON.parse(readFileSync(approvedPath, 'utf8'));
    check(JSON.stringify(approved.approvedIds) === JSON.stringify(APPROVED) && approved.observedManifestSha256 === manifest.manifestSha256, 'MAINTENANCE_APPROVED_MANIFEST_UNEXPECTED');
    const forgedIds = join(ctx.stage, 'forged-ids.txt'); writeFileSync(forgedIds, 'mn-r-missing\n', { mode: 0o600 });
    const forged = ctx.sh(process.execPath, ['--require', './tests/auth-ownership/register-server-only.cjs', '--import', 'tsx', 'scripts/backfill-approve.ts', observedPath, forgedIds, join(ctx.stage, 'forged-approved.json'), 'x', 'y'], { env: approveEnv, cwd: join(ctx.root, 'apps/web') });
    check(forged.status !== 0 && forged.stderr.includes('APPROVED_ID_NOT_CANDIDATE') && !existsSync(join(ctx.stage, 'forged-approved.json')), 'MAINTENANCE_FORGED_APPROVAL_ACCEPTED');
    summary.approved = { ids: approved.approvedIds.length, sha256: approvedSha, unapproved: UNAPPROVED };
    const applyRequest = (overrides = {}) => baseRequest('apply', { manifests: { observedPath, observedSha256: observedSha, approvedPath, approvedSha256: approvedSha }, ...overrides });

    // ---- 3. refusals: every one must fail closed before the child, with no evidence, and change nothing
    const pickUnusedPort = () => { for (let port = 55460; port <= 55479; port += 1) if (![ctx.pgPort, ctx.minioPort, ...ctx.pins.map(pin => pin.port)].includes(port)) return port; throw Error('MAINTENANCE_NO_FREE_PORT'); };
    const credentialsVariant = name => { const path = join(credDir, name); const text = JSON.stringify(storageCreds.record); writeFileSync(path, text, { mode: 0o600 }); return { path, sha256: sha256(text) }; };
    const refusals = {
      ambientDatabaseUrl: () => { const r = applyRequest(); return refused('refuse-ambient-db', 'apply', r.request, 'AMBIGUOUS_TARGET_ENVIRONMENT', { ...ctx.cleanEnv(), DATABASE_URL: `postgresql://x:y@127.0.0.1:${ctx.pgPort}/fieldframe` }); },
      ambientStorage: () => { const r = applyRequest(); return refused('refuse-ambient-storage', 'apply', r.request, 'AMBIGUOUS_TARGET_ENVIRONMENT', { ...ctx.cleanEnv(), MINIO_ENDPOINT: r.request.storage.endpoint }); },
      credentialsHashMismatch: () => { const r = applyRequest(); r.request.credentials = { path: storageCreds.path, sha256: sha256('not the credentials') }; return refused('refuse-credentials-hash', 'apply', r.request, 'CREDENTIALS_HASH_MISMATCH'); },
      credentialsNotPrivate: () => { const r = applyRequest(); const variant = credentialsVariant('open.credentials.json'); chmodSync(variant.path, 0o644); r.request.credentials = variant; return refused('refuse-credentials-mode', 'apply', r.request, 'CREDENTIALS_FILE_NOT_PRIVATE'); },
      credentialsInsideRepository: () => {
        const r = applyRequest(); const inside = join(ctx.root, '.data/zz-maintenance-credentials-probe.json'); mkdirSync(join(ctx.root, '.data'), { recursive: true });
        const text = JSON.stringify({ schema: CREDENTIALS_SCHEMA, postgresPassword: 'probe-only-not-a-credential' }); writeFileSync(inside, text, { mode: 0o600 });
        try { r.request.credentials = { path: inside, sha256: sha256(text) }; return refused('refuse-credentials-repo', 'apply', r.request, 'CREDENTIALS_INSIDE_REPOSITORY'); } finally { rmSync(inside, { force: true }); }
      },
      wrongSystemIdentifier: () => { const r = applyRequest(); r.request.postgres.expectedSystemIdentifier = '1234567890123456789'; r.request.disposablePins = { ...r.request.disposablePins, postgres: { ...pg, systemIdentifier: '1234567890123456789' } }; return refused('refuse-system', 'apply', r.request, 'SYSTEM_IDENTITY_MISMATCH'); },
      implementationHash: () => { const r = applyRequest(); const file = 'apps/web/src/lib/datasets/modality-backfill.ts'; r.request.implementation.files[file] = sha256('not the reviewed bytes'); return refused('refuse-implementation', 'apply', r.request, 'IMPLEMENTATION_HASH_MISMATCH'); },
      historyChecksum: () => { const r = applyRequest(); r.request.postgres.expectedHistory[3] = { ...r.request.postgres.expectedHistory[3], checksum: sha256('x') }; return refused('refuse-history', 'apply', r.request, 'HISTORY_MISMATCH'); },
      schemaDrift: () => { const r = applyRequest(); r.request.postgres.expectedSchemaManifestSha256 = sha256('drift'); return refused('refuse-schema', 'apply', r.request, 'SCHEMA_MANIFEST_MISMATCH'); },
      storageUnavailable: () => { const port = pickUnusedPort(); const r = applyRequest(); r.request.storage.endpoint = r.request.storage.expectedEndpoint = `http://127.0.0.1:${port}`; return refused('refuse-storage-down', 'apply', r.request, 'STORAGE_UNAVAILABLE'); },
      storageEndpointMismatch: () => { const r = applyRequest(); r.request.storage.expectedEndpoint = `http://127.0.0.1:${pickUnusedPort()}`; return refused('refuse-storage-endpoint', 'apply', r.request, 'STORAGE_TARGET_MISMATCH'); },
      bucketMismatch: () => { const r = applyRequest(); r.request.storage.bucket = r.request.storage.expectedBucket = `${ctx.bucket}-other`; return refused('refuse-bucket', 'apply', r.request, 'MANIFEST_BUCKET_MISMATCH'); },
      approvedManifestBytes: () => { const copy = join(ctx.stage, 'approved-tampered.json'); writeFileSync(copy, JSON.stringify({ ...approved, approver: 'tampered approver' }), { mode: 0o600 }); const r = applyRequest({ manifests: { observedPath, observedSha256: observedSha, approvedPath: copy, approvedSha256: approvedSha } }); return refused('refuse-approved-bytes', 'apply', r.request, 'MANIFEST_FILE_HASH_MISMATCH'); },
      evidenceDirNotEmpty: () => { const r = applyRequest(); mkdirSync(r.request.evidenceDir, { mode: 0o700 }); writeFileSync(join(r.request.evidenceDir, 'old.json'), '{}', { mode: 0o600 }); return refused('refuse-evidence-dir', 'apply', r.request, 'EVIDENCE_DIR_NOT_EMPTY'); },
      sharedDevKind: () => { const r = applyRequest(); delete r.request.disposablePins; r.request.targetKind = 'shared-dev'; r.request.sharedDevPins = { postgres: { container: 'annotationplatformdev-postgres-1', id: 'a'.repeat(64) }, minio: { container: 'annotationplatformdev-minio-1', id: 'b'.repeat(64) } }; r.request.authorization = { path: approvedPath, sha256: approvedSha }; return refused('refuse-shared-dev', 'apply', r.request, 'SHARED_DEV_EXECUTION_NOT_ENABLED'); },
    };
    for (const [name, action] of Object.entries(refusals)) summary.refusals[name] = action();
    ctx.childStep('maintenance-check', 'check', { phase: 'after-negative', token: null });

    // ---- 4. approved execution (T031) against real storage whose metadata changes between approval and execution
    ctx.childStep('maintenance-mutate', 'objects', { action: 'mutate' });
    for (const expectation of APPLY_EXPECTATIONS) {
      const { request, name } = applyRequest();
      const result = launch('apply', request, `${expectation.name}-${name}`);
      check(result.status === expectation.exit, 'MAINTENANCE_APPLY_EXIT_UNEXPECTED', `${expectation.name}: exit ${result.status} ${result.stderr}`);
      const dir = request.evidenceDir;
      check(JSON.stringify(evidenceFiles(dir)) === JSON.stringify(['binding.json', 'receipt.json', 'result.json']), 'MAINTENANCE_APPLY_EVIDENCE_SET', expectation.name);
      assertEvidenceSealed(dir);
      const { lineage, run: runResult } = readJson(dir, 'result.json'), receiptJson = readJson(dir, 'receipt.json');
      check(JSON.stringify(runResult.outcomes.map(outcomeLabel)) === JSON.stringify(expectation.statuses), 'MAINTENANCE_APPLY_OUTCOMES_UNEXPECTED', `${expectation.name}: ${JSON.stringify(runResult.outcomes.map(outcomeLabel))}`);
      check(JSON.stringify(runResult.outcomes.map(outcome => outcome.datasetId)) === JSON.stringify(APPROVED), 'MAINTENANCE_APPLY_ORDER', expectation.name);
      check(!runResult.outcomes.some(outcome => outcome.datasetId === UNAPPROVED), 'MAINTENANCE_UNAPPROVED_EXECUTED');
      check(lineage.approvedManifestSha256 === approved.sha256 && lineage.observedManifestSha256 === manifest.manifestSha256 && lineage.approvedIdsDigest === approved.approvedIdsDigest, 'MAINTENANCE_LINEAGE_MISMATCH');
      check(receiptJson.approvedLineage.executedManifestSha256 === lineage.executedManifestSha256 && receiptJson.status === (expectation.exit === 0 ? 'COMPLETED' : 'STOPPED') && runResult.status === receiptJson.status, 'MAINTENANCE_RECEIPT_MISMATCH');
      check(runResult.counts.candidates === APPROVED.length && runResult.counts.committed + runResult.counts.replayed + runResult.counts.stopped + runResult.counts.notAttempted === APPROVED.length, 'MAINTENANCE_ACCOUNTING');
      summary.applies.push({ name: expectation.name, evidenceDir: dir, status: runResult.status, counts: runResult.counts, outcomes: runResult.outcomes.map(outcomeLabel) });
      ctx.childStep('maintenance-check', 'check', { phase: expectation.phase, token: runToken });
      if (expectation.repair) ctx.childStep(`maintenance-${expectation.repair}`, 'objects', { action: expectation.repair });
    }
    summary.evidenceDirs = readdirSync(evidenceRoot).filter(entry => entry.endsWith(`-${ctx.token}`)).map(entry => join(evidenceRoot, entry)).sort();
    return summary;
  };
  return { migrate, run };
}
