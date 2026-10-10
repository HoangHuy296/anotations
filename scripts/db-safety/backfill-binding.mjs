// Pure rules and small filesystem helpers for the Phase029 maintenance launcher (backfill-launcher.mjs): T029 observe, T031 apply and the two guarded
// migration steps (M24, M25). Nothing here contacts a database or a storage service. Every rule fails closed with an upper-case code.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { readTree, treeHash } from './prisma-client-stage.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const must = (value, code) => { if (!value) throw Error(code); };
const canonicalize = value => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
};
export const canonicalJson = value => JSON.stringify(canonicalize(value));

export const REQUEST_SCHEMA = 'phase029-backfill-request/v2';
export const RECEIPT_SCHEMA = 'phase029-backfill-execution-receipt/v2';
export const BINDING_SCHEMA = 'phase029-backfill-binding/v2';
export const AUTHORIZATION_SCHEMA = 'phase029-backfill-authorization/v2';
export const CREDENTIALS_SCHEMA = 'phase029-maintenance-credentials/v1';
export const OPERATIONS = ['observe', 'apply', 'migrate-m24', 'migrate-m25', 'migrate-m26'];
// 'copy' is a non-production COPY of the shared-dev data (never the shared-dev system itself): pinned containers whose volumes are all `devcopy_*`, see verifyCopyTarget.
export const TARGET_KINDS = ['disposable', 'shared-dev', 'copy'];
/** The application database's system identifier. A disposable run must never match it; a shared-dev run must. */
export const APPLICATION_SYSTEM = '7662655305624969250';
export const MAX_REQUEST_LIFETIME_MS = 30 * 60 * 1000;
export const MAX_AUTHORIZATION_LIFETIME_MS = 4 * 3600 * 1000;
export const MAX_CREDENTIAL_AGE_MS = 4 * 3600 * 1000;

/** The canonical 25-migration chain tail: any other bytes for migrations 24 and 25 are refused regardless of what a request says. */
export const FROZEN_MIGRATIONS = Object.freeze({
  count: 25,
  m24: Object.freeze({ name: '20260930030000_dataset_modality_g2', checksum: '13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7' }),
  m25: Object.freeze({ name: '20261006000000_prepared_import_creation_request_hash', checksum: 'a8ffbc84bde7f18aac93bbb2e87423e6cfcbf6efd95c01e6650824fdcc3ed859' }),
  schemaEntries: 1842,
});
/**
 * M26 (media verification, additive): the reviewed bytes and the exact delta it must add to a 25-migration database. Measured on a scratch PostgreSQL by applying the
 * reviewed chain (25 -> 26): 100 entries added (58 columns, 11 enums, 10 relations, 9 indexes, 6 constraints, 6 types), none removed or changed, and every added column
 * belongs to the NEW table MediaVerification, so no existing table's rows or columns move.
 */
export const FROZEN_M26 = Object.freeze({
  name: '20261007000000_media_verification_a2', checksum: 'ede5e8c511705521e1e6a18563ebaa602e9c24430946acddbed91340d923df5a',
  entriesBefore: 1842, entriesAfter: 1942, added: 100, addedKeysSha256: '8977f5b98d14d1d75958a5dec37207d83de9e6cb9abfc92b1a34918b453640d6', newTables: Object.freeze(['MediaVerification']),
});
/** What each operation expects to find BEFORE it runs: history length, schema-manifest entries, and (migrations) the step it applies. */
export const OP_PROFILE = Object.freeze({
  observe: Object.freeze({ history: 25, entries: 1842, storage: true, manifests: false }),
  apply: Object.freeze({ history: 25, entries: 1842, storage: true, manifests: true }),
  'migrate-m24': Object.freeze({ history: 23, entries: 1829, storage: false, manifests: false, step: FROZEN_MIGRATIONS.m24, after: Object.freeze({ history: 24, entries: 1841 }) }),
  'migrate-m25': Object.freeze({ history: 24, entries: 1841, storage: false, manifests: false, step: FROZEN_MIGRATIONS.m25, after: Object.freeze({ history: 25, entries: 1842 }) }),
  'migrate-m26': Object.freeze({ history: 25, entries: 1842, storage: false, manifests: false, step: FROZEN_M26, after: Object.freeze({ history: 26, entries: 1942 }) }),
});
/** observe / apply run on the 25-migration chain (historical proof) or on the 26-migration chain (current); the request's history length selects which. Anything else is refused. */
export function profileFor(operation, historyLength) {
  const base = OP_PROFILE[operation];
  must(base, 'REQUEST_OPERATION_INVALID');
  if (base.step) return base;
  must(historyLength === 25 || historyLength === 26, 'REQUEST_POSTGRES_INVALID');
  return historyLength === 25 ? base : Object.freeze({ ...base, history: 26, entries: FROZEN_M26.entriesAfter });
}
export const isMigration = operation => Object.hasOwn(OP_PROFILE, operation) && OP_PROFILE[operation].step !== undefined;

