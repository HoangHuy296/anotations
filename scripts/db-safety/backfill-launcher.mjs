// Receipt-bound maintenance launcher for Phase029: T029 (observe), T031 (apply) and the two guarded migration steps (migrate-m24, migrate-m25).
//
//   node scripts/db-safety/backfill-launcher.mjs <observe|apply|migrate-m24|migrate-m25> <request.json>
//
// The single input is a private request file (NO secrets) that pins every identity the run may touch; credentials come only from the one private file the
// request names (outside the repository, owner-only, hash-pinned) and reach nothing but the bound child. Nothing is taken from the environment (an
// inherited database/storage variable aborts the run) and nothing is inferred. Every check fails closed with an upper-case code BEFORE any application data or
// object store is read or written. The launcher only runs the hash-pinned child inside a fence that allows exactly the bound endpoints (or the pinned
// Prisma migration step), then seals immutable, secret-free evidence: binding.json, the output, receipt.json.
//
// SHARED-DEV EXECUTION IS DISABLED BY DEFAULT. `SHARED_DEV_ENABLED` is a source constant; enabling it is a reviewed, hash-bound change (see
// release/launcher-enable-shared-dev.patch) and DOES NOT AUTHORIZE ANYTHING: every shared-dev invocation additionally needs an exact, unexpired,
// per-run authorization artifact (phase029-backfill-authorization/v2) bound to the target, history, schema, implementation, storage, manifests,
// run token, operation, expiry and evidence directory.
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  APPLICATION_SYSTEM, FROZEN_M26, FROZEN_MIGRATIONS, OPERATIONS, OP_PROFILE, profileFor, RECEIPT_SCHEMA, assertDatabaseTarget, assertHistory, assertImplementationMatches, assertMigrationDelta, assertNoAmbientTargets, assertPrivateFile,
  assertSchemaObserved, assertStorageTarget, assertTablesUnchanged, buildBinding, computeImplementation, containsSecret, databaseUrl, historyDigest, isMigration, loadCredentials, manifestDigest, manifestSql, must, prepareEvidenceDir,
  resolveEvidenceRoots, sha256, storageConfigFingerprint, validateAuthorizationObserved, validateAuthorizationStatic, validateRequest, writeImmutable,
} from './backfill-binding.mjs';

export const SHARED_DEV_ENABLED = false;
const ROOT = resolve(import.meta.dirname, '../..');
const code = error => (/^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'LAUNCHER_FAILURE');
const ADDED_KEYS = ['modality', 'modalityContentRevision', 'modalityResolvedAt', 'modalityResolverSubject', 'creationRequestHash'];

/** Read-only database observation through psql: identity, history, schema manifest, Dataset counts and (migration steps) per-table fingerprints. */
function probeDatabase(request, credentials, root, { withTables = false } = {}) {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, PGHOST: request.postgres.host, PGPORT: String(request.postgres.port), PGDATABASE: request.postgres.database, PGUSER: request.postgres.user,
    PGPASSWORD: credentials.postgresPassword, PGAPPNAME: 'phase029-maintenance-launcher', PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=5000',
  };
  const psql = statements => {
    const input = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${statements.join('\n')}\nROLLBACK;\n`;
    const result = spawnSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 });
    must(result.status === 0, 'DATABASE_UNAVAILABLE');
    const lines = result.stdout.trim().split('\n');
    must(lines.length === statements.length, 'DATABASE_PROBE_INCOMPLETE');
    return lines.map(line => JSON.parse(line));
  };
  const [identity, history, manifest, datasets, tableList] = psql([
    `SELECT json_build_object('systemIdentifier',system_identifier::text,'database',current_database()) FROM pg_control_system();`,
    `SELECT coalesce(json_agg(json_build_object('name',migration_name,'checksum',checksum,'finished',finished_at IS NOT NULL,'rolledBack',rolled_back_at IS NOT NULL) ORDER BY started_at, migration_name),'[]'::json) FROM public._prisma_migrations;`,
    manifestSql(root),
    `SELECT json_build_object('total',count(*),'unresolved',count(*) FILTER (WHERE (to_jsonb(x)->>'modality') IS NULL),'resolved',count(*) FILTER (WHERE (to_jsonb(x)->>'modality') IS NOT NULL),'live',count(*) FILTER (WHERE "deletedAt" IS NULL AND "archivedAt" IS NULL)) FROM public."Dataset" x;`,
    `SELECT coalesce(json_agg(tablename ORDER BY tablename),'[]'::json) FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations';`,
  ]);
  let tables = null;
  if (withTables) {
    must(tableList.every(name => /^[A-Za-z][A-Za-z0-9_]*$/.test(name)), 'TABLE_NAME_UNSAFE');
    const keys = ADDED_KEYS.map(key => `'${key}'`).join(',');
    tables = psql(tableList.map(name => `SELECT json_build_array('${name}', count(*), md5(coalesce(string_agg(h,'' ORDER BY h),''))) FROM (SELECT md5((to_jsonb(x) - ARRAY[${keys}])::text) AS h FROM public."${name}" x) t;`));
  }
  return { systemIdentifier: identity.systemIdentifier, database: identity.database, history, manifestRows: manifest, schemaEntries: manifest.length, schemaManifestSha256: manifestDigest(manifest), datasets, tables };
}

