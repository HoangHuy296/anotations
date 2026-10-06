// Pure rules and small filesystem helpers for the Phase029 T029/T031 maintenance launcher (backfill-launcher.mjs).
// Nothing here contacts a database or a storage service. Every rule fails closed with an upper-case code.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
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

export const REQUEST_SCHEMA = 'phase029-backfill-request/v1';
export const RECEIPT_SCHEMA = 'phase029-backfill-execution-receipt/v1';
export const BINDING_SCHEMA = 'phase029-backfill-binding/v1';
export const AUTHORIZATION_SCHEMA = 'phase029-backfill-authorization/v1';
export const OPERATIONS = ['observe', 'apply'];
export const TARGET_KINDS = ['disposable', 'shared-dev'];
/** The application database's system identifier. A disposable run must never match it; a shared-dev run must. */
export const APPLICATION_SYSTEM = '7662655305624969250';
export const MAX_REQUEST_LIFETIME_MS = 30 * 60 * 1000;

/** The canonical 25-migration chain tail: any other bytes for migrations 24 and 25 are refused regardless of what a request says. */
export const FROZEN_MIGRATIONS = Object.freeze({
  count: 25,
  m24: Object.freeze({ name: '20260930030000_dataset_modality_g2', checksum: '13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7' }),
  m25: Object.freeze({ name: '20261006000000_prepared_import_creation_request_hash', checksum: 'a8ffbc84bde7f18aac93bbb2e87423e6cfcbf6efd95c01e6650824fdcc3ed859' }),
  schemaEntries: 1842,
});

/** Files whose bytes decide what T029/T031 do. The request must pin every one of them (and the two trees) to the reviewed hashes. */
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
]);

export function computeImplementation(root) {
  const files = Object.fromEntries(IMPLEMENTATION_FILES.map(file => [file, sha256(readFileSync(join(root, file)))]));
  return { files, clientTreeSha256: treeHash(readTree(join(root, 'lib/generated/prisma'))), migrationsTreeSha256: treeHash(readTree(join(root, 'prisma/migrations'))) };
}

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

// ---------------------------------------------------------------- ambient environment
const AMBIENT = /^(DATABASE_URL|DATABASE_URL_DOCKER|DIRECT_URL|SHADOW_DATABASE_URL|PG[A-Z_]*|REDIS_[A-Z_]*|MINIO_[A-Z_]*|S3_[A-Z_]*|AWS_[A-Z_]*|STORAGE_[A-Z_]*|BACKFILL_[A-Z_]*|DB_SAFETY_[A-Z_]*|G1_[A-Z_]*|NODE_OPTIONS|NODE_PATH|BULLMQ_[A-Z_]*)$/;
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