/** Files whose bytes decide what the launcher, T029 and T031 do. The request must pin every one of them (and the two trees) to the reviewed hashes. */
export const IMPLEMENTATION_FILES = Object.freeze([
  'apps/web/src/lib/datasets/modality-backfill-evidence.ts',
  'apps/web/src/lib/datasets/modality-backfill.ts',
  'apps/web/src/lib/datasets/modality-backfill-storage.ts',
  'apps/web/scripts/backfill-run.ts',
  'scripts/db-safety/backfill-launcher.mjs',
  'scripts/db-safety/backfill-binding.mjs',
  'scripts/db-safety/maintenance-fence.cjs',
  'packages/domain/src/dataset-modality.ts',
  'packages/domain/dist/dataset-modality.js',
  'prisma/schema.prisma',
  'specs/proposals/phase029-modality/recovery.v2.review.sql',
  `prisma/migrations/${FROZEN_MIGRATIONS.m24.name}/migration.sql`,
  `prisma/migrations/${FROZEN_MIGRATIONS.m25.name}/migration.sql`,
  `prisma/migrations/${FROZEN_M26.name}/migration.sql`,
]);

export function computeImplementation(root) {
  const files = Object.fromEntries(IMPLEMENTATION_FILES.map(file => [file, sha256(readFileSync(join(root, file)))]));
  return { files, clientTreeSha256: treeHash(readTree(join(root, 'lib/generated/prisma'))), migrationsTreeSha256: treeHash(readTree(join(root, 'prisma/migrations'))) };
}
/** One digest for the whole implementation set; the authorization binds it. */
export const implementationDigest = implementation => sha256(canonicalJson(implementation));

// ---------------------------------------------------------------- schema manifest (the reviewed read-only CTE; its bytes are pinned)
export const RECOVERY_REVIEW = Object.freeze({ path: 'specs/proposals/phase029-modality/recovery.v2.review.sql', sha256: '3bb6389f380ffaa5c3be88d26d56782065a00b3844f0326ccba1c05ee4b5a1db' });
/** Same extraction as the disposable runner (disposable-test.mjs extractManifestSql): the reviewed manifest as one single-line read-only statement. */
export function manifestSql(root) {
  const bytes = readFileSync(join(root, RECOVERY_REVIEW.path));
  must(sha256(bytes) === RECOVERY_REVIEW.sha256, 'RECOVERY_REVIEW_DRIFT');
  const text = bytes.toString('utf8');
  const start = text.indexOf('WITH objects AS (');
  const end = text.indexOf('IF EXISTS (\n  SELECT 1 FROM jsonb_array_elements(manifest)');
  must(start >= 0 && end > start, 'RECOVERY_REVIEW_MANIFEST_NOT_FOUND');
  const body = text.slice(start, end);
  must(body.includes('expected_after') && body.includes(' INTO manifest FROM objects;'), 'RECOVERY_REVIEW_MANIFEST_NOT_FOUND');
  const statement = body.replaceAll('expected_after', 'false').replace(' INTO manifest FROM objects;', ' FROM objects;').replace(/\s+/g, ' ').trim();
  must(!/--|\/\*/.test(statement), 'RECOVERY_REVIEW_MANIFEST_NOT_FOUND');
  return statement;
}
export const manifestDigest = rows => sha256(JSON.stringify(rows));
export const historyDigest = history => sha256(canonicalJson(history));

// ---------------------------------------------------------------- ambient environment
const AMBIENT = /^(DATABASE_URL|DATABASE_URL_DOCKER|DIRECT_URL|SHADOW_DATABASE_URL|PG[A-Z_]*|REDIS_[A-Z_]*|MINIO_[A-Z_]*|S3_[A-Z_]*|AWS_[A-Z_]*|STORAGE_[A-Z_]*|BACKFILL_[A-Z_]*|DB_SAFETY_[A-Z_]*|G1_[A-Z_]*|POSTGRES_[A-Z_]*|NODE_OPTIONS|NODE_PATH|BULLMQ_[A-Z_]*)$/;
/** Inherited database/storage targets are rejected, never silently used: the only authority is the pinned request. */
export function assertNoAmbientTargets(env) {
  const present = Object.keys(env).filter(key => AMBIENT.test(key) && env[key] !== undefined && env[key] !== '');
  must(present.length === 0, 'AMBIGUOUS_TARGET_ENVIRONMENT');
}

// ---------------------------------------------------------------- files
export function assertPrivateFile(path, code = 'PRIVATE_FILE_REQUIRED') {
  const stat = lstatSync(path);
  must(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid(), code);
}
/** An evidence directory must be new (or empty), a real directory (no symlink component in the leaf), private, and below an allowed root. */
export function prepareEvidenceDir(path, allowedRoots) {
  must(typeof path === 'string' && path.startsWith('/') && !path.includes('\0'), 'EVIDENCE_DIR_INVALID');
  const parent = realpathSync(dirname(path));
  const target = join(parent, path.split('/').pop());
  const roots = allowedRoots.map(root => { try { return realpathSync(root); } catch { return null; } }).filter(Boolean);
  must(roots.some(root => target === root || target.startsWith(root + sep)), 'EVIDENCE_DIR_OUTSIDE_ALLOWED_ROOT');
  if (existsSync(target)) {
    const stat = lstatSync(target);
    must(stat.isDirectory() && !stat.isSymbolicLink() && readdirSync(target).length === 0, 'EVIDENCE_DIR_NOT_EMPTY');
  } else mkdirSync(target, { mode: 0o700 });
  const stat = statSync(target);
  must((stat.mode & 0o077) === 0 && stat.uid === process.getuid(), 'EVIDENCE_DIR_NOT_PRIVATE');
  return { realpath: realpathSync(target), device: stat.dev, inode: stat.ino };
}
/** Immutable evidence: created exclusively (never overwritten) and read-only. Returns the SHA-256 of the written bytes. */
export function writeImmutable(dir, name, text) {
  const path = join(dir, name);
  const fd = openSync(path, 'wx', 0o400);
  try { writeSync(fd, text); } finally { closeSync(fd); }
  return sha256(text);
}
export function removeOwned(dir, names) { for (const name of names) rmSync(join(dir, name), { force: true }); }