/** The child runner is the only code that reads storage; the launcher uses it for the identity probe too, so there is exactly one adapter. */
function childSpec(request, credentials, evidenceDir, operation, extraEnv = {}) {
  const dbUrl = databaseUrl(request, credentials);
  const allowed = [`${request.postgres.host}:${request.postgres.port}`];
  const storageEnv = {};
  if (request.storage) {
    const storage = new URL(request.storage.endpoint);
    allowed.push(`${storage.hostname}:${storage.port || (storage.protocol === 'https:' ? 443 : 80)}`);
    Object.assign(storageEnv, { STORAGE_ENDPOINT: request.storage.endpoint, STORAGE_ACCESS_KEY: credentials.storageAccessKey, STORAGE_SECRET_KEY: credentials.storageSecretKey, STORAGE_BUCKET: request.storage.bucket, ...(request.storage.region ? { STORAGE_REGION: request.storage.region } : {}) });
  }
  return {
    cwd: join(ROOT, 'apps/web'),
    args: ['--require', join(ROOT, 'apps/web/tests/auth-ownership/register-server-only.cjs'), '--require', join(ROOT, 'scripts/db-safety/maintenance-fence.cjs'), '--import', 'tsx', 'scripts/backfill-run.ts'],
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, NODE_ENV: 'test', DATABASE_URL: dbUrl, ...storageEnv,
      BACKFILL_OPERATION: operation, BACKFILL_EVIDENCE_DIR: evidenceDir, BACKFILL_RUN_TOKEN: request.runToken, BACKFILL_ALLOWED_ENDPOINTS: JSON.stringify(allowed), ...extraEnv,
    },
  };
}
const spawnChild = spec => {
  const result = spawnSync(process.execPath, spec.args, { cwd: spec.cwd, env: spec.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000 });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

/**
 * One migration step through the Prisma CLI with a frozen, private config (the same technique as the disposable G1 launcher): a staged copy of the schema and of
 * exactly the migrations the step expects (every file hash-checked against the request and the frozen M24/M25 bytes), so `migrate deploy` has exactly one pending
 * migration. The staging directory (it holds a config with the connection URL) is removed afterwards.
 */
function runMigration(request, credentials, root) {
  const profile = OP_PROFILE[request.operation];
  const names = [...request.postgres.expectedHistory.map(row => row.name), profile.step.name];
  const stage = mkdtempSync('/tmp/phase029-maint-');
  try {
    chmodSync(stage, 0o700);
    cpSync(join(root, 'prisma/schema.prisma'), join(stage, 'schema.prisma'));
    mkdirSync(join(stage, 'migrations'));
    cpSync(join(root, 'prisma/migrations/migration_lock.toml'), join(stage, 'migrations/migration_lock.toml'));
    const expected = [...request.postgres.expectedHistory.map(row => [row.name, row.checksum]), [profile.step.name, profile.step.checksum]];
    for (const [name, checksum] of expected) {
      cpSync(join(root, 'prisma/migrations', name), join(stage, 'migrations', name), { recursive: true });
      must(sha256(readFileSync(join(stage, 'migrations', name, 'migration.sql'))) === checksum, 'STAGED_MIGRATION_HASH_MISMATCH');
    }
    must(JSON.stringify(readdirSync(join(stage, 'migrations')).filter(name => name !== 'migration_lock.toml').sort()) === JSON.stringify([...names].sort()), 'STAGED_MIGRATION_SET_MISMATCH');
    const require = createRequire(import.meta.url);
    const url = databaseUrl(request, credentials);
    const config = join(stage, 'prisma.config.ts');
    writeFileSync(config, `import {defineConfig} from ${JSON.stringify(require.resolve('prisma/config'))}; export default defineConfig(${JSON.stringify({ schema: join(stage, 'schema.prisma'), migrations: { path: join(stage, 'migrations') }, engine: 'classic', datasource: { url } })});`, { mode: 0o600 });
    const cli = join(dirname(require.resolve('prisma/config')), 'build/index.js');
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, DATABASE_URL: url };
    const run = args => spawnSync(process.execPath, [cli, ...args, '--config', config], { cwd: stage, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60 * 1000 });
    const validated = run(['validate']);
    if (validated.status !== 0) return { status: validated.status ?? 1, output: `${validated.stdout}${validated.stderr}` };
    const deployed = run(['migrate', 'deploy']);
    return { status: deployed.status ?? 1, output: `${deployed.stdout}${deployed.stderr}` };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

const dockerJson = args => JSON.parse(execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
function pgControlIdentifier(container) {
  const out = execFileSync('docker', ['exec', container, 'sh', '-c', 'LC_ALL=C pg_controldata "$PGDATA"'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out.match(/^Database system identifier:\s+(\d+)/m)?.[1] ?? null;
}
/** Independent identity proof (a path different from the TCP connection): the container is the pinned one, is running, publishes the bound port on loopback/the bound host, and its own control file reports the expected system identifier. */
function verifySharedDevTarget(request) {
  const out = {};
  const check = (pin, internalPort, hostPort, label) => {
    const info = dockerJson(['inspect', pin.container])[0];
    must(info.Id === pin.id && info.State.Running, 'CONTAINER_IDENTITY_MISMATCH');
    const binds = info.NetworkSettings.Ports[`${internalPort}/tcp`];
    must(Array.isArray(binds) && binds.some(bind => String(bind.HostPort) === String(hostPort)), 'CONTAINER_BINDING_MISMATCH');
    out[label] = { container: pin.container, id: info.Id, image: info.Image, startedAt: info.State.StartedAt };
  };
  check(request.sharedDevPins.postgres, 5432, request.postgres.port, 'postgres');
  const control = pgControlIdentifier(request.sharedDevPins.postgres.container);
  must(control && control === request.postgres.expectedSystemIdentifier, 'SYSTEM_IDENTITY_MISMATCH');
  out.postgres.systemIdentifier = control;
  if (request.storage) { const port = new URL(request.storage.expectedEndpoint).port; check(request.sharedDevPins.minio, 9000, port, 'minio'); }
  return out;
}
/**
 * A COPY of the shared-dev data (Phase G-MIG-2). Same independent proof as shared-dev (the pinned container is running, publishes the bound port on loopback only, and its own
 * control file reports the expected system identifier) plus isolation proof: it belongs to the `devcopy` Compose project and every mount is a `devcopy_*` named volume, so no
 * container pinned here can be attached to the real data. The shared-dev system identifier is refused separately (assertDatabaseTarget).
 */
function verifyCopyTarget(request) {
  const out = {};
  const check = (pin, internalPort, hostPort, label) => {
    const info = dockerJson(['inspect', pin.container])[0];
    must(info.Id === pin.id && info.State.Running, 'CONTAINER_IDENTITY_MISMATCH');
    must(info.Config?.Labels?.['com.docker.compose.project'] === 'devcopy', 'COPY_PROJECT_MISMATCH');
    const mounts = info.Mounts ?? [];
    must(mounts.length >= 1 && mounts.every(mount => mount.Type === 'volume' && /^devcopy_[a-z0-9-]+$/.test(mount.Name ?? '')), 'COPY_VOLUME_NOT_ISOLATED');
    const binds = info.NetworkSettings.Ports[`${internalPort}/tcp`];
    must(Array.isArray(binds) && binds.length > 0 && binds.every(bind => bind.HostIp === '127.0.0.1') && binds.some(bind => String(bind.HostPort) === String(hostPort)), 'CONTAINER_BINDING_MISMATCH');
    out[label] = { container: pin.container, id: info.Id, image: info.Image, startedAt: info.State.StartedAt, volumes: mounts.map(mount => mount.Name) };
  };
  check(request.copyPins.postgres, 5432, request.postgres.port, 'postgres');
  const control = pgControlIdentifier(request.copyPins.postgres.container);
  must(control && control === request.postgres.expectedSystemIdentifier, 'SYSTEM_IDENTITY_MISMATCH');
  out.postgres.systemIdentifier = control;
  if (request.storage) { const port = new URL(request.storage.expectedEndpoint).port; check(request.copyPins.minio, 9000, port, 'minio'); }
  return out;
}
async function verifyDisposableTarget(request) {
  // Reuses the committed G1 identity checks: container id/labels, loopback-only binding, system identifier != the application's.
  const guard = await import('./guard.mjs');
  const { postgres: pg, minio } = request.disposablePins;
  guard.containerIdentity(pg, 'postgres'); guard.controlIdentity(pg);
  if (request.storage) guard.containerIdentity(minio, 'minio');
  must(pg.systemIdentifier === request.postgres.expectedSystemIdentifier, 'SYSTEM_IDENTITY_MISMATCH');
  return { postgres: { container: pg.name, id: pg.id, systemIdentifier: pg.systemIdentifier }, ...(request.storage ? { minio: { container: minio.name, id: minio.id } } : {}) };
}

function realDeps() {
  return {
    root: ROOT, now: () => Date.now(), sharedDevEnabled: SHARED_DEV_ENABLED, computeImplementation: () => computeImplementation(ROOT),
    loadCredentials: request => loadCredentials(request, ROOT), probeDatabase: (request, credentials, options) => probeDatabase(request, credentials, ROOT, options), spawnChild,
    runMigration: (request, credentials) => runMigration(request, credentials, ROOT), evidenceRoots: () => resolveEvidenceRoots(ROOT),
    verifyTarget: request => (request.targetKind === 'disposable' ? verifyDisposableTarget(request) : request.targetKind === 'copy' ? verifyCopyTarget(request) : verifySharedDevTarget(request)),
  };
}
const intendedEvidencePath = path => join(realpathSync(dirname(path)), basename(path));

/** Returns { exitCode, code, evidenceDir?, receipt? }. Never throws; never prints a secret. */
export async function runLauncher(argv, env, deps = realDeps()) {
  let evidence = null;
  const written = [];
  try {
    must(argv.length === 2 && OPERATIONS.includes(argv[0]), 'USAGE_OPERATION_AND_REQUEST_ONLY');
    assertNoAmbientTargets(env);
    const requestPath = realpathSync(resolve(argv[1]));
    assertPrivateFile(requestPath, 'REQUEST_FILE_NOT_PRIVATE');
    const requestBytes = readFileSync(requestPath);
    const request = validateRequest(JSON.parse(requestBytes.toString('utf8')), deps.now());
    must(request.operation === argv[0], 'REQUEST_OPERATION_MISMATCH');
    const profile = profileFor(request.operation, request.postgres.expectedHistory.length);
    const credentials = deps.loadCredentials(request);
    const dbUrl = databaseUrl(request, credentials);
    const secrets = [credentials.postgresPassword, credentials.storageAccessKey, credentials.storageSecretKey, dbUrl, encodeURIComponent(credentials.postgresPassword)];
    const implementation = await deps.computeImplementation();

    // 1. who is allowed to run at all: the capability must be enabled AND this exact run must be authorized (nothing is probed before that)
    let authorization = null;
    if (request.targetKind === 'shared-dev') {
      must(deps.sharedDevEnabled === true, 'SHARED_DEV_EXECUTION_NOT_ENABLED');
      const authPath = realpathSync(resolve(request.authorization.path));
      assertPrivateFile(authPath, 'AUTHORIZATION_FILE_NOT_PRIVATE');
      const authBytes = readFileSync(authPath);
      must(sha256(authBytes) === request.authorization.sha256, 'AUTHORIZATION_HASH_MISMATCH');
      authorization = validateAuthorizationStatic(JSON.parse(authBytes.toString('utf8')), request, implementation, intendedEvidencePath(request.evidenceDir), deps.now());
    }

    // 2. exactly the reviewed code and chain
    assertImplementationMatches(request.implementation, implementation);

    // 3. exact database target, proven twice by independent paths (TCP identity vs the container's own control file)
    const containers = await deps.verifyTarget(request);
    const dbObserved = deps.probeDatabase(request, credentials, { withTables: isMigration(request.operation) });
    assertDatabaseTarget(request, dbObserved);
    must(containers.postgres.systemIdentifier === dbObserved.systemIdentifier, 'SYSTEM_IDENTITY_MISMATCH');
    assertHistory(request.postgres.expectedHistory, dbObserved.history, profile.history);
    assertSchemaObserved(request, dbObserved);
    must(dbObserved.systemIdentifier === APPLICATION_SYSTEM ? request.targetKind === 'shared-dev' : request.targetKind === 'disposable' || request.targetKind === 'copy', 'TARGET_KIND_SYSTEM_MISMATCH');

    // 4. exact storage target (identity probe is the child's adapter, so there is a single implementation)
    let storageObserved = null;
    if (profile.storage) {
      const probe = deps.spawnChild(childSpec(request, credentials, ROOT, 'identity'));
      must(probe.status === 0, /STORAGE_UNAVAILABLE/.test(probe.stderr) ? 'STORAGE_UNAVAILABLE' : 'STORAGE_IDENTITY_PROBE_FAILED');
      storageObserved = JSON.parse(probe.stdout.trim().split('\n').at(-1));
      assertStorageTarget(request, storageObserved);
      must(storageObserved.configFingerprint === storageConfigFingerprint(request, credentials), 'STORAGE_FINGERPRINT_MISMATCH');
    }
    if (authorization) validateAuthorizationObserved(authorization, { ...dbObserved, storage: storageObserved });

    // 5. approval inputs (apply only): pinned bytes, private files, the approved manifest names this observed manifest
    const manifestEnv = {};
    if (profile.manifests) {
      const bytes = {};
      for (const [label, path, pin] of [['observed', request.manifests.observedPath, request.manifests.observedSha256], ['approved', request.manifests.approvedPath, request.manifests.approvedSha256]]) {
        const real = realpathSync(resolve(path)); assertPrivateFile(real, 'MANIFEST_FILE_NOT_PRIVATE');
        bytes[label] = readFileSync(real); must(sha256(bytes[label]) === pin, 'MANIFEST_FILE_HASH_MISMATCH');
        manifestEnv[label] = real;
      }
      const observedJson = JSON.parse(bytes.observed.toString('utf8')), approvedJson = JSON.parse(bytes.approved.toString('utf8'));
      must(approvedJson.observedManifestSha256 === observedJson.manifestSha256, 'APPROVED_OBSERVED_MISMATCH');
      must(observedJson.policy?.expectedBucket === request.storage.expectedBucket, 'MANIFEST_BUCKET_MISMATCH');
    }

    // 6. evidence directory, then the immutable binding
    const evidenceIdentity = prepareEvidenceDir(request.evidenceDir, deps.evidenceRoots());
    evidence = evidenceIdentity.realpath;
    const binding = buildBinding({ request, requestSha256: sha256(requestBytes), implementation, dbObserved, storageObserved, containers, evidence: evidenceIdentity, now: deps.now() });
    const bindingText = JSON.stringify(binding, null, 2) + '\n';
    must(!containsSecret(bindingText, secrets), 'SECRET_IN_EVIDENCE');
    const bindingSha256 = writeImmutable(evidence, 'binding.json', bindingText); written.push('binding.json');

    // 7. second verification immediately before the run, then the run
    assertImplementationMatches(request.implementation, await deps.computeImplementation());
    const startedAt = new Date(deps.now()).toISOString();
    let status, exitCode, outputName = null, outputBytes = null, outputJson = null, childFailureCode = null, counts = null, postState = null;

    if (isMigration(request.operation)) {
      const migration = deps.runMigration(request, credentials);
      const logText = String(migration.output).split(dbUrl).join('[REDACTED]');
      outputName = 'migration-output.log';
      writeImmutable(evidence, outputName, `${secrets.reduce((text, secret) => (secret ? text.split(secret).join('[REDACTED]') : text), logText)}\n`); written.push(outputName);
      exitCode = migration.status === 0 ? 0 : 1;
      let verification = { partial: migration.status !== 0 };
      try {
        const after = deps.probeDatabase(request, credentials, { withTables: true });
        const step = profile.step;
        const before = dbObserved;
        const expectedAfterHistory = [...before.history, { name: step.name, checksum: step.checksum, finished: true, rolledBack: false }];
        verification = {
          partial: migration.status !== 0, historyMatchesExpected: JSON.stringify(after.history) === JSON.stringify(expectedAfterHistory),
          before: { historySha256: historyDigest(before.history), schemaManifestSha256: before.schemaManifestSha256, schemaEntries: before.schemaEntries },
          after: { migrationCount: after.history.length, historySha256: historyDigest(after.history), schemaManifestSha256: after.schemaManifestSha256, schemaEntries: after.schemaEntries, datasets: after.datasets },
        };
        if (migration.status === 0) {
          assertHistory(expectedAfterHistory.map(row => ({ name: row.name, checksum: row.checksum })), after.history, profile.after.history);
          must(after.schemaEntries === profile.after.entries, 'MIGRATION_SCHEMA_DELTA_UNEXPECTED');
          verification.delta = assertMigrationDelta(request.operation, before.manifestRows, after.manifestRows);
          const isM26 = step === FROZEN_M26;
          verification.tables = assertTablesUnchanged(before.tables, after.tables, isM26 ? FROZEN_M26.newTables : []);
          // M24/M25 run on a database with no resolved Dataset; M26 may run after a backfill, and then it must leave every Dataset exactly as it was
          must(isM26 ? JSON.stringify(after.datasets) === JSON.stringify(before.datasets) : after.datasets.total === before.datasets.total && after.datasets.resolved === 0 && after.datasets.unresolved === after.datasets.total, 'MIGRATION_DATASETS_RESOLVED');
          postState = { migrationCount: after.history.length, historySha256: verification.after.historySha256, schemaManifestSha256: after.schemaManifestSha256, schemaEntries: after.schemaEntries };
        }
      } catch (error) { verification.verificationFailure = code(error); exitCode = 1; }
      if (exitCode === 0 && !postState) exitCode = 1;
      const verificationText = JSON.stringify(verification, null, 2) + '\n';
      must(!containsSecret(verificationText, secrets), 'SECRET_IN_EVIDENCE');
      writeImmutable(evidence, 'verification.json', verificationText); written.push('verification.json');
      outputBytes = verificationText; outputJson = verification; outputName = 'verification.json';
      status = exitCode === 0 ? 'COMPLETED' : 'FAILED';
      childFailureCode = exitCode === 0 ? null : (verification.verificationFailure ?? 'MIGRATION_FAILED');
    } else {
      const spec = childSpec(request, credentials, evidence, request.operation, request.operation === 'apply' ? {
        BACKFILL_OBSERVED_PATH: manifestEnv.observed, BACKFILL_OBSERVED_SHA256: request.manifests.observedSha256, BACKFILL_APPROVED_PATH: manifestEnv.approved, BACKFILL_APPROVED_SHA256: request.manifests.approvedSha256,
      } : {});
      const child = deps.spawnChild(spec);
      outputName = request.operation === 'observe' ? 'observed-manifest.json' : 'result.json';
      const outputPath = join(evidence, outputName);
      assertImplementationMatches(request.implementation, await deps.computeImplementation()); // the code must not have changed while it ran
      outputBytes = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : null;
      if (outputBytes) { written.push(outputName); must(!containsSecret(outputBytes, secrets), 'SECRET_IN_EVIDENCE'); }
      must(!containsSecret(child.stdout + child.stderr, secrets), 'SECRET_IN_CHILD_OUTPUT');
      status = child.status === 0 ? 'COMPLETED' : child.status === 3 ? 'STOPPED' : 'FAILED';
      exitCode = child.status === 0 ? 0 : child.status === 3 ? 3 : 1;
      outputJson = outputBytes ? JSON.parse(outputBytes) : null;
      childFailureCode = child.status !== 0 && child.status !== 3 ? (child.stderr.match(/BACKFILL_RUN_FAILED ([A-Z0-9_]+)/)?.[1] ?? 'CHILD_FAILED') : null;
      counts = request.operation === 'apply' && outputJson ? outputJson.run.counts : request.operation === 'observe' && outputJson ? { candidates: outputJson.candidates.length, rejected: outputJson.rejected.length } : null;
    }
    assertImplementationMatches(request.implementation, await deps.computeImplementation());

    const receipt = {
      schema: RECEIPT_SCHEMA, operation: request.operation, targetKind: request.targetKind, status, exitCode, startedAt, finishedAt: new Date(deps.now()).toISOString(),
      runToken: request.runToken, resolverSubject: binding.resolverSubject, requestSha256: sha256(requestBytes), implementationSha256: binding.implementationSha256,
      authorizationSha256: authorization ? request.authorization.sha256 : null,
      binding: { file: 'binding.json', sha256: bindingSha256 },
      output: outputBytes ? { file: outputName, sha256: sha256(outputBytes) } : null,
      approvedLineage: request.operation === 'apply' && outputJson ? outputJson.lineage : null,
      counts, postState, implementationStable: true, childFailureCode,
    };
    const receiptText = JSON.stringify(receipt, null, 2) + '\n';
    must(!containsSecret(receiptText, secrets), 'SECRET_IN_EVIDENCE');
    writeImmutable(evidence, 'receipt.json', receiptText); written.push('receipt.json');
    return { exitCode, code: status, evidenceDir: evidence, receipt };
  } catch (error) {
    // A secret-bearing file must not stay behind: remove only what this run wrote.
    if (evidence && /SECRET_IN/.test(code(error))) for (const name of written) rmSync(join(evidence, name), { force: true });
    return { exitCode: 1, code: code(error), evidenceDir: evidence && existsSync(evidence) && readdirSync(evidence).length ? evidence : null };
  }
}

if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) {
  const result = await runLauncher(process.argv.slice(2), process.env);
  if (result.exitCode === 0 || result.exitCode === 3) console.log(JSON.stringify({ ok: result.exitCode === 0, status: result.code, evidenceDir: result.evidenceDir, counts: result.receipt?.counts ?? null, postState: result.receipt?.postState ?? null }));
  else console.error('SAFETY_ABORT', result.code);
  process.exitCode = result.exitCode;
}
void FROZEN_MIGRATIONS;