export function validateRequest(raw, now = Date.now()) {
  only(raw, ['schema', 'operation', 'targetKind', 'requestId', 'issuedAt', 'expiresAt', 'runToken', 'postgres', 'storage', 'implementation', 'manifests', 'evidenceDir', 'disposablePins', 'authorization'], 'REQUEST_SHAPE_INVALID');
  must(raw.schema === REQUEST_SCHEMA, 'REQUEST_SCHEMA_UNSUPPORTED');
  must(OPERATIONS.includes(raw.operation), 'REQUEST_OPERATION_INVALID');
  must(TARGET_KINDS.includes(raw.targetKind), 'REQUEST_TARGET_KIND_INVALID');
  must(UUID.test(raw.requestId ?? ''), 'REQUEST_ID_INVALID');
  const issued = Date.parse(raw.issuedAt), expiry = Date.parse(raw.expiresAt);
  must(Number.isFinite(issued) && Number.isFinite(expiry) && issued <= now && now < expiry && expiry - issued <= MAX_REQUEST_LIFETIME_MS, 'REQUEST_EXPIRED_OR_UNBOUNDED');
  must(TOKEN.test(raw.runToken ?? ''), 'RUN_TOKEN_INVALID');
  only(raw.postgres, ['url', 'expectedSystemIdentifier', 'expectedDatabase', 'expectedHistory', 'expectedSchemaManifestSha256', 'expectedSchemaEntries'], 'REQUEST_POSTGRES_INVALID');
  str(raw.postgres.url, 'REQUEST_POSTGRES_INVALID'); must(/^\d{10,25}$/.test(raw.postgres.expectedSystemIdentifier ?? ''), 'REQUEST_POSTGRES_INVALID');
  str(raw.postgres.expectedDatabase, 'REQUEST_POSTGRES_INVALID', 63);
  must(Array.isArray(raw.postgres.expectedHistory) && raw.postgres.expectedHistory.length === FROZEN_MIGRATIONS.count && raw.postgres.expectedHistory.every(row => row && typeof row.name === 'string' && HEX64.test(row.checksum ?? '') && Object.keys(row).length === 2), 'REQUEST_HISTORY_INVALID');
  must(HEX64.test(raw.postgres.expectedSchemaManifestSha256 ?? '') && raw.postgres.expectedSchemaEntries === FROZEN_MIGRATIONS.schemaEntries, 'REQUEST_SCHEMA_PIN_INVALID');
  only(raw.storage, ['endpoint', 'accessKey', 'secretKey', 'region', 'bucket', 'expectedEndpoint', 'expectedBucket'], 'REQUEST_STORAGE_INVALID');
  for (const key of ['endpoint', 'accessKey', 'secretKey', 'bucket', 'expectedEndpoint', 'expectedBucket']) str(raw.storage[key], 'REQUEST_STORAGE_INVALID', 512);
  must(raw.storage.region === undefined || typeof raw.storage.region === 'string', 'REQUEST_STORAGE_INVALID');
  only(raw.implementation, ['files', 'clientTreeSha256', 'migrationsTreeSha256'], 'REQUEST_IMPLEMENTATION_INVALID');
  must(raw.implementation.files && Object.values(raw.implementation.files).every(hash => HEX64.test(hash)) && HEX64.test(raw.implementation.clientTreeSha256 ?? '') && HEX64.test(raw.implementation.migrationsTreeSha256 ?? ''), 'REQUEST_IMPLEMENTATION_INVALID');
  only(raw.manifests, ['observedPath', 'observedSha256', 'approvedPath', 'approvedSha256'], 'REQUEST_MANIFESTS_INVALID');
  if (raw.operation === 'apply') {
    str(raw.manifests.observedPath, 'REQUEST_MANIFESTS_INVALID'); str(raw.manifests.approvedPath, 'REQUEST_MANIFESTS_INVALID');
    must(HEX64.test(raw.manifests.observedSha256 ?? '') && HEX64.test(raw.manifests.approvedSha256 ?? ''), 'REQUEST_MANIFESTS_INVALID');
  } else must(Object.keys(raw.manifests).length === 0, 'REQUEST_MANIFESTS_INVALID'); // observe takes no approval input at all
  str(raw.evidenceDir, 'EVIDENCE_DIR_INVALID');
  if (raw.targetKind === 'disposable') {
    only(raw.disposablePins, ['postgres', 'minio'], 'REQUEST_PINS_INVALID');
    must(raw.disposablePins.postgres && raw.disposablePins.minio && raw.authorization === undefined, 'REQUEST_PINS_INVALID');
  } else {
    must(raw.disposablePins === undefined, 'REQUEST_PINS_INVALID');
    only(raw.authorization, ['path', 'sha256'], 'REQUEST_AUTHORIZATION_INVALID'); str(raw.authorization.path, 'REQUEST_AUTHORIZATION_INVALID'); must(HEX64.test(raw.authorization.sha256 ?? ''), 'REQUEST_AUTHORIZATION_INVALID');
  }
  return raw;
}