// ---------------------------------------------------------------- request
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f-]{36}$/;
const TOKEN = /^[a-z0-9][a-z0-9-]{6,62}[a-z0-9]$/;
const str = (value, code, max = 4096) => must(typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0'), code);
const only = (object, keys, code) => must(object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(key => keys.includes(key)), code);

/** The request holds NO secret: credentials live in a separate private file outside the repository, referenced by path and pinned by hash. */
export function validateRequest(raw, now = Date.now()) {
  only(raw, ['schema', 'operation', 'targetKind', 'requestId', 'issuedAt', 'expiresAt', 'runToken', 'postgres', 'storage', 'credentials', 'implementation', 'manifests', 'evidenceDir', 'disposablePins', 'sharedDevPins', 'copyPins', 'authorization'], 'REQUEST_SHAPE_INVALID');
  must(raw.schema === REQUEST_SCHEMA, 'REQUEST_SCHEMA_UNSUPPORTED');
  must(OPERATIONS.includes(raw.operation), 'REQUEST_OPERATION_INVALID');
  must(TARGET_KINDS.includes(raw.targetKind), 'REQUEST_TARGET_KIND_INVALID');
  must(UUID.test(raw.requestId ?? ''), 'REQUEST_ID_INVALID');
  const issued = Date.parse(raw.issuedAt), expiry = Date.parse(raw.expiresAt);
  must(Number.isFinite(issued) && Number.isFinite(expiry) && issued <= now && now < expiry && expiry - issued <= MAX_REQUEST_LIFETIME_MS, 'REQUEST_EXPIRED_OR_UNBOUNDED');
  must(TOKEN.test(raw.runToken ?? ''), 'RUN_TOKEN_INVALID');
  only(raw.postgres, ['host', 'port', 'database', 'user', 'expectedSystemIdentifier', 'expectedHistory', 'expectedSchemaManifestSha256', 'expectedSchemaEntries'], 'REQUEST_POSTGRES_INVALID');
  must(Array.isArray(raw.postgres.expectedHistory), 'REQUEST_POSTGRES_INVALID');
  // an unsupported history length keeps the base (25) profile so the existing, specific REQUEST_HISTORY_INVALID refusal below still applies
  const length = raw.postgres.expectedHistory.length;
  const profile = length === 25 || length === 26 || OP_PROFILE[raw.operation]?.step ? profileFor(raw.operation, length) : OP_PROFILE[raw.operation];
  str(raw.postgres.host, 'REQUEST_POSTGRES_INVALID', 255); str(raw.postgres.user, 'REQUEST_POSTGRES_INVALID', 63); str(raw.postgres.database, 'REQUEST_POSTGRES_INVALID', 63);
  must(/^[A-Za-z0-9.-]+$/.test(raw.postgres.host) && /^[A-Za-z0-9_]+$/.test(raw.postgres.user) && /^[A-Za-z0-9_]+$/.test(raw.postgres.database), 'REQUEST_POSTGRES_INVALID');
  must(Number.isInteger(raw.postgres.port) && raw.postgres.port > 0 && raw.postgres.port < 65536, 'REQUEST_POSTGRES_INVALID');
  must(/^\d{10,25}$/.test(raw.postgres.expectedSystemIdentifier ?? ''), 'REQUEST_POSTGRES_INVALID');
  must(Array.isArray(raw.postgres.expectedHistory) && raw.postgres.expectedHistory.length === profile.history && raw.postgres.expectedHistory.every(row => row && typeof row.name === 'string' && HEX64.test(row.checksum ?? '') && Object.keys(row).length === 2), 'REQUEST_HISTORY_INVALID');
  must(HEX64.test(raw.postgres.expectedSchemaManifestSha256 ?? '') && raw.postgres.expectedSchemaEntries === profile.entries, 'REQUEST_SCHEMA_PIN_INVALID');
  only(raw.credentials, ['path', 'sha256'], 'REQUEST_CREDENTIALS_INVALID'); str(raw.credentials.path, 'REQUEST_CREDENTIALS_INVALID'); must(HEX64.test(raw.credentials.sha256 ?? ''), 'REQUEST_CREDENTIALS_INVALID');
  if (profile.storage) {
    only(raw.storage, ['endpoint', 'region', 'bucket', 'expectedEndpoint', 'expectedBucket'], 'REQUEST_STORAGE_INVALID');
    for (const key of ['endpoint', 'bucket', 'expectedEndpoint', 'expectedBucket']) str(raw.storage[key], 'REQUEST_STORAGE_INVALID', 512);
    must(raw.storage.region === undefined || typeof raw.storage.region === 'string', 'REQUEST_STORAGE_INVALID');
  } else must(raw.storage === undefined, 'REQUEST_STORAGE_INVALID'); // a migration step has no storage target at all
  only(raw.implementation, ['files', 'clientTreeSha256', 'migrationsTreeSha256'], 'REQUEST_IMPLEMENTATION_INVALID');
  must(raw.implementation.files && Object.values(raw.implementation.files).every(hash => HEX64.test(hash)) && HEX64.test(raw.implementation.clientTreeSha256 ?? '') && HEX64.test(raw.implementation.migrationsTreeSha256 ?? ''), 'REQUEST_IMPLEMENTATION_INVALID');
  only(raw.manifests, ['observedPath', 'observedSha256', 'approvedPath', 'approvedSha256'], 'REQUEST_MANIFESTS_INVALID');
  if (profile.manifests) {
    str(raw.manifests.observedPath, 'REQUEST_MANIFESTS_INVALID'); str(raw.manifests.approvedPath, 'REQUEST_MANIFESTS_INVALID');
    must(HEX64.test(raw.manifests.observedSha256 ?? '') && HEX64.test(raw.manifests.approvedSha256 ?? ''), 'REQUEST_MANIFESTS_INVALID');
  } else must(Object.keys(raw.manifests).length === 0, 'REQUEST_MANIFESTS_INVALID'); // observe and migrations take no approval input at all
  str(raw.evidenceDir, 'EVIDENCE_DIR_INVALID');
  if (raw.targetKind === 'disposable') {
    only(raw.disposablePins, ['postgres', 'minio'], 'REQUEST_PINS_INVALID');
    must(raw.disposablePins.postgres && (raw.disposablePins.minio || !profile.storage) && raw.authorization === undefined && raw.sharedDevPins === undefined && raw.copyPins === undefined, 'REQUEST_PINS_INVALID');
  } else if (raw.targetKind === 'copy') {
    // A copy is pinned by container id exactly like shared-dev, but it is a different system, needs no per-run authorization artifact, and is verified against `devcopy_*` volumes.
    must(raw.disposablePins === undefined && raw.sharedDevPins === undefined && raw.authorization === undefined, 'REQUEST_PINS_INVALID');
    only(raw.copyPins, ['postgres', 'minio'], 'REQUEST_PINS_INVALID');
    for (const pin of [raw.copyPins.postgres, ...(profile.storage ? [raw.copyPins.minio] : [])]) { only(pin, ['container', 'id'], 'REQUEST_PINS_INVALID'); must(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(pin.container ?? '') && /^[a-f0-9]{64}$/.test(pin.id ?? ''), 'REQUEST_PINS_INVALID'); }
    must(profile.storage || raw.copyPins.minio === undefined, 'REQUEST_PINS_INVALID');
  } else {
    must(raw.copyPins === undefined, 'REQUEST_PINS_INVALID');
    must(raw.disposablePins === undefined, 'REQUEST_PINS_INVALID');
    only(raw.sharedDevPins, ['postgres', 'minio'], 'REQUEST_PINS_INVALID');
    for (const pin of [raw.sharedDevPins.postgres, ...(profile.storage ? [raw.sharedDevPins.minio] : [])]) { only(pin, ['container', 'id'], 'REQUEST_PINS_INVALID'); must(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(pin.container ?? '') && /^[a-f0-9]{64}$/.test(pin.id ?? ''), 'REQUEST_PINS_INVALID'); }
    must(profile.storage || raw.sharedDevPins.minio === undefined, 'REQUEST_PINS_INVALID');
    only(raw.authorization, ['path', 'sha256'], 'REQUEST_AUTHORIZATION_INVALID'); str(raw.authorization.path, 'REQUEST_AUTHORIZATION_INVALID'); must(HEX64.test(raw.authorization.sha256 ?? ''), 'REQUEST_AUTHORIZATION_INVALID');
  }
  return raw;
}

// ---------------------------------------------------------------- credentials (private runtime path)
/**
 * Credentials come only from ONE private file outside the repository: owner-only, in an owner-only directory, not an environment file, not older
 * than four hours, pinned by hash in the request. The launcher hands the values to the bound child's environment and nowhere else.
 */
export function loadCredentials(request, root, now = Date.now()) {
  const path = realpathSync(resolve(request.credentials.path));
  must(!(path === root || path.startsWith(root + sep)), 'CREDENTIALS_INSIDE_REPOSITORY');
  must(!/^\.env/i.test(basename(path)) && !/\.env$/i.test(path), 'CREDENTIALS_ENV_FILE_FORBIDDEN');
  assertPrivateFile(path, 'CREDENTIALS_FILE_NOT_PRIVATE');
  const dir = statSync(dirname(path));
  must(dir.isDirectory() && (dir.mode & 0o077) === 0 && dir.uid === process.getuid(), 'CREDENTIALS_DIR_NOT_PRIVATE');
  const bytes = readFileSync(path);
  must(sha256(bytes) === request.credentials.sha256, 'CREDENTIALS_HASH_MISMATCH');
  const age = now - statSync(path).mtimeMs;
  must(age >= -60000 && age <= MAX_CREDENTIAL_AGE_MS, 'CREDENTIALS_STALE');
  const record = JSON.parse(bytes.toString('utf8'));
  const wantsStorage = OP_PROFILE[request.operation].storage;
  only(record, ['schema', 'postgresPassword', 'storageAccessKey', 'storageSecretKey'], 'CREDENTIALS_SHAPE_INVALID');
  must(record.schema === CREDENTIALS_SCHEMA && typeof record.postgresPassword === 'string' && record.postgresPassword.length >= 8, 'CREDENTIALS_SHAPE_INVALID');
  if (wantsStorage) must(typeof record.storageAccessKey === 'string' && record.storageAccessKey.length >= 3 && typeof record.storageSecretKey === 'string' && record.storageSecretKey.length >= 8, 'CREDENTIALS_SHAPE_INVALID');
  else must(record.storageAccessKey === undefined && record.storageSecretKey === undefined, 'CREDENTIALS_SHAPE_INVALID'); // a migration never receives storage credentials
  return record;
}
export const databaseUrl = (request, credentials) => `postgresql://${encodeURIComponent(request.postgres.user)}:${encodeURIComponent(credentials.postgresPassword)}@${request.postgres.host}:${request.postgres.port}/${request.postgres.database}`;
/** Non-secret fingerprint of the storage configuration: the same value the storage adapter reports as `configFingerprint`. */
export function storageConfigFingerprint(request, credentials) {
  const endpoint = new URL(request.storage.endpoint);
  const useSSL = endpoint.protocol === 'https:';
  const port = Number(endpoint.port || (useSSL ? 443 : 80));
  return sha256(JSON.stringify({ host: endpoint.hostname, port, useSSL, bucket: request.storage.bucket, region: request.storage.region ?? 'us-east-1', accessKeyId: sha256(credentials.storageAccessKey) }));
}

// ---------------------------------------------------------------- per-run authorization (shared-dev only)
/** Every field is part of the identity of ONE run. Nothing in it is a secret. */
export function validateAuthorizationStatic(record, request, implementation, evidenceDirPath, now = Date.now()) {
  const keys = ['schema', 'operation', 'targetKind', 'runToken', 'issuedAt', 'expiresAt', 'authorizedBy', 'statement', 'postgres', 'implementationSha256', 'storage', 'manifests', 'evidenceDir'];
  only(record, keys, 'AUTHORIZATION_SHAPE_INVALID');
  must(record.schema === AUTHORIZATION_SCHEMA && record.targetKind === 'shared-dev' && record.operation === request.operation && record.runToken === request.runToken, 'AUTHORIZATION_SCOPE_MISMATCH');
  str(record.authorizedBy, 'AUTHORIZATION_SHAPE_INVALID', 128); str(record.statement, 'AUTHORIZATION_SHAPE_INVALID', 500);
  const issued = Date.parse(record.issuedAt), expiry = Date.parse(record.expiresAt);
  must(Number.isFinite(issued) && Number.isFinite(expiry) && issued <= now && now < expiry && expiry - issued <= MAX_AUTHORIZATION_LIFETIME_MS, 'AUTHORIZATION_EXPIRED_OR_UNBOUNDED');
  only(record.postgres, ['systemIdentifier', 'database', 'migrationCount', 'historySha256', 'schemaManifestSha256', 'schemaEntries', 'm24', 'm25', 'm26'], 'AUTHORIZATION_SHAPE_INVALID');
  const pg = record.postgres, profile = profileFor(request.operation, request.postgres.expectedHistory.length);
  must(pg.systemIdentifier === request.postgres.expectedSystemIdentifier && pg.database === request.postgres.database, 'AUTHORIZATION_SCOPE_MISMATCH');
  must(pg.migrationCount === profile.history && pg.schemaEntries === profile.entries && HEX64.test(pg.historySha256 ?? '') && pg.schemaManifestSha256 === request.postgres.expectedSchemaManifestSha256, 'AUTHORIZATION_SCOPE_MISMATCH');
  must(pg.m24?.name === FROZEN_MIGRATIONS.m24.name && pg.m24?.checksum === FROZEN_MIGRATIONS.m24.checksum && pg.m25?.name === FROZEN_MIGRATIONS.m25.name && pg.m25?.checksum === FROZEN_MIGRATIONS.m25.checksum, 'AUTHORIZATION_SCOPE_MISMATCH');
  must(profile.history >= 26 ? pg.m26?.name === FROZEN_M26.name && pg.m26?.checksum === FROZEN_M26.checksum : pg.m26 === undefined || pg.m26 === null, 'AUTHORIZATION_SCOPE_MISMATCH');
  must(pg.historySha256 === historyDigest(request.postgres.expectedHistory.map(row => ({ ...row, finished: true, rolledBack: false }))), 'AUTHORIZATION_HISTORY_MISMATCH');
  must(record.implementationSha256 === implementationDigest(implementation), 'AUTHORIZATION_IMPLEMENTATION_MISMATCH');
  if (profile.storage) {
    only(record.storage, ['endpointHost', 'endpointPort', 'useSSL', 'bucket', 'configFingerprint'], 'AUTHORIZATION_SHAPE_INVALID');
    const endpoint = new URL(request.storage.expectedEndpoint);
    must(record.storage.bucket === request.storage.expectedBucket && record.storage.endpointHost === endpoint.hostname && record.storage.endpointPort === Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)) && record.storage.useSSL === (endpoint.protocol === 'https:') && HEX64.test(record.storage.configFingerprint ?? ''), 'AUTHORIZATION_SCOPE_MISMATCH');
  } else must(record.storage === null, 'AUTHORIZATION_SCOPE_MISMATCH');
  only(record.manifests, ['observedSha256', 'approvedSha256'], 'AUTHORIZATION_SHAPE_INVALID');
  if (profile.manifests) must(record.manifests.observedSha256 === request.manifests.observedSha256 && record.manifests.approvedSha256 === request.manifests.approvedSha256, 'AUTHORIZATION_SCOPE_MISMATCH');
  else must(record.manifests.observedSha256 === null && record.manifests.approvedSha256 === null, 'AUTHORIZATION_SCOPE_MISMATCH');
  must(record.evidenceDir === evidenceDirPath, 'AUTHORIZATION_EVIDENCE_DIR_MISMATCH');
  return record;
}
/** The observed side: what the launcher actually found must equal what the release owner authorized (checked before any application-data access). */
export function validateAuthorizationObserved(record, observed) {
  must(observed.systemIdentifier === record.postgres.systemIdentifier && observed.database === record.postgres.database, 'AUTHORIZATION_OBSERVED_MISMATCH');
  must(historyDigest(observed.history) === record.postgres.historySha256 && observed.history.length === record.postgres.migrationCount, 'AUTHORIZATION_OBSERVED_MISMATCH');
  must(observed.schemaManifestSha256 === record.postgres.schemaManifestSha256 && observed.schemaEntries === record.postgres.schemaEntries, 'AUTHORIZATION_OBSERVED_MISMATCH');
  if (record.storage !== null) {
    const s = observed.storage;
    must(s && s.endpointHost === record.storage.endpointHost && s.endpointPort === record.storage.endpointPort && s.useSSL === record.storage.useSSL && s.bucket === record.storage.bucket && s.configFingerprint === record.storage.configFingerprint && s.bucketExists === true, 'AUTHORIZATION_OBSERVED_MISMATCH');
  }
}

// ---------------------------------------------------------------- comparisons
export function assertImplementationMatches(expected, actual) {
  must(JSON.stringify(Object.keys(expected.files).sort()) === JSON.stringify(Object.keys(actual.files).sort()), 'IMPLEMENTATION_FILE_SET_MISMATCH');
  for (const [file, hash] of Object.entries(actual.files)) must(expected.files[file] === hash, 'IMPLEMENTATION_HASH_MISMATCH');
  must(expected.clientTreeSha256 === actual.clientTreeSha256, 'GENERATED_CLIENT_MISMATCH');
  must(expected.migrationsTreeSha256 === actual.migrationsTreeSha256, 'MIGRATION_CHAIN_MISMATCH');
}
/** Observed history must be exactly the expected finished, not-rolled-back migrations; from 25 on, the frozen M24/M25 identities are last. */
export function assertHistory(expectedHistory, observed, count = FROZEN_MIGRATIONS.count) {
  must(Array.isArray(observed) && observed.length === count && observed.length === expectedHistory.length, 'HISTORY_COUNT_MISMATCH');
  must(observed.every((row, index) => row.name === expectedHistory[index].name && row.checksum === expectedHistory[index].checksum), 'HISTORY_MISMATCH');
  must(observed.every(row => row.finished === true && row.rolledBack === false), 'HISTORY_INCOMPLETE');
  if (count >= 24) must(observed[23].name === FROZEN_MIGRATIONS.m24.name && observed[23].checksum === FROZEN_MIGRATIONS.m24.checksum, 'FROZEN_MIGRATION_MISMATCH');
  if (count >= 25) must(observed[24].name === FROZEN_MIGRATIONS.m25.name && observed[24].checksum === FROZEN_MIGRATIONS.m25.checksum, 'FROZEN_MIGRATION_MISMATCH');
  if (count >= 26) must(observed[25].name === FROZEN_M26.name && observed[25].checksum === FROZEN_M26.checksum, 'FROZEN_MIGRATION_MISMATCH');
  if (count === 25) must(!observed.some(row => row.name === FROZEN_M26.name), 'FROZEN_MIGRATION_MISMATCH');
  if (count < 24) must(!observed.some(row => row.name === FROZEN_MIGRATIONS.m24.name || row.name === FROZEN_MIGRATIONS.m25.name), 'FROZEN_MIGRATION_MISMATCH');
  if (count === 24) must(!observed.some(row => row.name === FROZEN_MIGRATIONS.m25.name), 'FROZEN_MIGRATION_MISMATCH');
}
export function assertSchemaObserved(request, observed) {
  const profile = profileFor(request.operation, request.postgres.expectedHistory.length);
  must(observed.schemaEntries === profile.entries && observed.schemaEntries === request.postgres.expectedSchemaEntries, 'SCHEMA_ENTRY_COUNT_MISMATCH');
  must(observed.schemaManifestSha256 === request.postgres.expectedSchemaManifestSha256, 'SCHEMA_MANIFEST_MISMATCH');
}
export function assertDatabaseTarget(request, observed) {
  must(observed.systemIdentifier === request.postgres.expectedSystemIdentifier && observed.database === request.postgres.database, 'SYSTEM_IDENTITY_MISMATCH');
  if (request.targetKind === 'disposable') {
    must(request.postgres.host === '127.0.0.1' && /^554[67][0-9]$/.test(String(request.postgres.port)) && request.postgres.user === 'postgres' && request.postgres.database === 'fieldframe', 'DISPOSABLE_TARGET_REQUIRED');
    must(observed.systemIdentifier !== APPLICATION_SYSTEM && request.postgres.expectedSystemIdentifier !== APPLICATION_SYSTEM, 'APPLICATION_SYSTEM_FORBIDDEN_FOR_DISPOSABLE');
    must(request.disposablePins.postgres.port === request.postgres.port, 'URL_CONTAINER_MISMATCH');
  } else if (request.targetKind === 'copy') {
    // never the shared-dev system, loopback only, the same database name the application uses
    must(request.postgres.host === '127.0.0.1' && request.postgres.database === 'fieldframe', 'COPY_TARGET_REQUIRED');
    must(observed.systemIdentifier !== APPLICATION_SYSTEM && request.postgres.expectedSystemIdentifier !== APPLICATION_SYSTEM, 'APPLICATION_SYSTEM_FORBIDDEN_FOR_COPY');
  } else must(observed.systemIdentifier === APPLICATION_SYSTEM, 'SHARED_DEV_SYSTEM_REQUIRED');
}
export function assertStorageTarget(request, observedIdentity) {
  const s = request.storage;
  must(s.endpoint === s.expectedEndpoint && s.bucket === s.expectedBucket, 'STORAGE_TARGET_MISMATCH');
  const endpoint = new URL(s.endpoint);
  must(/^https?:$/.test(endpoint.protocol) && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && (endpoint.pathname === '/' || endpoint.pathname === ''), 'STORAGE_ENDPOINT_INVALID');
  if (request.targetKind === 'copy') must(endpoint.hostname === '127.0.0.1', 'COPY_STORAGE_REQUIRED');
  if (request.targetKind === 'disposable') {
    must(endpoint.hostname === '127.0.0.1' && endpoint.port === String(request.disposablePins.minio.port) && /^g1-[a-z0-9-]+$/.test(s.bucket), 'DISPOSABLE_STORAGE_REQUIRED');
  }
  must(observedIdentity.bucketExists === true && observedIdentity.bucket === s.expectedBucket && observedIdentity.endpointHost === endpoint.hostname && observedIdentity.endpointPort === Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)), 'STORAGE_IDENTITY_MISMATCH');
}