/** The release owner's authorization record for a shared-dev run (unreachable while SHARED_DEV_ENABLED is false in the launcher). */
export function validateAuthorization(record, request, now = Date.now()) {
  only(record, ['schema', 'operation', 'systemIdentifier', 'runToken', 'approvedManifestSha256', 'storageEndpoint', 'bucket', 'issuedAt', 'expiresAt', 'authorizedBy', 'statement'], 'AUTHORIZATION_SHAPE_INVALID');
  must(record.schema === AUTHORIZATION_SCHEMA && record.operation === request.operation, 'AUTHORIZATION_SCOPE_MISMATCH');
  must(record.systemIdentifier === request.postgres.expectedSystemIdentifier && record.runToken === request.runToken, 'AUTHORIZATION_SCOPE_MISMATCH');
  must(record.storageEndpoint === request.storage.expectedEndpoint && record.bucket === request.storage.expectedBucket, 'AUTHORIZATION_SCOPE_MISMATCH');
  must(request.operation === 'apply' ? record.approvedManifestSha256 === request.manifests.approvedSha256 : record.approvedManifestSha256 === null, 'AUTHORIZATION_SCOPE_MISMATCH');
  str(record.authorizedBy, 'AUTHORIZATION_SHAPE_INVALID', 128); str(record.statement, 'AUTHORIZATION_SHAPE_INVALID', 500);
  const issued = Date.parse(record.issuedAt), expiry = Date.parse(record.expiresAt);
  must(Number.isFinite(issued) && Number.isFinite(expiry) && issued <= now && now < expiry && expiry - issued <= 4 * 3600 * 1000, 'AUTHORIZATION_EXPIRED_OR_UNBOUNDED');
  return record;
}