// ---------------------------------------------------------------- migration verification (manifest delta)
/** Names the reviewed M24 adds (4 columns, 2 constraints, 3 triggers, 3 functions) and M25 adds (1 column). Schema-qualified `public.` prefixes are tolerated on functions. */
export const ADDED_BY = Object.freeze({
  'migrate-m24': Object.freeze({ column: ['modality', 'modalityContentRevision', 'modalityResolvedAt', 'modalityResolverSubject'], constraint: ['dataset_modality_resolution_shape', 'dataset_modality_revision_nonnegative'], trigger: ['asset_modality_write_guard', 'dataset_modality_assignment_guard', 'dataset_modality_insert_guard'], routine: ['phase029_guard_asset_write()', 'phase029_guard_dataset_assignment()', 'phase029_guard_dataset_insert()'] }),
  'migrate-m25': Object.freeze({ column: ['creationRequestHash'], constraint: [], trigger: [], routine: [] }),
});
const rowKey = row => `${row[0]}\u0000${row[1]}`;
/** Exact schema delta of one migration step: only the named objects were added; nothing removed; no existing entry changed. */
export function assertMigrationDelta(operation, pre, post) {
  must(Array.isArray(pre) && Array.isArray(post), 'MANIFEST_MISSING');
  if (operation === 'migrate-m26') return assertM26Delta(pre, post);
  const expected = ADDED_BY[operation];
  const before = new Map(pre.map(row => [rowKey(row), row])), after = new Map(post.map(row => [rowKey(row), row]));
  must(before.size === pre.length && after.size === post.length, 'MANIFEST_DUPLICATE_IDENTITY');
  const removed = pre.filter(row => !after.has(rowKey(row))), added = post.filter(row => !before.has(rowKey(row)));
  const changed = post.filter(row => before.has(rowKey(row)) && JSON.stringify(before.get(rowKey(row))[2]) !== JSON.stringify(row[2]));
  must(removed.length === 0 && changed.length === 0, 'MIGRATION_CHANGED_EXISTING_SCHEMA');
  const total = expected.column.length + expected.constraint.length + expected.trigger.length + expected.routine.length;
  must(added.length === total && post.length === pre.length + total, 'MIGRATION_SCHEMA_DELTA_UNEXPECTED');
  const names = kind => added.filter(row => row[0] === kind).map(row => JSON.parse(row[1]));
  const last = list => list.map(parts => String(parts.at(-1)).replace(/^public\./, '')).sort();
  must(JSON.stringify(last(names('column'))) === JSON.stringify([...expected.column].sort()), 'MIGRATION_SCHEMA_DELTA_UNEXPECTED');
  must(JSON.stringify(last(names('constraint'))) === JSON.stringify([...expected.constraint].sort()), 'MIGRATION_SCHEMA_DELTA_UNEXPECTED');
  must(JSON.stringify(last(names('trigger'))) === JSON.stringify([...expected.trigger].sort()), 'MIGRATION_SCHEMA_DELTA_UNEXPECTED');
  must(JSON.stringify(last(names('routine'))) === JSON.stringify([...expected.routine].sort()), 'MIGRATION_SCHEMA_DELTA_UNEXPECTED');
  if (operation === 'migrate-m24') must(names('column').every(parts => parts[1] === 'Dataset'), 'MIGRATION_SCHEMA_DELTA_UNEXPECTED');
  else must(names('column').every(parts => parts[1] === 'PreparedImport'), 'MIGRATION_SCHEMA_DELTA_UNEXPECTED');
  return { added: added.length, removed: 0, changed: 0, kinds: Object.fromEntries(['column', 'constraint', 'trigger', 'routine'].map(kind => [kind, names(kind).length])) };
}
/** The exact M26 delta: 100 added entries whose identity digest is pinned, none removed or changed, every added column on the new table. */
export function assertM26Delta(pre, post) {
  const before = new Map(pre.map(row => [rowKey(row), row])), after = new Map(post.map(row => [rowKey(row), row]));
  must(before.size === pre.length && after.size === post.length, 'MANIFEST_DUPLICATE_IDENTITY');
  must(pre.length === FROZEN_M26.entriesBefore && post.length === FROZEN_M26.entriesAfter, 'MIGRATION_SCHEMA_DELTA_UNEXPECTED');
  const removed = pre.filter(row => !after.has(rowKey(row))), added = post.filter(row => !before.has(rowKey(row)));
  const changed = post.filter(row => before.has(rowKey(row)) && JSON.stringify(before.get(rowKey(row))[2]) !== JSON.stringify(row[2]));
  must(removed.length === 0 && changed.length === 0, 'MIGRATION_CHANGED_EXISTING_SCHEMA');
  must(added.length === FROZEN_M26.added && sha256(JSON.stringify(added.map(row => `${row[0]}\u0000${row[1]}`).sort())) === FROZEN_M26.addedKeysSha256, 'MIGRATION_SCHEMA_DELTA_UNEXPECTED');
  const columns = added.filter(row => row[0] === 'column').map(row => JSON.parse(row[1]));
  must(columns.every(parts => FROZEN_M26.newTables.includes(String(parts[1])) || parts[1].startsWith('MediaVerification')), 'MIGRATION_SCHEMA_DELTA_UNEXPECTED');
  const kinds = Object.fromEntries(['column', 'constraint', 'enum', 'index', 'relation', 'type'].map(kind => [kind, added.filter(row => row[0] === kind).length]));
  return { added: added.length, removed: 0, changed: 0, kinds };
}
/** Row data must not move: the per-table (count, md5) fingerprints are equal before and after (the columns a step adds are excluded by the probe's SQL). */
export function assertTablesUnchanged(pre, post, newTables = []) {
  // a step may ADD whole new tables (M26: MediaVerification, which must be empty); every table that existed before must be identical
  const fresh = post.filter(row => !pre.some(old => old[0] === row[0]));
  must(JSON.stringify(fresh.map(row => row[0]).sort()) === JSON.stringify([...newTables].sort()) && fresh.every(row => Number(row[1]) === 0), 'MIGRATION_TABLE_SET_CHANGED');
  const kept = post.filter(row => !fresh.includes(row));
  must(JSON.stringify(pre.map(row => row[0])) === JSON.stringify(kept.map(row => row[0])), 'MIGRATION_TABLE_SET_CHANGED');
  for (let index = 0; index < pre.length; index += 1) must(pre[index][1] === kept[index][1] && pre[index][2] === kept[index][2], 'MIGRATION_DATA_CHANGED');
  return { tables: pre.length, newTables: fresh.map(row => row[0]) };
}

/** Everything a human or an auditor needs to know about what the run was bound to, with no secret in it. */
export function buildBinding({ request, requestSha256, implementation, dbObserved, storageObserved, containers, evidence, now }) {
  const profile = profileFor(request.operation, request.postgres.expectedHistory.length);
  return {
    schema: BINDING_SCHEMA,
    boundAt: new Date(now).toISOString(),
    operation: request.operation,
    targetKind: request.targetKind,
    requestId: request.requestId,
    requestSha256,
    runToken: request.runToken,
    resolverSubject: `system:phase029-backfill:${request.runToken}`,
    postgres: {
      systemIdentifier: dbObserved.systemIdentifier, database: dbObserved.database, host: request.postgres.host, port: request.postgres.port, user: request.postgres.user,
      migrationCount: dbObserved.history.length, historySha256: historyDigest(dbObserved.history), m24: FROZEN_MIGRATIONS.m24, m25: FROZEN_MIGRATIONS.m25, m26: dbObserved.history.length >= 26 ? { name: FROZEN_M26.name, checksum: FROZEN_M26.checksum } : null,
      schemaEntries: dbObserved.schemaEntries, schemaManifestSha256: dbObserved.schemaManifestSha256, datasets: dbObserved.datasets,
    },
    storage: profile.storage ? { endpointHost: storageObserved.endpointHost, endpointPort: storageObserved.endpointPort, useSSL: storageObserved.useSSL, bucket: storageObserved.bucket, bucketExists: storageObserved.bucketExists, configFingerprint: storageObserved.configFingerprint } : null,
    containers: containers ?? null,
    implementation,
    implementationSha256: implementationDigest(implementation),
    manifests: request.operation === 'apply' ? { observedSha256: request.manifests.observedSha256, approvedSha256: request.manifests.approvedSha256 } : null,
    evidenceDir: evidence,
  };
}

/** Redacts any secret value from text (defense in depth: the evidence files are built without secrets). */
export function containsSecret(text, secrets) { return secrets.some(secret => secret && text.includes(secret)); }
export const resolveEvidenceRoots = root => [join(root, 'specs/029-modality-specific-datasets/verification/maintenance-runs'), join(root, '.data/maintenance-runs')].map(path => resolve(path));