// ---------------------------------------------------------------- comparisons
export function assertImplementationMatches(expected, actual) {
  must(JSON.stringify(Object.keys(expected.files).sort()) === JSON.stringify(Object.keys(actual.files).sort()), 'IMPLEMENTATION_FILE_SET_MISMATCH');
  for (const [file, hash] of Object.entries(actual.files)) must(expected.files[file] === hash, 'IMPLEMENTATION_HASH_MISMATCH');
  must(expected.clientTreeSha256 === actual.clientTreeSha256, 'GENERATED_CLIENT_MISMATCH');
  must(expected.migrationsTreeSha256 === actual.migrationsTreeSha256, 'MIGRATION_CHAIN_MISMATCH');
}
/** Observed history must be exactly the 25 expected, finished, not rolled-back migrations, with the frozen M24/M25 identities last. */
export function assertHistory(expectedHistory, observed) {
  must(Array.isArray(observed) && observed.length === FROZEN_MIGRATIONS.count && observed.length === expectedHistory.length, 'HISTORY_COUNT_MISMATCH');
  must(observed.every((row, index) => row.name === expectedHistory[index].name && row.checksum === expectedHistory[index].checksum), 'HISTORY_MISMATCH');
  must(observed.every(row => row.finished === true && row.rolledBack === false), 'HISTORY_INCOMPLETE');
  const [m24, m25] = observed.slice(-2);
  must(m24.name === FROZEN_MIGRATIONS.m24.name && m24.checksum === FROZEN_MIGRATIONS.m24.checksum && m25.name === FROZEN_MIGRATIONS.m25.name && m25.checksum === FROZEN_MIGRATIONS.m25.checksum, 'FROZEN_MIGRATION_MISMATCH');
}
export function assertSchemaObserved(request, observed) {
  must(observed.schemaEntries === FROZEN_MIGRATIONS.schemaEntries && observed.schemaEntries === request.postgres.expectedSchemaEntries, 'SCHEMA_ENTRY_COUNT_MISMATCH');
  must(observed.schemaManifestSha256 === request.postgres.expectedSchemaManifestSha256, 'SCHEMA_MANIFEST_MISMATCH');
}
export function assertDatabaseTarget(request, observed, resolvePorts = {}) {
  must(observed.systemIdentifier === request.postgres.expectedSystemIdentifier && observed.database === request.postgres.expectedDatabase, 'SYSTEM_IDENTITY_MISMATCH');
  const url = new URL(request.postgres.url);
  must(url.protocol === 'postgresql:' && !url.search && !url.hash && url.pathname === `/${request.postgres.expectedDatabase}` && !!url.hostname && !!url.username, 'DATABASE_URL_INVALID');
  if (request.targetKind === 'disposable') {
    must(url.hostname === '127.0.0.1' && /^554[67][0-9]$/.test(url.port) && url.username === 'postgres' && !!url.password, 'DISPOSABLE_TARGET_REQUIRED');
    must(observed.systemIdentifier !== APPLICATION_SYSTEM && request.postgres.expectedSystemIdentifier !== APPLICATION_SYSTEM, 'APPLICATION_SYSTEM_FORBIDDEN_FOR_DISPOSABLE');
    must(String(request.disposablePins.postgres.port) === url.port, 'URL_CONTAINER_MISMATCH');
  } else must(observed.systemIdentifier === APPLICATION_SYSTEM, 'SHARED_DEV_SYSTEM_REQUIRED');
  void resolvePorts;
}
export function assertStorageTarget(request, observedIdentity) {
  const s = request.storage;
  must(s.endpoint === s.expectedEndpoint && s.bucket === s.expectedBucket, 'STORAGE_TARGET_MISMATCH');
  const endpoint = new URL(s.endpoint);
  must(/^https?:$/.test(endpoint.protocol) && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && (endpoint.pathname === '/' || endpoint.pathname === ''), 'STORAGE_ENDPOINT_INVALID');
  if (request.targetKind === 'disposable') {
    must(endpoint.hostname === '127.0.0.1' && endpoint.port === String(request.disposablePins.minio.port) && /^g1-[a-z0-9-]+$/.test(s.bucket), 'DISPOSABLE_STORAGE_REQUIRED');
  }
  must(observedIdentity.bucketExists === true && observedIdentity.bucket === s.expectedBucket && observedIdentity.endpointHost === endpoint.hostname && observedIdentity.endpointPort === Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)), 'STORAGE_IDENTITY_MISMATCH');
}

/** Everything a human or an auditor needs to know about what the run was bound to, with no secret in it. */
export function buildBinding({ request, requestSha256, implementation, dbObserved, storageObserved, evidence, now }) {
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
      systemIdentifier: dbObserved.systemIdentifier, database: dbObserved.database, host: new URL(request.postgres.url).hostname, port: new URL(request.postgres.url).port,
      migrationCount: dbObserved.history.length, historySha256: sha256(canonicalJson(dbObserved.history)), m24: FROZEN_MIGRATIONS.m24, m25: FROZEN_MIGRATIONS.m25,
      schemaEntries: dbObserved.schemaEntries, schemaManifestSha256: dbObserved.schemaManifestSha256,
      datasets: dbObserved.datasets,
    },
    storage: { endpointHost: storageObserved.endpointHost, endpointPort: storageObserved.endpointPort, useSSL: storageObserved.useSSL, bucket: storageObserved.bucket, bucketExists: storageObserved.bucketExists, configFingerprint: storageObserved.configFingerprint },
    implementation,
    manifests: request.operation === 'apply' ? { observedSha256: request.manifests.observedSha256, approvedSha256: request.manifests.approvedSha256 } : null,
    evidenceDir: evidence,
  };
}

/** Redacts any secret value from text (defense in depth: the evidence files are built without secrets). */
export function containsSecret(text, secrets) { return secrets.some(secret => secret && text.includes(secret)); }
export const resolveEvidenceRoots = root => [join(root, 'specs/029-modality-specific-datasets/verification/maintenance-runs'), join(root, '.data/maintenance-runs')].map(path => resolve(path));
