// Focused, receipt-bound disposable test runner (Phase029).
//
// Runs ONE named, allowlisted DB-backed test command against fresh disposable
// PostgreSQL/Redis/MinIO containers that have the 23 historical migrations and the
// promoted Phase029 migrations 24 and 25 (the canonical 25-migration active chain) applied, then removes exactly the
// resources it created and runs the independent cleanup verifier.
//
// CLI: node scripts/db-safety/disposable-test.mjs <name>
//   <name> is EITHER an entry of SUPPORTED_COMMANDS (a kind:"test" entry of commands.json) OR a fixed rehearsal id
//   from REHEARSALS (e.g. rehearse:prepared-import-creation-request-hash, a migration-only rehearsal of a frozen proposal).
//   No other argument, no shell string, no URL and no receipt is ever accepted from the caller:
//   every authority (target URL, receipt, providers) is created inside this run.
//
// Receipt architecture note (rehearsal fixture): cli.mjs/entry-check.mjs resolve every `test` receipt through a commands.json
// entry, so the rehearsal's internal fixture step technically needs a catalog entry (FIXTURE_COMMAND). That entry is
// rehearsal-only: it is not in SUPPORTED_COMMANDS (the CLI rejects it), it carries `rehearsalOnly`, and the plan refuses to run
// unless the catalog entry is byte-for-byte structurally equal to FIXTURE_SPEC (no substituted path or added argument).
//
// Everything that authorizes execution is reused from the committed G1 tooling
// (guard.mjs identity checks, approve-disposable.mjs receipts, cli.mjs launcher,
// cleanup-verify.mjs). This file only provisions, sequences and cleans up.
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { basename, join, resolve, sep } from 'node:path';
import * as guard from './guard.mjs';
import { computeImplementation as maintenanceImplementation, manifestDigest as maintenanceManifestDigest } from './backfill-binding.mjs';
import { runMaintenanceRehearsal } from './backfill-maintenance-rehearsal.mjs';
import { readTree as readClientTree, treeHash as clientTreeHash } from './prisma-client-stage.mjs';

export const SUPPORTED_COMMANDS = ['web:test:dataset-metadata', 'web:test:dataset-patch-route', 'web:test:local-folder-modality-idempotency', 'web:test:imports-ui:vitest', 'worker:test:ingestion-replay-reuse', 'web:test:upload-verification-boundary', 'web:test:ai-batch-targets', 'web:test:dataset-ref-contract', 'web:test:ai-model-catalog', 'worker:test:ai-canonical-endpoint'];
const PROMOTED = 'prisma/migrations';
/**
 * Ordered, frozen Phase029 chain applied AFTER the 23 historical migrations. Since the release-chain promotion these two
 * migrations live in the canonical active chain (prisma/migrations, 25 in total); the runner stages the 23 historical ones
 * first and applies these in order so the fixture can run between 24 and 25.
 * Every entry binds identity, source path, exact bytes and order; nothing outside this list is ever staged.
 * Migration 24's checksum is accepted for verification continuity (provenance exception recorded in verification/t008-provenance-exception.md).
 */
export const PROPOSAL_CHAIN = [
  { order: 1, name: '20260930030000_dataset_modality_g2', path: `${PROMOTED}/20260930030000_dataset_modality_g2`, sha256: '13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7' },
  { order: 2, name: '20261006000000_prepared_import_creation_request_hash', path: `${PROMOTED}/20261006000000_prepared_import_creation_request_hash`, sha256: 'a8ffbc84bde7f18aac93bbb2e87423e6cfcbf6efd95c01e6650824fdcc3ed859' },
];
export const BASELINE_MIGRATIONS = 23;
export const REHEARSAL_ID = 'rehearse:prepared-import-creation-request-hash';
export const FIXTURE_COMMAND = 'rehearsal-fixture:prepared-import-creation-request-hash';
export const FIXTURE_FILE = 'apps/web/tests/prepared-import-rehearsal/seed-prepared-imports.test.ts';
export const FIXTURE_SPEC = {
  kind: 'test', cwd: 'apps/web',
  args: ['--require', './tests/auth-ownership/register-server-only.cjs', '--import', 'tsx', '--test', '--test-concurrency=1', 'tests/prepared-import-rehearsal/seed-prepared-imports.test.ts'],
  rehearsalOnly: REHEARSAL_ID,
};
export const FIXTURE_ROWS = 3;
export const COMPAT_ID = 'compat:prepared-import-creation-request-hash';
export const COMPAT_COMMAND = 'compat-test:prepared-import-creation-request-hash';
export const COMPAT_FILE = 'apps/web/tests/prepared-import-compat/client-compat.test.ts';
export const COMPAT_SPEC = {
  kind: 'test', cwd: 'apps/web',
  args: ['--require', './tests/auth-ownership/register-server-only.cjs', '--import', 'tsx', '--test', '--test-concurrency=1', 'tests/prepared-import-compat/client-compat.test.ts'],
  compatOnly: COMPAT_ID,
};
/** Frozen inputs of the compatibility plan: the accepted canonical schema, the complete tracked generated client, and the active migration chain. */
export const COMPAT_BINDINGS = Object.freeze({
  schemaSha256: '4fe3d96a334e18e504ea14fd5519a1a363fae5ea6d9845355c9d548698eed174',
  generatedTreeSha256: 'a750e6b900e00991e818b660f7af67866d1c8ea2ec7774ff2f92f0b40fb54a52',
  generatedFiles: Object.freeze({
    'lib/generated/prisma/internal/class.ts': 'f194d490baba32627a971828abadbcdecb904b0a96ce1e1ca73824019614ec11',
    'lib/generated/prisma/internal/prismaNamespace.ts': '059962520fae3aa7dbabf3f704e278e0d832c8307101fa8d5f02fa147406866b',
    'lib/generated/prisma/internal/prismaNamespaceBrowser.ts': '247578b6c493d6fd8a69ff0f55d6beb2a3b943c62091ff1f9459671195f95a47',
    'lib/generated/prisma/models/PreparedImport.ts': 'd48ac861e7e8d6020d614a6faf706f9f4a146447c0599faabe798a02251af45d',
    'lib/generated/prisma/libquery_engine-debian-openssl-3.0.x.so.node': 'a2924eab1c78a0a7bb67edac5738939fa10589ef073af5542f53812a22e4a7d8',
  }),
  activeChainTreeSha256: 'f0da8710b3c874f842de6b686ae5b025dffd59f8acdab74a6e1c00faadb54ca8',
});
export const T015_ID = 'verify:confirmed-taxonomy-creation';
export const T015_COMMAND = 'verify-test:confirmed-taxonomy-creation';
export const T015_FILE = 'apps/web/tests/confirmed-taxonomy/creation-paths.test.ts';
export const T015_SPEC = {
  kind: 'test', cwd: 'apps/web',
  args: ['--require', './tests/auth-ownership/register-server-only.cjs', '--import', 'tsx', '--test', '--test-concurrency=1', 'tests/confirmed-taxonomy/creation-paths.test.ts'],
  verifyOnly: T015_ID,
};
export const INGEST_ID = 'verify:ingestion-replay-summary';
export const INGEST_COMMAND = 'verify-test:ingestion-replay-summary';
export const INGEST_FILE = 'apps/web/tests/dataset-modality/ingestion-replay-summary.test.ts';
export const INGEST_SPEC = {
  kind: 'test', cwd: 'apps/web',
  args: ['--require', './tests/auth-ownership/register-server-only.cjs', '--import', 'tsx', '--test', '--test-concurrency=1', 'tests/dataset-modality/ingestion-replay-summary.test.ts'],
  verifyOnly: INGEST_ID,
};
const NEW_COLUMN = ['PreparedImport', 'creationRequestHash'];
/** Fixed verification plans over the ordered chain through migration 25. They share the frozen schema/client bindings and differ only in their one bound child test. */
export const COMPATIBILITY = Object.freeze({
  [COMPAT_ID]: Object.freeze({ through: 2, testCommand: COMPAT_COMMAND, spec: COMPAT_SPEC, file: COMPAT_FILE, scan: 'compat', stepName: 'compat-test', evidenceKind: 'prisma-client-compatibility', provenFlag: 'clientCompatibilityProven', newColumn: NEW_COLUMN, scope: 'prepared-import-creation-request-hash' }),
  [T015_ID]: Object.freeze({ through: 2, testCommand: T015_COMMAND, spec: T015_SPEC, file: T015_FILE, scan: 't015', stepName: 't015-test', evidenceKind: 'confirmed-taxonomy-verification', provenFlag: 't015DisposableVerified', newColumn: NEW_COLUMN, scope: 'confirmed-taxonomy-creation' }),
  // T019/T020 ingestion replay + commit summary. Needs migration 25 only because the tracked client selects PreparedImport.creationRequestHash on the commit-success write.
  [INGEST_ID]: Object.freeze({ through: 2, testCommand: INGEST_COMMAND, spec: INGEST_SPEC, file: INGEST_FILE, scan: 'ingest', stepName: 'ingest-test', evidenceKind: 'ingestion-replay-summary-verification', provenFlag: 'ingestionReplaySummaryDisposableVerified', newColumn: NEW_COLUMN, scope: 'ingestion-replay-summary' }),
});
/** Fixed plans. Not generalizable by the caller: through = how much of PROPOSAL_CHAIN is applied, fixtureAfter = chain order after which the fixture runs. */
export const REHEARSALS = Object.freeze({
  [REHEARSAL_ID]: Object.freeze({ through: 2, fixtureAfter: 1, fixtureCommand: FIXTURE_COMMAND, fixtureRows: FIXTURE_ROWS, newColumn: ['PreparedImport', 'creationRequestHash'], scope: 'proposal-migration-25' }),
});
// ---- Release-chain proof: the canonical 25-migration repository, from scratch, in one receipt-bound run ----
export const RELEASE_ID = 'release:phase029-chain';
/** Entry counts of the reviewed schema manifest (specs/proposals/phase029-modality/recovery.v2.review.sql) after the 23 historical migrations, migration 24 and migration 25. */
export const RELEASE_COUNTS = Object.freeze({ baseline: 1829, m24: 1841, m25: 1842 });
/** The reviewed read-only manifest CTE is the definition of "schema entry"; its bytes are pinned so the counts cannot drift with the definition. */
export const RECOVERY_REVIEW = Object.freeze({ path: 'specs/proposals/phase029-modality/recovery.v2.review.sql', sha256: '3bb6389f380ffaa5c3be88d26d56782065a00b3844f0326ccba1c05ee4b5a1db' });
export const G2_ARGS = ['--require', './tests/auth-ownership/register-server-only.cjs', '--import', 'tsx', '--test', '--test-concurrency=1'];
/** Existing, already reviewed G2 catalog commands reused as release-chain steps. Each must be structurally identical to its pinned spec (no substituted path or added argument). */
export const RELEASE_SPECS = Object.freeze({
  'g2:generate': Object.freeze({ kind: 'test', cwd: '.', args: ['scripts/db-safety/g2-generate.mjs'] }),
  'g2:baseline': Object.freeze({ kind: 'test', cwd: 'apps/web', args: [...G2_ARGS, 'tests/dataset-modality/g2-baseline.test.ts'] }),
  'g2:compatibility': Object.freeze({ kind: 'test', cwd: '.', args: ['scripts/db-safety/g2-compatibility.mjs'] }),
  'g2:candidate': Object.freeze({ kind: 'test', cwd: 'apps/web', args: [...G2_ARGS, 'tests/dataset-modality/g2-candidate.test.ts'] }),
});
export const RELEASES = Object.freeze({
  [RELEASE_ID]: Object.freeze({ through: 2, fixtureAfter: 1, fixtureCommand: FIXTURE_COMMAND, fixtureRows: FIXTURE_ROWS, newColumn: NEW_COLUMN, scope: 'release-chain-25', compatCommand: COMPAT_COMMAND, compatFile: COMPAT_FILE, compatSpec: COMPAT_SPEC }),
});
export const RELEASE_TOPOLOGY = Object.freeze([
  ['baseline-deploy', 'deploy', null], ['generate', 'test', 'g2:generate'], ['baseline-seed', 'test', 'g2:baseline'], ['proposal-1-deploy', 'deploy', null],
  ['fixture', 'test', FIXTURE_COMMAND], ['proposal-2-deploy', 'deploy', null], ['schema-compat', 'test', 'g2:compatibility'], ['client-compat', 'test', COMPAT_COMMAND], ['candidate-contracts', 'test', 'g2:candidate'],
]);
// ---- T029/T031 backfill rehearsal: the canonical 25-migration chain plus the evidence-bound SINGLE-modality backfill, on disposable PostgreSQL only ----
export const BACKFILL_ID = 'release:phase029-backfill';
export const BACKFILL_SEED_COMMAND = 'backfill-seed:dataset-modality';
export const BACKFILL_VERIFY_COMMAND = 'verify-test:dataset-modality-backfill';
export const BACKFILL_SEED_FILE = 'apps/web/tests/dataset-modality/backfill-baseline.test.ts';
export const BACKFILL_VERIFY_FILE = 'apps/web/tests/dataset-modality/backfill-rehearsal.test.ts';
export const BACKFILL_SEED_SPEC = Object.freeze({ kind: 'test', cwd: 'apps/web', args: [...G2_ARGS, 'tests/dataset-modality/backfill-baseline.test.ts'], backfillOnly: BACKFILL_ID });
export const BACKFILL_VERIFY_SPEC = Object.freeze({ kind: 'test', cwd: 'apps/web', args: [...G2_ARGS, 'tests/dataset-modality/backfill-rehearsal.test.ts'], backfillOnly: BACKFILL_ID });
export const BACKFILLS = Object.freeze({
  [BACKFILL_ID]: Object.freeze({ through: 2, newColumn: NEW_COLUMN, scope: 'release-chain-backfill-rehearsal' }),
});
export const BACKFILL_TOPOLOGY = Object.freeze([
  ['baseline-deploy', 'deploy', null], ['generate', 'test', 'g2:generate'], ['baseline-seed', 'test', BACKFILL_SEED_COMMAND], ['proposal-1-deploy', 'deploy', null],
  ['proposal-2-deploy', 'deploy', null], ['backfill-verify', 'test', BACKFILL_VERIFY_COMMAND], ['schema-compat', 'test', 'g2:compatibility'],
]);
// ---- Maintenance launcher rehearsal: T029/T031 through the receipt-bound launcher against REAL PostgreSQL and REAL MinIO (disposable only) ----
export const MAINTENANCE_ID = 'release:phase029-backfill-maintenance';
export const MAINT_SEED_COMMAND = 'maintenance-seed:dataset-modality';
export const MAINT_OBJECTS_COMMAND = 'maintenance-objects:dataset-modality';
export const MAINT_CHECK_COMMAND = 'maintenance-check:dataset-modality';
const maintenanceSpec = file => Object.freeze({ kind: 'test', cwd: 'apps/web', args: [...G2_ARGS, `tests/dataset-modality/${file}`], maintenanceOnly: MAINTENANCE_ID });
export const MAINT_SEED_SPEC = maintenanceSpec('maintenance-baseline.test.ts');
export const MAINT_OBJECTS_SPEC = maintenanceSpec('maintenance-objects.test.ts');
export const MAINT_CHECK_SPEC = maintenanceSpec('maintenance-check.test.ts');
export const MAINTENANCE_FILES = Object.freeze(['apps/web/tests/dataset-modality/maintenance-baseline.test.ts', 'apps/web/tests/dataset-modality/maintenance-objects.test.ts', 'apps/web/tests/dataset-modality/maintenance-check.test.ts', 'apps/web/tests/dataset-modality/maintenance-fixture.ts', 'scripts/db-safety/backfill-launcher.mjs', 'scripts/db-safety/backfill-binding.mjs', 'scripts/db-safety/maintenance-fence.cjs', 'scripts/db-safety/backfill-maintenance-rehearsal.mjs', 'apps/web/scripts/backfill-run.ts', 'apps/web/scripts/backfill-approve.ts', 'apps/web/src/lib/datasets/modality-backfill-storage.ts']);
export const MAINTENANCE = Object.freeze({ [MAINTENANCE_ID]: Object.freeze({ through: 2, newColumn: NEW_COLUMN, scope: 'release-chain-maintenance-launcher-real-storage' }) });
/** Commands of the receipt topology, in order: the five chain steps, then the rehearsal's fixed child steps (names carry a counter), then the drift check. */
export const MAINTENANCE_COMMANDS = Object.freeze([null, 'g2:generate', MAINT_SEED_COMMAND, null, null, MAINT_CHECK_COMMAND, MAINT_CHECK_COMMAND, MAINT_CHECK_COMMAND, MAINT_OBJECTS_COMMAND,
  MAINT_CHECK_COMMAND, MAINT_OBJECTS_COMMAND, MAINT_CHECK_COMMAND, MAINT_OBJECTS_COMMAND, MAINT_CHECK_COMMAND, MAINT_OBJECTS_COMMAND, MAINT_CHECK_COMMAND, 'g2:compatibility']);
export const PORT_RANGE = [55460, 55479];
const COMMAND_SHAPE = /^[a-z0-9]+(?::[a-z0-9-]+)+$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[a-f0-9-]{36}$/;

export const fail = code => { throw Error(code); };
const must = (value, code) => { if (!value) fail(code); };
const safe = error => (/^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'FOCUSED_RUN_FAILED');

/** Pure, runs before anything is created. */
export function validateCommand(name, catalog) {
  must(typeof name === 'string' && name.length <= 80 && COMMAND_SHAPE.test(name), 'COMMAND_NAME_INVALID');
  if (Object.hasOwn(REHEARSALS, name) || Object.hasOwn(COMPATIBILITY, name) || Object.hasOwn(RELEASES, name) || Object.hasOwn(BACKFILLS, name) || Object.hasOwn(MAINTENANCE, name)) return name; // fixed plans; their child commands are bound in preflight, never selectable here
  must(SUPPORTED_COMMANDS.includes(name), 'COMMAND_NOT_SUPPORTED');
  must(catalog?.[name]?.kind === 'test', 'COMMAND_NOT_ALLOWLISTED');
  return name;
}

function treeHash(root, rel) {
  const base = join(root, rel);
  if (!existsSync(base)) return null;
  const files = guard.walk(base).sort();
  return sha(files.map(file => file.slice(base.length) + ':' + sha(readFileSync(file))).join('\n'));
}

/** Resolves a validated name to its plan. Test plans stay migration-24-only. */
export function resolvePlan(name) {
  if (Object.hasOwn(REHEARSALS, name)) return { kind: 'rehearsal', id: name, ...REHEARSALS[name] };
  if (Object.hasOwn(COMPATIBILITY, name)) return { kind: 'compat', id: name, ...COMPATIBILITY[name] };
  if (Object.hasOwn(RELEASES, name)) return { kind: 'release', id: name, ...RELEASES[name] };
  if (Object.hasOwn(BACKFILLS, name)) return { kind: 'backfill', id: name, ...BACKFILLS[name] };
  if (Object.hasOwn(MAINTENANCE, name)) return { kind: 'maintenance', id: name, ...MAINTENANCE[name] };
  return { kind: 'test', id: name, through: 1 };
}

const activeNames = root => readdirSync(join(root, 'prisma/migrations'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
/** The 23 historical migrations: the active chain without the frozen Phase029 chain entries. */
const sortedBaseline = (root, chain = PROPOSAL_CHAIN) => activeNames(root).filter(name => !chain.some(entry => entry.name === name));
export const baselineRows = (root, chain = PROPOSAL_CHAIN) => sortedBaseline(root, chain).map(name => ({ name, sha256: sha(readFileSync(join(root, 'prisma/migrations', name, 'migration.sql'))) }));

/** Fails closed on a missing, renamed, reordered, extra-file or byte-modified proposal migration (only the slice a plan applies). */
export function validateChain(deps, through) {
  const chain = deps.pinned.chain;
  must(Array.isArray(chain) && Number.isInteger(through) && through >= 1 && through <= chain.length, 'PROPOSAL_MANIFEST_INVALID');
  const baseline = sortedBaseline(deps.root, chain);
  must(baseline.length === deps.pinned.baseline, 'BASELINE_MIGRATION_COUNT_MISMATCH');
  let previous = baseline.at(-1);
  for (let index = 0; index < through; index += 1) {
    const entry = chain[index];
    must(entry?.order === index + 1, 'PROPOSAL_ORDER_MISMATCH');
    must(typeof entry.name === 'string' && /^\d{14}_[a-z0-9_]+$/.test(entry.name) && basename(entry.path) === entry.name, 'PROPOSAL_NAME_MISMATCH');
    must(entry.name > previous && !baseline.includes(entry.name), 'PROPOSAL_NOT_AFTER_PREVIOUS');
    const dir = join(deps.root, entry.path);
    must(existsSync(dir) && JSON.stringify(readdirSync(dir)) === JSON.stringify(['migration.sql']), 'PROPOSAL_MISSING_OR_UNEXPECTED_FILES');
    must(sha(readFileSync(join(dir, 'migration.sql'))) === entry.sha256, 'PROPOSAL_CHECKSUM_MISMATCH');
    previous = entry.name;
  }
  return chain.slice(0, through);
}

// ---- Migration history (explicit identities and order, not a count) ----
export const HISTORY_SQL = `SELECT coalesce(jsonb_agg(jsonb_build_object('n',migration_name,'c',checksum,'f',finished_at IS NOT NULL,'r',rolled_back_at IS NOT NULL) ORDER BY started_at, migration_name),'[]'::jsonb) FROM _prisma_migrations;`;
export function checkHistory(rows, expected, stage) {
  const code = suffix => `${stage}_${suffix}`;
  must(Array.isArray(rows) && rows.length === expected.length && rows.every((row, index) => row.n === expected[index].name), code('HISTORY_MISMATCH'));
  must(rows.every(row => row.f === true && row.r === false), code('HISTORY_INCOMPLETE'));
  must(rows.every((row, index) => row.c === expected[index].sha256), code('HISTORY_CHECKSUM_MISMATCH'));
}

// ---- Read-only schema/data manifest ----
const jsonRows = (select, from, order) => `SELECT coalesce(jsonb_agg(${select} ORDER BY ${order}),'[]'::jsonb) FROM ${from};`;
export const TABLES_SQL = `SELECT coalesce(jsonb_agg(tablename ORDER BY tablename),'[]'::jsonb) FROM pg_tables WHERE schemaname='public';`;
export const MANIFEST_SQL = Object.freeze({
  columns: jsonRows('jsonb_build_array(table_name,column_name,data_type,is_nullable,column_default,ordinal_position)', `information_schema.columns WHERE table_schema='public'`, 'table_name, ordinal_position'),
  indexes: jsonRows('jsonb_build_array(tablename,indexname,indexdef)', `pg_indexes WHERE schemaname='public'`, 'tablename, indexname'),
  constraints: jsonRows('jsonb_build_array(conrelid::regclass::text,conname,contype::text,pg_get_constraintdef(oid))', `pg_constraint WHERE connamespace='public'::regnamespace`, 'conrelid::regclass::text, conname'),
  triggers: jsonRows('jsonb_build_array(tgrelid::regclass::text,tgname,pg_get_triggerdef(oid))', 'pg_trigger WHERE NOT tgisinternal', 'tgrelid::regclass::text, tgname'),
  routines: jsonRows('jsonb_build_array(proname,md5(pg_get_functiondef(oid)))', `pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f'`, 'proname, oid'),
  enums: jsonRows('jsonb_build_array(t.typname,e.enumlabel)', `pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typnamespace='public'::regnamespace`, 't.typname, e.enumsortorder'),
  preparedImport: jsonRows('to_jsonb(x)', 'public."PreparedImport" x', 'x.id'),
  migrations: jsonRows('to_jsonb(m)', '_prisma_migrations m', 'm.migration_name'),
});
const SAFE_TABLE = /^[A-Za-z][A-Za-z0-9_]*$/;
const NOT_FINGERPRINTED = ['_prisma_migrations', 'PreparedImport'];
export const tableFingerprintSql = table => {
  must(SAFE_TABLE.test(table), 'TABLE_NAME_UNSAFE');
  return `SELECT jsonb_build_array(count(*), md5(coalesce(string_agg(h,'' ORDER BY h),''))) FROM (SELECT md5(to_jsonb(x)::text) AS h FROM public."${table}" x) t;`;
};
/** One read-only transaction; every statement yields exactly one single-line jsonb value. */
export function captureScript(tables, extra = {}) {
  const fingerprinted = tables.filter(table => !NOT_FINGERPRINTED.includes(table));
  const all = { ...MANIFEST_SQL, ...extra };
  const keys = Object.keys(all);
  return { keys, fingerprinted, statements: [...keys.map(key => all[key]), ...fingerprinted.map(tableFingerprintSql)] };
}

// ---- Release-chain captures: the reviewed schema manifest and the Dataset modality state (read-only) ----
const MODALITY_KEYS = ['modality', 'modalityContentRevision', 'modalityResolvedAt', 'modalityResolverSubject'];
/** Extracts the reviewed read-only manifest CTE (the same extraction the G2/G3 rehearsals use) as one single-line statement. Fails closed on any structural change. */
export function extractManifestSql(text) {
  const start = text.indexOf('WITH objects AS (');
  const end = text.indexOf('IF EXISTS (\n  SELECT 1 FROM jsonb_array_elements(manifest)');
  must(start >= 0 && end > start, 'RECOVERY_REVIEW_MANIFEST_NOT_FOUND');
  const body = text.slice(start, end);
  must(body.split('expected_after').length > 1 && body.includes(' INTO manifest FROM objects;'), 'RECOVERY_REVIEW_MANIFEST_NOT_FOUND');
  const statement = body.replaceAll('expected_after', 'false').replace(' INTO manifest FROM objects;', ' FROM objects;').replace(/\s+/g, ' ').trim();
  must(!/--|\/\*/.test(statement), 'RECOVERY_REVIEW_MANIFEST_NOT_FOUND');
  return statement;
}
export const releaseManifestSqlFrom = file => {
  const bytes = readFileSync(file);
  must(sha(bytes) === RECOVERY_REVIEW.sha256, 'RECOVERY_REVIEW_DRIFT');
  return extractManifestSql(bytes.toString('utf8'));
};
export const releaseExtraSql = manifestSql => Object.freeze({
  schemaManifest: manifestSql,
  // Dataset rows without the Phase029 columns: identical before and after migration 24 unless a historical row changed.
  datasetLegacy: `SELECT jsonb_build_array(count(*), md5(coalesce(string_agg(h,'' ORDER BY h),''))) FROM (SELECT md5((to_jsonb(x) - ARRAY[${MODALITY_KEYS.map(key => `'${key}'`).join(',')}])::text) AS h FROM public."Dataset" x) t;`,
  datasetModality: `SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'m',to_jsonb(x)->'modality','r',to_jsonb(x)->'modalityContentRevision','t',to_jsonb(x)->'modalityResolvedAt','s',to_jsonb(x)->'modalityResolverSubject') ORDER BY x.id),'[]'::jsonb) FROM public."Dataset" x;`,
});
export function parseCapture(lines, script) {
  must(Array.isArray(lines) && lines.length === script.statements.length, 'CAPTURE_INCOMPLETE');
  const values = lines.map(line => { try { return JSON.parse(line); } catch { return fail('CAPTURE_UNPARSEABLE'); } });
  const out = {};
  script.keys.forEach((key, index) => { out[key] = values[index]; });
  out.tables = Object.fromEntries(script.fingerprinted.map((table, index) => [table, values[script.keys.length + index]]));
  return out;
}

const rowKey = row => JSON.stringify(row);
function setDiff(pre, post) {
  const before = new Set(pre.map(rowKey)), after = new Set(post.map(rowKey));
  return { added: post.filter(row => !before.has(rowKey(row))), removed: pre.filter(row => !after.has(rowKey(row))) };
}
/**
 * Proves migration 25 changed ONLY the approved column, added no index/uniqueness/FK/trigger, back-filled nothing,
 * and left PreparedImport rows (modulo the new NULL column), every other table and migration-24 objects untouched.
 */
export function assertMigration25(pre, post, ctx) {
  const evidence = [];
  const pass = (name, detail = {}) => evidence.push({ name, pass: true, ...detail });
  const [table, column] = ctx.newColumn;

  // history rows: first 24 byte-identical, exactly one new finished row with the frozen identity/checksum
  must(Array.isArray(pre.migrations) && Array.isArray(post.migrations) && post.migrations.length === pre.migrations.length + 1, 'M25_HISTORY_UNEXPECTED');
  must(isDeepStrictEqual(post.migrations.slice(0, pre.migrations.length), pre.migrations), 'M25_HISTORY_UNEXPECTED');
  const added = post.migrations.at(-1);
  must(added.migration_name === ctx.proposal.name && added.checksum === ctx.proposal.sha256 && added.finished_at && !added.rolled_back_at, 'M25_HISTORY_UNEXPECTED');
  pass('migration-history', { priorRows: pre.migrations.length, newMigration: added.migration_name });

  // schema: exactly one added column, nothing else anywhere
  const maxOrdinal = Math.max(0, ...pre.columns.filter(row => row[0] === table).map(row => row[5]));
  const columns = setDiff(pre.columns, post.columns);
  must(columns.removed.length === 0 && columns.added.length === 1 && rowKey(columns.added[0]) === rowKey([table, column, 'text', 'YES', null, maxOrdinal + 1]), 'M25_COLUMN_SHAPE_UNEXPECTED');
  pass('column', { added: columns.added[0] });
  for (const [key, code] of [['indexes', 'M25_INDEX_CHANGED'], ['constraints', 'M25_CONSTRAINT_CHANGED'], ['triggers', 'M25_TRIGGER_CHANGED'], ['routines', 'M25_ROUTINE_CHANGED'], ['enums', 'M25_ENUM_CHANGED']]) {
    const diff = setDiff(pre[key], post[key]);
    must(diff.added.length === 0 && diff.removed.length === 0, code);
    pass(`no-${key}-change`, { rows: pre[key].length });
  }

  // PreparedImport rows: count unchanged, old fields equal, new column NULL (no backfill)
  must(pre.preparedImport.length === ctx.fixtureRows, 'M25_FIXTURE_ROWS_MISSING');
  must((pre.tables.PreparedImportItem?.[0] ?? 0) > 0, 'M25_FIXTURE_ITEMS_MISSING');
  must(post.preparedImport.length === pre.preparedImport.length, 'M25_ROW_COUNT_CHANGED');
  must(pre.preparedImport.every(row => !(column in row)), 'M25_PRE_ALREADY_HAS_COLUMN');
  must(post.preparedImport.every(row => column in row && row[column] === null), 'M25_BACKFILL_DETECTED');
  const strip = row => { const copy = { ...row }; delete copy[column]; return copy; };
  must(isDeepStrictEqual(post.preparedImport.map(strip), pre.preparedImport), 'M25_PREPARED_IMPORT_ROWS_CHANGED');
  pass('prepared-import-rows', { rows: pre.preparedImport.length, newColumnNull: true });

  // every other table (including migration-24 data) unchanged
  must(isDeepStrictEqual(Object.keys(pre.tables), Object.keys(post.tables)) && isDeepStrictEqual(pre.tables, post.tables), 'M25_UNRELATED_DATA_CHANGED');
  pass('unrelated-tables', { tables: Object.keys(pre.tables).length });
  return evidence;
}

// ---- Release-chain assertions (pure; run on captures taken by the receipt-bound runner) ----
const manifestKey = row => `${row[0]}\u0000${row[1]}`;
/** Exact schema-entry diff between two manifest captures: added, removed and changed (same identity, different shape) entries. */
export function manifestDiff(pre, post) {
  must(Array.isArray(pre) && Array.isArray(post), 'RELEASE_MANIFEST_MISSING');
  const before = new Map(pre.map(row => [manifestKey(row), row])), after = new Map(post.map(row => [manifestKey(row), row]));
  must(before.size === pre.length && after.size === post.length, 'RELEASE_MANIFEST_DUPLICATE_IDENTITY');
  return {
    added: post.filter(row => !before.has(manifestKey(row))),
    removed: pre.filter(row => !after.has(manifestKey(row))),
    changed: post.filter(row => before.has(manifestKey(row)) && !isDeepStrictEqual(before.get(manifestKey(row))[2], row[2])),
  };
}
const PHASE029_COLUMNS = ['modality', 'modalityContentRevision', 'modalityResolvedAt', 'modalityResolverSubject'];
const PHASE029_CONSTRAINTS = ['dataset_modality_resolution_shape', 'dataset_modality_revision_nonnegative'];
const PHASE029_TRIGGERS = ['asset_modality_write_guard', 'dataset_modality_assignment_guard', 'dataset_modality_insert_guard'];
const PHASE029_ROUTINES = ['phase029_guard_asset_write()', 'phase029_guard_dataset_assignment()', 'phase029_guard_dataset_insert()'];
const unresolved = row => row.m === null && row.r === 0 && row.t === null && row.s === null;
/**
 * Migration 24 on the historical baseline: exactly 12 added schema entries (4 columns, 2 constraints, 3 triggers, 3 functions), nothing removed or changed,
 * no data change anywhere (Dataset compared without its new columns), one new finished history row with the frozen checksum, and every pre-existing Dataset unresolved.
 */
export function assertRelease24(pre, post, ctx) {
  const evidence = [];
  const pass = (name, detail = {}) => evidence.push({ name, pass: true, ...detail });
  must(pre.schemaManifest.length === RELEASE_COUNTS.baseline && post.schemaManifest.length === RELEASE_COUNTS.m24, 'RELEASE_M24_SCHEMA_COUNT_UNEXPECTED');
  const diff = manifestDiff(pre.schemaManifest, post.schemaManifest);
  must(diff.removed.length === 0 && diff.changed.length === 0 && diff.added.length === 12, 'RELEASE_M24_SCHEMA_DELTA_UNEXPECTED');
  const names = kind => diff.added.filter(row => row[0] === kind).map(row => JSON.parse(row[1]));
  const last = list => list.map(parts => parts.at(-1)).sort();
  const columns = names('column'), constraints = names('constraint'), triggers = names('trigger'), routines = names('routine');
  must(columns.length === 4 && columns.every(parts => parts[1] === 'Dataset') && isDeepStrictEqual(last(columns), [...PHASE029_COLUMNS].sort()), 'RELEASE_M24_COLUMNS_UNEXPECTED');
  must(constraints.length === 2 && isDeepStrictEqual(last(constraints), [...PHASE029_CONSTRAINTS].sort()), 'RELEASE_M24_CONSTRAINTS_UNEXPECTED');
  must(triggers.length === 3 && isDeepStrictEqual(last(triggers), [...PHASE029_TRIGGERS].sort()), 'RELEASE_M24_TRIGGERS_UNEXPECTED');
  must(routines.length === 3 && isDeepStrictEqual(routines.map(parts => parts[1].replace(/^public\./, '')).sort(), [...PHASE029_ROUTINES].sort()), 'RELEASE_M24_ROUTINES_UNEXPECTED');
  must(diff.added.length === columns.length + constraints.length + triggers.length + routines.length, 'RELEASE_M24_SCHEMA_DELTA_UNEXPECTED');
  pass('schema-delta', { from: pre.schemaManifest.length, to: post.schemaManifest.length, columns: 4, constraints: 2, triggers: 3, functions: 3, removed: 0, changed: 0 });

  must(Array.isArray(pre.migrations) && post.migrations.length === pre.migrations.length + 1 && isDeepStrictEqual(post.migrations.slice(0, pre.migrations.length), pre.migrations), 'RELEASE_M24_HISTORY_UNEXPECTED');
  const added = post.migrations.at(-1);
  must(added.migration_name === ctx.proposal.name && added.checksum === ctx.proposal.sha256 && added.finished_at && !added.rolled_back_at, 'RELEASE_M24_HISTORY_UNEXPECTED');
  pass('migration-history', { priorRows: pre.migrations.length, newMigration: added.migration_name });

  const others = Object.keys(pre.tables).filter(table => table !== 'Dataset');
  must(isDeepStrictEqual(Object.keys(pre.tables), Object.keys(post.tables)) && others.every(table => isDeepStrictEqual(pre.tables[table], post.tables[table])), 'RELEASE_M24_DATA_CHANGED');
  must(isDeepStrictEqual(pre.datasetLegacy, post.datasetLegacy) && pre.datasetLegacy[0] > 0, 'RELEASE_M24_DATASET_CHANGED');
  must(isDeepStrictEqual(pre.preparedImport, post.preparedImport), 'RELEASE_M24_DATA_CHANGED');
  pass('no-data-change', { tables: others.length, datasetRows: pre.datasetLegacy[0] });

  must(post.datasetModality.length === pre.datasetLegacy[0] && post.datasetModality.every(unresolved), 'RELEASE_M24_DATASET_NOT_UNRESOLVED');
  pass('historical-datasets-unresolved', { rows: post.datasetModality.length });
  return evidence;
}
/** Migration 25 on top: exactly one added schema entry (the nullable column), nothing else; every Dataset row identical before and after. */
export function assertRelease25(pre, post, ctx) {
  const evidence = [];
  const pass = (name, detail = {}) => evidence.push({ name, pass: true, ...detail });
  must(pre.schemaManifest.length === RELEASE_COUNTS.m24 && post.schemaManifest.length === RELEASE_COUNTS.m25, 'RELEASE_M25_SCHEMA_COUNT_UNEXPECTED');
  const diff = manifestDiff(pre.schemaManifest, post.schemaManifest);
  const [table, column] = ctx.newColumn;
  must(diff.removed.length === 0 && diff.changed.length === 0 && diff.added.length === 1 && diff.added[0][0] === 'column' && isDeepStrictEqual(JSON.parse(diff.added[0][1]), ['public', table, column]), 'RELEASE_M25_SCHEMA_DELTA_UNEXPECTED');
  pass('schema-delta', { from: pre.schemaManifest.length, to: post.schemaManifest.length, added: JSON.parse(diff.added[0][1]) });
  must(isDeepStrictEqual(pre.datasetModality.map(row => row.id), post.datasetModality.map(row => row.id)) && isDeepStrictEqual(pre.datasetModality, post.datasetModality), 'RELEASE_M25_DATASETS_CHANGED'); // rows created by the fixture after migration 24 may be resolved; the historical ones are pinned separately by the runner
  pass('datasets-unchanged', { rows: post.datasetModality.length });
  return evidence;
}

// ---- Prisma client compatibility plan: frozen bindings, source scan, column shape ----
/** Fails closed (before anything is provisioned) when the schema, the complete generated client or the active chain differs from the accepted bindings. */
export function verifyCompatBindings(deps) {
  const bindings = deps.pinned.compat;
  must(bindings && typeof bindings === 'object', 'COMPAT_BINDINGS_MISSING');
  must(sha(readFileSync(join(deps.root, 'prisma/schema.prisma'))) === bindings.schemaSha256, 'FROZEN_SCHEMA_DRIFT');
  const prefix = 'lib/generated/prisma/';
  const client = readClientTree(join(deps.root, 'lib/generated/prisma'));
  for (const [path, hash] of Object.entries(bindings.generatedFiles)) must(client.get(path.slice(prefix.length)) === hash, 'FROZEN_CLIENT_FILE_DRIFT');
  must(clientTreeHash(client) === bindings.generatedTreeSha256, 'FROZEN_CLIENT_DRIFT'); // any added, deleted or changed generated file
  must(clientTreeHash(readClientTree(join(deps.root, 'prisma/migrations'))) === bindings.activeChainTreeSha256, 'FROZEN_ACTIVE_CHAIN_DRIFT');
  return { schemaSha256: bindings.schemaSha256, generatedTreeSha256: bindings.generatedTreeSha256, generatedFiles: { ...bindings.generatedFiles }, activeChainTreeSha256: bindings.activeChainTreeSha256 };
}

const COMPAT_ALLOWED_IMPORTS = new Set(['node:assert/strict', 'node:test', '@internal/db', '@/lib/db', '../../../../scripts/db-safety/test-entry.cjs', '../../../../lib/generated/prisma/browser']);
// The T015 creation-path test additionally drives the application's own creation entry points (still only through @/lib/db for the database).
export const T015_ALLOWED_IMPORTS = new Set([
  ...COMPAT_ALLOWED_IMPORTS, 'node:crypto', 'node:module',
  '../workspace/helpers.js', '../local-folder-import/helpers.js',
  '@/app/api/datasets/route', '@/lib/imports/prepare-local-folder-import', '@/lib/imports/confirmed-classes-server', '@/lib/queue/enqueue-job', '@/lib/repository-import/types',
  '@/lib/validation/dataset', '@/lib/validation/local-folder-import', '@/lib/validation/repository-import-request', '@/lib/validation/confirmed-classes', '@/lib/validation/source-connection', '@/lib/validation/label-name',
  '@/lib/labels/label-color-presets', '@annotationplatform/domain/confirmed-classes',
]);
// T019/T020 ingestion test: the application modules it drives, plus the exact module-load stubs it needs. Providers/db are replaced ONLY via the literal-specifier require window; no driver, socket, process or raw SQL is permitted.
export const INGEST_ALLOWED_IMPORTS = new Set([
  ...COMPAT_ALLOWED_IMPORTS, 'node:crypto', 'node:module', 'node:stream', '../workspace/helpers.js',
  '@/lib/asset-upload', '@/lib/upload-capability',
]);
export const INGEST_ALLOWED_REQUIRES = new Set(['node:module', '@/lib/providers', '@/lib/db', '@/lib/imports/complete-local-folder-item', '@/lib/imports/commit-local-folder-import']);
export const BACKFILL_ALLOWED_IMPORTS = new Set([...COMPAT_ALLOWED_IMPORTS, '@/lib/datasets/modality', '@/lib/datasets/modality-backfill', '@/lib/datasets/modality-backfill-evidence']);
const COMPAT_FORBIDDEN = [
  ['RAW_SQL', /\$queryRaw|\$executeRaw|\$runCommandRaw|queryRawUnsafe|executeRawUnsafe|\bPrisma\.sql\b|\bPrisma\.raw\b|\bsql`/],
  ['ALTERNATE_PRISMA_CLIENT', /\bPrismaClient\b|@prisma\/client|@prisma\/adapter|generated\/prisma\/client|generated\/prisma\/internal/],
  ['DIRECT_POSTGRES_DRIVER', /['"](?:pg|pg-native|pg-promise|postgres|slonik|knex|typeorm|sequelize|kysely|drizzle-orm)(?:\/[^'"]*)?['"]|@neondatabase|@vercel\/postgres/],
  ['PROCESS_SPAWN', /child_process|\bspawn(?:Sync)?\b|\bexec(?:Sync|File|FileSync)?\s*\(|\bfork\s*\(|\bProcess\.|\bBun\.spawn/],
  ['DB_OR_CONTAINER_TOOL', /\bpsql\b|\bpg_dump\b|\bpg_restore\b|\bdocker\b|\bredis-cli\b/],
  ['SOCKET_OR_DRIVER', /node:net|['"]net['"]|node:tls|['"]tls['"]|node:dgram|node:dns|['"]dns['"]|\bnew\s+(?:net\.)?Socket\b|createConnection|\bfetch\s*\(|ioredis|['"]redis['"]|['"]minio['"]/],
  ['DYNAMIC_LOADING', /\brequire\s*\(|\bimport\s*\(|\beval\s*\(|\bnew\s+Function\b/],
];
/**
 * A verification test may reach the database only through the application client (@/lib/db): an import allowlist plus forbidden constructs.
 * Profile `t015` also allows `require("<allowed specifier>")` (the module-load pattern used to substitute only the request-actor lookup).
 */
export function scanCompatTestSource(text, profile = 'compat') {
  const allowed = profile === 't015' ? T015_ALLOWED_IMPORTS : profile === 'ingest' ? INGEST_ALLOWED_IMPORTS : profile === 'backfill' ? BACKFILL_ALLOWED_IMPORTS : COMPAT_ALLOWED_IMPORTS;
  const violations = [];
  const first = text.split('\n')[0];
  if (!/^import ["']\.\.\/\.\.\/\.\.\/\.\.\/scripts\/db-safety\/test-entry\.cjs["'];/.test(first)) violations.push('MISSING_FIRST_LINE_GATE');
  const specifiers = [...text.matchAll(/^\s*import\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/gm)].map(match => match[1]);
  for (const specifier of specifiers) if (!allowed.has(specifier)) violations.push(`IMPORT_NOT_ALLOWED:${specifier}`);
  if (!specifiers.includes('@/lib/db')) violations.push('MUST_USE_APPLICATION_DB');
  const requires = [...text.matchAll(/\brequire\s*\(\s*(["'])([^"']*)\1\s*\)/g)].map(match => match[2]);
  const bareRequire = /\brequire\s*\(\s*(?!["'])/.test(text);
  for (const [code, pattern] of COMPAT_FORBIDDEN) {
    if (code === 'DYNAMIC_LOADING' && profile === 't015') {
      const runtimeText = text.replace(/\btypeof\s+import\s*\(\s*(["'])([^"']*)\1\s*\)/g, (whole, _q, spec) => (INGEST_ALLOWED_REQUIRES.has(spec) ? '' : whole)); // type-only queries of allowed modules are not loading
      if (/\bimport\s*\(|\beval\s*\(|\bnew\s+Function\b/.test(text) || bareRequire) violations.push(code);
      for (const specifier of requires) if (!allowed.has(specifier)) violations.push(`REQUIRE_NOT_ALLOWED:${specifier}`);
      continue;
    }
    if (code === 'DYNAMIC_LOADING' && profile === 'ingest') {
      // Only literal specifiers through `nodeRequire(...)` / `nodeRequire.resolve(...)` (createRequire alias) from the exact allowlist; `require`, import(), eval and Function stay forbidden.
      const runtimeText = text.replace(/\btypeof\s+import\s*\(\s*(["'])([^"']*)\1\s*\)/g, (whole, _q, spec) => (INGEST_ALLOWED_REQUIRES.has(spec) ? '' : whole)); // type-only queries of allowed modules are not loading
      if (/\bimport\s*\(|\beval\s*\(|\bnew\s+Function\b|\brequire\s*\(/.test(runtimeText) || /\bnodeRequire(?:\.resolve)?\s*\(\s*(?!["'])/.test(text)) violations.push(code);
      for (const match of text.matchAll(/\bnodeRequire(?:\.resolve)?\s*\(\s*(["'])([^"']*)\1\s*\)/g)) if (!INGEST_ALLOWED_REQUIRES.has(match[2])) violations.push(`REQUIRE_NOT_ALLOWED:${match[2]}`);
      continue;
    }
    if (pattern.test(text)) violations.push(code);
  }
  return violations;
}
export const assertCompatTestSource = (text, profile = 'compat') => { const violations = scanCompatTestSource(text, profile); must(violations.length === 0, 'COMPAT_TEST_SOURCE_FORBIDDEN'); return violations; };

/** Read-only column-shape validation of PreparedImport.creationRequestHash from the information_schema manifest rows. */
export function assertCompatColumn(columns) {
  const [table, column] = ['PreparedImport', 'creationRequestHash'];
  const rows = columns.filter(row => row[0] === table && row[1] === column);
  const others = columns.filter(row => row[0] === table && row[1] !== column).map(row => row[5]);
  must(rows.length === 1 && rows[0][2] === 'text' && rows[0][3] === 'YES' && rows[0][4] === null && Number.isInteger(rows[0][5]) && others.length > 0 && rows[0][5] === Math.max(...others) + 1, 'COMPAT_COLUMN_SHAPE_UNEXPECTED');
  return { column: rows[0] };
}

export function realDeps() {
  const root = guard.root;
  return {
    root,
    outBase: join(root, 'specs/029-modality-specific-datasets/verification/focused-runs'),
    registry: guard.registry,
    uid: process.getuid(),
    // Never inherited authority: only PATH/HOME/TMPDIR/LANG survive; DATABASE_URL/DB_SAFETY_RECEIPT are dropped.
    baseEnv: () => guard.cleanEnv(),
    inheritedUrlPresent: () => Boolean(process.env.DATABASE_URL),
    sh: (cmd, args, { env, input, cwd } = {}) => {
      const p = spawnSync(cmd, args, { env, input, cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      return { status: p.status ?? 1, stdout: p.stdout ?? '', stderr: p.stderr ?? '' };
    },
    // Committed G1 identity checks (reused, not reimplemented).
    identity: { container: guard.containerIdentity, control: guard.controlIdentity },
    newToken: () => randomBytes(4).toString('hex'),
    newSecret: () => randomBytes(24).toString('hex'),
    now: () => new Date(),
    sleep: ms => new Promise(done => setTimeout(done, ms)),
    mkStage: () => mkdtempSync('/tmp/phase029-g1-'),
    pickPorts: async () => {
      const free = port => new Promise(done => { const server = createServer(); server.once('error', () => done(false)); server.listen(port, '127.0.0.1', () => server.close(() => done(true))); });
      const ports = [];
      for (let port = PORT_RANGE[0]; port <= PORT_RANGE[1] && ports.length < 3; port += 1) if (await free(port)) ports.push(port);
      must(ports.length === 3, 'NO_FREE_DISPOSABLE_PORTS');
      return ports;
    },
    // Committed independent verifier (reused).
    verifyCleanup: runDir => {
      const p = spawnSync(process.execPath, [join(root, 'scripts/db-safety/cleanup-verify.mjs'), runDir], { encoding: 'utf8', env: guard.cleanEnv() });
      return { status: p.status ?? 1, output: (p.stdout ?? '') + (p.stderr ?? '') };
    },
    pinned: { baseline: BASELINE_MIGRATIONS, chain: PROPOSAL_CHAIN, compat: COMPAT_BINDINGS },
    maintenanceImplementation: () => maintenanceImplementation(root),
    releaseManifestSql: () => releaseManifestSqlFrom(join(root, RECOVERY_REVIEW.path)),
  };
}

/** Orchestrates one run. Always cleans up and verifies cleanup once anything was created. */
export async function runFocusedTest(command, deps = realDeps()) {
  const catalog = guard.read(join(deps.root, 'scripts/db-safety/commands.json'));
  validateCommand(command, catalog); // before any side effect
  const plan = resolvePlan(command);

  // ---- Local preflight (still before provisioning) ----
  const chain = validateChain(deps, plan.through); // frozen proposal manifest: identity, order, exact bytes, no extra files
  const baseline = baselineRows(deps.root, deps.pinned.chain);
  let compatBindings = null;
  if (plan.kind === 'compat') {
    // Frozen schema / complete generated client / active chain are verified BEFORE any directory, process or resource is created.
    compatBindings = verifyCompatBindings(deps);
    must(isDeepStrictEqual(catalog[plan.testCommand], plan.spec), 'COMPAT_COMMAND_TAMPERED');
    const testPath = join(deps.root, plan.file);
    must(existsSync(testPath), 'COMPAT_TEST_MISSING');
    assertCompatTestSource(readFileSync(testPath, 'utf8'), plan.scan);
  }
  if (plan.kind === 'rehearsal') {
    // The fixture is an exact internal step: the catalog entry must be structurally identical to FIXTURE_SPEC (no substituted path, extra argument or flag).
    must(isDeepStrictEqual(catalog[plan.fixtureCommand], FIXTURE_SPEC), 'FIXTURE_COMMAND_TAMPERED');
    const fixturePath = join(deps.root, FIXTURE_FILE);
    must(existsSync(fixturePath) && /import .*db-safety\/test-entry.cjs/.test(readFileSync(fixturePath, 'utf8').split('\n')[0]), 'FIXTURE_FILE_MISSING_OR_UNGATED');
  }
  let releaseManifest = null;
  let maintenanceImplementationAtStart = null;
  if (plan.kind === 'release') {
    // The release proof composes only reviewed, pinned pieces: frozen schema/client/chain, the pinned G2 catalog steps, the fixture, the compat test and the pinned manifest definition.
    compatBindings = verifyCompatBindings(deps);
    for (const [name, spec] of Object.entries(RELEASE_SPECS)) must(isDeepStrictEqual(catalog[name], spec), 'RELEASE_COMMAND_TAMPERED');
    must(isDeepStrictEqual(catalog[plan.fixtureCommand], FIXTURE_SPEC), 'FIXTURE_COMMAND_TAMPERED');
    must(isDeepStrictEqual(catalog[plan.compatCommand], plan.compatSpec), 'COMPAT_COMMAND_TAMPERED');
    for (const file of ['scripts/db-safety/g2-generate.mjs', 'scripts/db-safety/g2-compatibility.mjs', 'apps/web/tests/dataset-modality/g2-baseline.test.ts', 'apps/web/tests/dataset-modality/g2-candidate.test.ts', FIXTURE_FILE, plan.compatFile]) must(existsSync(join(deps.root, file)), 'RELEASE_STEP_FILE_MISSING');
    must(/import .*db-safety\/test-entry.cjs/.test(readFileSync(join(deps.root, FIXTURE_FILE), 'utf8').split('\n')[0]), 'FIXTURE_FILE_MISSING_OR_UNGATED');
    assertCompatTestSource(readFileSync(join(deps.root, plan.compatFile), 'utf8'), 'compat');
    releaseManifest = deps.releaseManifestSql();
  }
  if (plan.kind === 'backfill') {
    compatBindings = verifyCompatBindings(deps);
    for (const name of ['g2:generate', 'g2:compatibility']) must(isDeepStrictEqual(catalog[name], RELEASE_SPECS[name]), 'RELEASE_COMMAND_TAMPERED');
    must(isDeepStrictEqual(catalog[BACKFILL_SEED_COMMAND], BACKFILL_SEED_SPEC), 'BACKFILL_COMMAND_TAMPERED');
    must(isDeepStrictEqual(catalog[BACKFILL_VERIFY_COMMAND], BACKFILL_VERIFY_SPEC), 'BACKFILL_COMMAND_TAMPERED');
    for (const file of ['scripts/db-safety/g2-generate.mjs', 'scripts/db-safety/g2-compatibility.mjs', BACKFILL_SEED_FILE, BACKFILL_VERIFY_FILE, 'apps/web/src/lib/datasets/modality-backfill.ts', 'apps/web/src/lib/datasets/modality-backfill-evidence.ts']) must(existsSync(join(deps.root, file)), 'BACKFILL_STEP_FILE_MISSING');
    must(/import .*db-safety\/test-entry.cjs/.test(readFileSync(join(deps.root, BACKFILL_SEED_FILE), 'utf8').split('\n')[0]), 'BACKFILL_FILE_UNGATED');
    assertCompatTestSource(readFileSync(join(deps.root, BACKFILL_VERIFY_FILE), 'utf8'), 'backfill');
    releaseManifest = deps.releaseManifestSql();
  }
  if (plan.kind === 'maintenance') {
    compatBindings = verifyCompatBindings(deps);
    for (const name of ['g2:generate', 'g2:compatibility']) must(isDeepStrictEqual(catalog[name], RELEASE_SPECS[name]), 'RELEASE_COMMAND_TAMPERED');
    for (const [name, spec] of [[MAINT_SEED_COMMAND, MAINT_SEED_SPEC], [MAINT_OBJECTS_COMMAND, MAINT_OBJECTS_SPEC], [MAINT_CHECK_COMMAND, MAINT_CHECK_SPEC]]) must(isDeepStrictEqual(catalog[name], spec), 'MAINTENANCE_COMMAND_TAMPERED');
    for (const file of [...MAINTENANCE_FILES, 'scripts/db-safety/g2-generate.mjs', 'scripts/db-safety/g2-compatibility.mjs']) must(existsSync(join(deps.root, file)), 'MAINTENANCE_FILE_MISSING');
    for (const file of MAINTENANCE_FILES.filter(entry => entry.endsWith('.test.ts'))) must(/import .*db-safety\/test-entry.cjs/.test(readFileSync(join(deps.root, file), 'utf8').split('\n')[0]), 'MAINTENANCE_FILE_UNGATED');
    maintenanceImplementationAtStart = deps.maintenanceImplementation?.() ?? null; // the pinned implementation set must be readable and complete before anything is provisioned
    releaseManifest = deps.releaseManifestSql();
  }
  const generatedModel = join(deps.root, 'lib/generated/prisma/models/Dataset.ts');
  must(existsSync(generatedModel) && readFileSync(generatedModel, 'utf8').includes('modalityContentRevision'), 'GENERATED_CLIENT_NOT_PHASE029'); // never regenerated here
  const protectedBefore = { migrations: treeHash(deps.root, 'prisma/migrations'), generated: treeHash(deps.root, 'lib/generated/prisma'), schema: sha(readFileSync(join(deps.root, 'prisma/schema.prisma'))) };

  // ---- Run identity ----
  const token = deps.newToken();
  const password = deps.newSecret();
  const stamp = deps.now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const runDir = join(deps.outBase, `${stamp}-${token}`);
  mkdirSync(runDir, { recursive: true });
  const stage = deps.mkStage();
  const state = { token, pins: [], receiptIds: [], topology: [], failures: [], testExit: null, cleanup: null, independent: null };
  const save = (name, value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
    must(!text.includes(password), 'SECRET_IN_EVIDENCE');
    writeFileSync(join(runDir, name), text);
  };
  // Explicit evidence classification: a focused run is never G3/G5 closure evidence and writes only below outBase.
  const migrationChain = { active: baseline.map(row => row.name), proposals: chain.map(({ order, name, sha256, path }) => ({ order, name, sha256, path })) };
  const classification = plan.kind === 'maintenance'
    ? { kind: 'maintenance-launcher-rehearsal', scope: plan.scope, countsAsG3Evidence: false, countsAsG5Evidence: false, notAuthorizationToApplyMigration: true, notAuthorizationToBackfill: true, notAuthorizationForSharedDevExecution: true, maintenanceRehearsalPassed: false, usesRealStorage: true, expectedSchemaEntries: RELEASE_COUNTS, command, runToken: token, outputNamespace: 'verification/focused-runs', migrationChain, sourceBindings: compatBindings }
    : plan.kind === 'backfill'
    ? { kind: 'dataset-modality-backfill-rehearsal', scope: plan.scope, countsAsG3Evidence: false, countsAsG5Evidence: false, notAuthorizationToApplyMigration: true, notAuthorizationToBackfill: true, backfillRehearsalPassed: false, expectedSchemaEntries: RELEASE_COUNTS, command, runToken: token, outputNamespace: 'verification/focused-runs', migrationChain, sourceBindings: compatBindings }
    : plan.kind === 'release'
    ? { kind: 'release-chain-proof', scope: plan.scope, countsAsG3Evidence: false, countsAsG5Evidence: false, notAuthorizationToApplyMigration: true, releaseChainProven: false, expectedSchemaEntries: RELEASE_COUNTS, command, runToken: token, outputNamespace: 'verification/focused-runs', migrationChain, sourceBindings: compatBindings }
    : plan.kind === 'compat'
    ? { kind: plan.evidenceKind, scope: plan.scope, countsAsG3Evidence: false, countsAsG5Evidence: false, migrationBehaviorAlreadyProvenSeparately: true, notAuthorizationToApplyMigration: true, [plan.provenFlag]: false, command, runToken: token, outputNamespace: 'verification/focused-runs', migrationChain, sourceBindings: compatBindings }
    : plan.kind === 'rehearsal'
    ? { kind: 'migration-rehearsal', countsAsG3Evidence: false, countsAsG5Evidence: false, scope: plan.scope, activeChainUnchanged: true, notAuthorizationToApplyMigration: true, command, runToken: token, outputNamespace: 'verification/focused-runs', migrationChain }
    : { kind: 'focused-disposable-test', countsAsG3Evidence: false, countsAsG5Evidence: false, command, runToken: token, outputNamespace: 'verification/focused-runs' };
  save('allocation-ownership.json', { privateStage: stage, ownerUid: deps.uid, runToken: token, ...classification });
  save('focused-run.json', classification);
  if (plan.kind === 'compat') save('compat-evidence.json', { ...compatBindings, migrations: chain.map(({ order, name, sha256 }) => ({ order, name, sha256 })), historical: baseline.length, [plan.provenFlag]: false, note: 'bindings verified before provisioning; the final verdict is only in results.json' });
  if (deps.inheritedUrlPresent()) save('ignored-inherited-url.json', { ignored: true, note: 'inherited DATABASE_URL has no authority; value not recorded' });

  const env = { ...deps.baseEnv(), POSTGRES_PASSWORD: password, MINIO_ROOT_USER: 'g1' + token, MINIO_ROOT_PASSWORD: password };
  for (const key of ['DATABASE_URL', 'DB_SAFETY_RECEIPT']) delete env[key];
  const run = (cmd, args, options = {}) => deps.sh(cmd, args, { env, cwd: deps.root, ...options });
  const docker = args => { const p = run('docker', args); must(p.status === 0, 'DOCKER_COMMAND_FAILED'); return p.stdout; };

  const issue = (name, request, expectCommand) => {
    const requestPath = join(stage, `${name}-request.json`);
    const receiptPath = join(stage, `${name}-receipt.json`);
    writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
    const p = run(process.execPath, [join(deps.root, 'scripts/db-safety/approve-disposable.mjs'), requestPath, receiptPath]);
    save(`${name}-issue.log`, guard.redact(p.stdout + p.stderr).split(password).join('[REDACTED]'));
    must(p.status === 0, 'RECEIPT_ISSUE_FAILED');
    let receipt;
    try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); } catch { fail('RECEIPT_MISSING_OR_MALFORMED'); }
    must(typeof receipt?.id === 'string' && UUID.test(receipt.id), 'RECEIPT_MISSING_OR_MALFORMED');
    state.receiptIds.push(receipt.id);
    state.topology.push({ step: name, operation: request.operation, command: expectCommand, receiptId: receipt.id });
    must(receipt.operation === request.operation && (receipt.command ?? null) === expectCommand, 'RECEIPT_SCOPE_MISMATCH');
    must(receipt.postgres?.systemIdentifier === pg().systemIdentifier && receipt.postgres?.id === pg().id, 'RECEIPT_TARGET_MISMATCH');
    return receiptPath;
  };
  const launch = (name, receiptPath, operation, cmd) => {
    const p = run(process.execPath, [join(deps.root, 'scripts/db-safety/cli.mjs'), operation, ...(cmd ? [cmd] : [])], { env: { ...env, DB_SAFETY_RECEIPT: receiptPath } });
    save(`${name}.log`, guard.redact(p.stdout + p.stderr).split(password).join('[REDACTED]'));
    return p.status;
  };
  const pg = () => state.pins.find(pin => pin.role === 'postgres');
  // One guarded test child under its own receipt, scoped to exactly this catalog command.
  const testStep = (name, cmd, code) => {
    const receipt = issue(name, { ...deployRequest(), operation: 'test', command: cmd, providerFile: join(stage, 'providers.json'), providers: state.pins.filter(pin => pin.role !== 'postgres') }, cmd);
    must(launch(name, receipt, 'test', cmd) === 0, code);
  };
  // Read-only evidence only: identity re-proved first, session and transaction both read-only, one single-line jsonb value per statement.
  const psqlMany = statements => {
    deps.identity.control(pg());
    const input = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n${statements.join('\n')}\nROLLBACK;\n`;
    const p = run('docker', ['exec', '-i', '-e', 'PGOPTIONS=-c default_transaction_read_only=on', pg().id, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'fieldframe'], { input });
    must(p.status === 0, 'READONLY_QUERY_FAILED');
    const lines = p.stdout.trim().split('\n');
    must(lines.length === statements.length, 'READONLY_QUERY_FAILED');
    return lines;
  };
  const readHistory = () => { try { return JSON.parse(psqlMany([HISTORY_SQL])[0]); } catch (error) { if (/^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '')) throw error; return fail('HISTORY_UNPARSEABLE'); } };
  const verifyHistory = (stageLabel, entries) => checkHistory(readHistory(), [...baseline, ...entries], stageLabel);
  const capture = () => {
    const tables = JSON.parse(psqlMany([TABLES_SQL])[0]);
    const script = captureScript(tables, plan.kind === 'release' || plan.kind === 'backfill' || plan.kind === 'maintenance' ? releaseExtraSql(releaseManifest) : {});
    return parseCapture(psqlMany(script.statements), script);
  };
  const deployRequest = () => ({
    config: join(stage, 'prisma.config.ts'),
    configSha256: sha(readFileSync(join(stage, 'prisma.config.ts'))),
    operation: 'deploy',
    postgres: pg(),
    schemaSha256: sha(readFileSync(join(stage, 'schema.prisma'))),
    migrationHashes: Object.fromEntries(guard.migrationFiles(join(stage, 'migrations')).map(file => [file, sha(readFileSync(file))])),
  });

  try {
    // ---- Provision (record each pin the moment it exists) ----
    const [pgPort, redisPort, minioPort] = await deps.pickPorts();
    for (const [role, image, port, internal, extra, tail] of [
      ['postgres', 'postgres:16-alpine', pgPort, 5432, ['-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=fieldframe'], ['postgres']],
      ['redis', 'redis:7-alpine', redisPort, 6379, ['-v', `${join(stage, 'redis.conf')}:/usr/local/etc/redis/redis.conf:ro`], ['redis-server', '/usr/local/etc/redis/redis.conf']],
      ['minio', 'minio/minio:RELEASE.2025-04-22T22-12-26Z', minioPort, 9000, ['-e', 'MINIO_ROOT_USER', '-e', 'MINIO_ROOT_PASSWORD'], ['server', '/data']],
    ]) {
      if (role === 'redis') { writeFileSync(join(stage, 'redis.conf'), `bind 0.0.0.0\nrequirepass ${password}\n`, { mode: 0o644 }); }
      const name = `phase029-g1-g3-${token}-${role}`; // name shape is what cleanup-verify.mjs searches for
      const id = docker(['run', '-d', '--name', name, '--label', 'annotation.safety=g1-disposable', '--label', `annotation.role=${role}`, '--label', `annotation.run=${token}`, '-p', `127.0.0.1:${port}:${internal}`, ...extra, image, ...tail]).trim();
      must(HEX64.test(id), 'DISPOSABLE_CONTAINER_ID_INVALID');
      state.pins.push({ name, id, role, port, internalPort: internal });
    }
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
      ready = run('docker', ['exec', pg().id, 'pg_isready', '-U', 'postgres', '-d', 'fieldframe']).status === 0;
      if (!ready) await deps.sleep(300);
    }
    must(ready, 'DISPOSABLE_POSTGRES_NOT_READY');

    // ---- Identity before any receipt or data ----
    const controlOutput = docker(['exec', pg().id, 'sh', '-c', 'LC_ALL=C pg_controldata "$PGDATA"']);
    const systemIdentifier = controlOutput.match(/^Database system identifier:\s+(\d+)/m)?.[1];
    must(systemIdentifier && systemIdentifier !== guard.applicationSystem, 'SYSTEM_IDENTITY_MISMATCH');
    pg().systemIdentifier = systemIdentifier;
    for (const pin of state.pins) deps.identity.container(pin, pin.role);
    deps.identity.control(pg());
    save('disposable-identities.json', state.pins);
    const volumes = [];
    for (const pin of state.pins) for (const mount of JSON.parse(docker(['inspect', pin.id]))[0]?.Mounts ?? []) if (mount.Type === 'volume') volumes.push({ containerId: pin.id, name: mount.Name });
    save('owned-volumes.json', volumes);

    // ---- Stage: reviewed baseline bytes only ----
    // The staged baseline is the 23 historical migrations only; the promoted chain entries are staged one at a time below.
    const promotedNames = new Set(deps.pinned.chain.map(entry => entry.name));
    cpSync(join(deps.root, 'prisma/migrations'), join(stage, 'migrations'), { recursive: true, filter: source => !promotedNames.has(basename(source)) });
    cpSync(join(deps.root, 'prisma/schema.prisma'), join(stage, 'schema.prisma'));
    symlinkSync(join(deps.root, 'node_modules'), join(stage, 'node_modules'), 'dir');
    const url = `postgresql://postgres:${password}@127.0.0.1:${pgPort}/fieldframe`;
    const configText = `import {defineConfig} from ${JSON.stringify(join(deps.root, 'node_modules/prisma/config.js'))}; export default defineConfig(${JSON.stringify({ schema: join(stage, 'schema.prisma'), migrations: { path: join(stage, 'migrations') }, engine: 'classic', datasource: { url } })});`;
    writeFileSync(join(stage, 'prisma.config.ts'), configText, { mode: 0o600 });
    writeFileSync(join(stage, 'providers.json'), JSON.stringify({
      MINIO_ENDPOINT: `http://127.0.0.1:${minioPort}`, MINIO_ACCESS_KEY: env.MINIO_ROOT_USER, MINIO_SECRET_KEY: password, MINIO_BUCKET: `g1-${token}`,
      REDIS_HOST: '127.0.0.1', REDIS_PORT: String(redisPort), REDIS_PASSWORD: password, REDIS_DB: '0', BULLMQ_PREFIX: `g1-${token}`,
    }), { mode: 0o600 });

    // ---- Baseline (the 23 historical migrations), then the promoted Phase029 chain in order (disposable instance only) ----
    must(launch('baseline-deploy', issue('baseline-deploy', deployRequest(), null), 'deploy') === 0, 'BASELINE_DEPLOY_FAILED');
    verifyHistory('BASELINE', []);
    let pre = null;
    const releaseCaptures = {};
    if (plan.kind === 'backfill' || plan.kind === 'maintenance') {
      releaseCaptures.baseline = capture();
      must(releaseCaptures.baseline.schemaManifest.length === RELEASE_COUNTS.baseline, 'RELEASE_BASELINE_SCHEMA_COUNT_UNEXPECTED');
      testStep('generate', 'g2:generate', 'RELEASE_GENERATE_FAILED');
      testStep('baseline-seed', plan.kind === 'maintenance' ? MAINT_SEED_COMMAND : BACKFILL_SEED_COMMAND, 'BACKFILL_SEED_FAILED');
      releaseCaptures.seeded = capture();
      must(isDeepStrictEqual(releaseCaptures.seeded.schemaManifest, releaseCaptures.baseline.schemaManifest) && releaseCaptures.seeded.datasetLegacy[0] > 0, 'RELEASE_BASELINE_SEED_UNEXPECTED');
      save('backfill-seeded-datasets.json', releaseCaptures.seeded.datasetModality);
    }
    if (plan.kind === 'release') {
      // Historical state: the baseline client is generated by the pinned G2 step and seeds synthetic unresolved history (EMPTY, SINGLE, MIXED, deleted, archived) on the 23-migration database only.
      releaseCaptures.baseline = capture();
      save('release-baseline-schema-count.json', { entries: releaseCaptures.baseline.schemaManifest.length });
      must(releaseCaptures.baseline.schemaManifest.length === RELEASE_COUNTS.baseline, 'RELEASE_BASELINE_SCHEMA_COUNT_UNEXPECTED');
      testStep('generate', 'g2:generate', 'RELEASE_GENERATE_FAILED');
      testStep('baseline-seed', 'g2:baseline', 'RELEASE_BASELINE_SEED_FAILED');
      releaseCaptures.seeded = capture();
      must(isDeepStrictEqual(releaseCaptures.seeded.schemaManifest, releaseCaptures.baseline.schemaManifest) && releaseCaptures.seeded.datasetLegacy[0] > 0, 'RELEASE_BASELINE_SEED_UNEXPECTED');
      save('release-seeded-datasets.json', releaseCaptures.seeded.datasetModality);
    }
    for (const entry of chain) {
      const staged = join(stage, 'migrations', entry.name);
      cpSync(join(deps.root, entry.path), staged, { recursive: true });
      must(sha(readFileSync(join(staged, 'migration.sql'))) === entry.sha256, 'PROPOSAL_CHECKSUM_MISMATCH');
      must(launch(`proposal-${entry.order}-deploy`, issue(`proposal-${entry.order}-deploy`, deployRequest(), null), 'deploy') === 0, 'PROPOSAL_DEPLOY_FAILED');
      verifyHistory('PROPOSAL', chain.slice(0, entry.order));
      if (plan.kind === 'backfill' || plan.kind === 'maintenance') {
        const snapshot = capture();
        if (entry.order === 1) { save('release-m24-assertions.json', assertRelease24(releaseCaptures.seeded, snapshot, { proposal: entry })); releaseCaptures.m24 = snapshot; }
        else { save('release-m25-assertions.json', assertRelease25(releaseCaptures.m24, snapshot, { newColumn: plan.newColumn })); releaseCaptures.m25 = snapshot; }
      }
      if (plan.kind === 'release' && entry.order === 1) {
        releaseCaptures.m24 = capture();
        const m24Assertions = assertRelease24(releaseCaptures.seeded, releaseCaptures.m24, { proposal: entry });
        save('release-m24-assertions.json', m24Assertions);
        save('release-m24-datasets.json', releaseCaptures.m24.datasetModality);
      }
      if ((plan.kind === 'rehearsal' || plan.kind === 'release') && entry.order === plan.fixtureAfter) {
        // The fixture is the one fixed internal child step; its receipt is scoped to FIXTURE_COMMAND (the catalog entry was bound in preflight).
        const fixtureReceipt = issue('fixture', { ...deployRequest(), operation: 'test', command: plan.fixtureCommand, providerFile: join(stage, 'providers.json'), providers: state.pins.filter(pin => pin.role !== 'postgres') }, plan.fixtureCommand);
        must(launch('fixture', fixtureReceipt, 'test', plan.fixtureCommand) === 0, 'FIXTURE_FAILED');
        pre = capture();
        save('m25-pre-fingerprint.json', pre);
      }
    }

    if (plan.kind === 'maintenance') {
      must(releaseCaptures.m25.schemaManifest.length === RELEASE_COUNTS.m25 && releaseCaptures.m25.datasetModality.every(row => row.m === null), 'BACKFILL_PRECONDITION_UNEXPECTED');
      let stepCounter = 0;
      const childStep = (name, kind, payload) => {
        writeFileSync(join(stage, kind === 'check' ? 'maintenance-check.json' : 'maintenance-step.json'), JSON.stringify(payload), { mode: 0o600 });
        stepCounter += 1;
        testStep(`${name}-${stepCounter}`, kind === 'check' ? MAINT_CHECK_COMMAND : MAINT_OBJECTS_COMMAND, 'MAINTENANCE_STEP_FAILED');
      };
      const summary = await runMaintenanceRehearsal({
        root: deps.root, stage, runDir, save, sh: (cmd, args, options) => deps.sh(cmd, args, options), cleanEnv: () => ({ ...deps.baseEnv() }), pins: state.pins, token, password, minioUser: env.MINIO_ROOT_USER,
        bucket: `g1-${token}`, pgPort: pg().port, minioPort: state.pins.find(pin => pin.role === 'minio').port, historyRows: [...baseline, ...chain], m25: releaseCaptures.m25, childStep,
      });
      save('maintenance-summary-rehearsal.json', summary);
      testStep('schema-compat', 'g2:compatibility', 'RELEASE_SCHEMA_COMPAT_FAILED');
      verifyCompatBindings(deps);
      const final = capture();
      save('backfill-final-datasets.json', final.datasetModality);
      must(isDeepStrictEqual(final.schemaManifest, releaseCaptures.m25.schemaManifest) && isDeepStrictEqual(final.migrations, releaseCaptures.m25.migrations), 'RELEASE_FINAL_SCHEMA_OR_HISTORY_CHANGED');
      verifyHistory('FINAL', chain);
      const commandsSeen = state.topology.map(({ command: receiptCommand }) => receiptCommand);
      must(isDeepStrictEqual(commandsSeen, [...MAINTENANCE_COMMANDS]), 'RECEIPT_TOPOLOGY_UNEXPECTED');
      must(maintenanceImplementationAtStart !== null && isDeepStrictEqual(maintenanceImplementation(deps.root), maintenanceImplementationAtStart), 'IMPLEMENTATION_CHANGED_DURING_RUN');
      save('maintenance-summary.json', { historicalMigrations: baseline.length, activeChainMigrations: baseline.length + chain.length, schemaEntries: [releaseCaptures.baseline.schemaManifest.length, releaseCaptures.m24.schemaManifest.length, releaseCaptures.m25.schemaManifest.length, final.schemaManifest.length], schemaManifestSha256: maintenanceManifestDigest(final.schemaManifest), datasetsResolved: final.datasetModality.filter(row => row.m !== null).length, datasetsUnresolved: final.datasetModality.filter(row => row.m === null).length, migrationChecksums: final.migrations.map(row => ({ name: row.migration_name, checksum: row.checksum, finished: Boolean(row.finished_at), rolledBack: Boolean(row.rolled_back_at) })), launcherEvidenceDirs: summary.evidenceDirs });
    } else if (plan.kind === 'backfill') {
      // The chain is complete (25 records, 1842 schema entries, all historical Datasets still unresolved); only now does the evidence-bound backfill rehearsal run.
      must(releaseCaptures.m25.schemaManifest.length === RELEASE_COUNTS.m25 && releaseCaptures.m25.datasetModality.every(row => row.m === null), 'BACKFILL_PRECONDITION_UNEXPECTED');
      testStep('backfill-verify', BACKFILL_VERIFY_COMMAND, 'BACKFILL_REHEARSAL_FAILED');
      testStep('schema-compat', 'g2:compatibility', 'RELEASE_SCHEMA_COMPAT_FAILED');
      verifyCompatBindings(deps);
      const final = capture();
      save('backfill-final-datasets.json', final.datasetModality);
      // Data-only run: the schema and the migration history must be exactly what the chain left.
      must(isDeepStrictEqual(final.schemaManifest, releaseCaptures.m25.schemaManifest) && isDeepStrictEqual(final.migrations, releaseCaptures.m25.migrations), 'RELEASE_FINAL_SCHEMA_OR_HISTORY_CHANGED');
      verifyHistory('FINAL', chain);
      must(isDeepStrictEqual(state.topology.map(({ step, operation, command: receiptCommand }) => [step, operation, receiptCommand]), BACKFILL_TOPOLOGY.map(row => [...row])), 'RECEIPT_TOPOLOGY_UNEXPECTED');
      save('backfill-summary.json', { historicalMigrations: baseline.length, activeChainMigrations: baseline.length + chain.length, schemaEntries: [releaseCaptures.baseline.schemaManifest.length, releaseCaptures.m24.schemaManifest.length, releaseCaptures.m25.schemaManifest.length, final.schemaManifest.length], datasetsResolved: final.datasetModality.filter(row => row.m !== null).length, datasetsUnresolved: final.datasetModality.filter(row => row.m === null).length, migrationChecksums: final.migrations.map(row => ({ name: row.migration_name, checksum: row.checksum, finished: Boolean(row.finished_at), rolledBack: Boolean(row.rolled_back_at) })) });
    } else if (plan.kind === 'release') {
      must(pre !== null, 'REHEARSAL_PRECAPTURE_MISSING');
      const post = capture();
      save('m25-pre-fingerprint.json', pre); save('m25-post-fingerprint.json', post);
      const m25 = assertMigration25(pre, post, { newColumn: plan.newColumn, fixtureRows: plan.fixtureRows, proposal: chain.at(-1) });
      const schema25 = assertRelease25(pre, post, { newColumn: plan.newColumn });
      // Historical Datasets (present before migration 25) must be exactly as migration 24 left them.
      must(isDeepStrictEqual(post.datasetModality.filter(row => releaseCaptures.m24.datasetModality.some(old => old.id === row.id)), releaseCaptures.m24.datasetModality), 'RELEASE_HISTORICAL_DATASETS_CHANGED');
      save('release-m25-assertions.json', [...m25, ...schema25]);
      // Drift, history/status and client compatibility on the final 25-migration database, then the runtime contracts of the historical states.
      testStep('schema-compat', 'g2:compatibility', 'RELEASE_SCHEMA_COMPAT_FAILED');
      testStep('client-compat', plan.compatCommand, 'COMPAT_TEST_FAILED');
      verifyCompatBindings(deps);
      testStep('candidate-contracts', 'g2:candidate', 'RELEASE_CANDIDATE_CONTRACTS_FAILED');
      const final = capture();
      save('release-final-fingerprint.json', { schemaEntries: final.schemaManifest.length, migrations: final.migrations.length });
      must(isDeepStrictEqual(final.schemaManifest, post.schemaManifest) && isDeepStrictEqual(final.migrations, post.migrations), 'RELEASE_FINAL_SCHEMA_OR_HISTORY_CHANGED');
      verifyHistory('FINAL', chain);
      must(isDeepStrictEqual(state.topology.map(({ step, operation, command: receiptCommand }) => [step, operation, receiptCommand]), RELEASE_TOPOLOGY.map(row => [...row])), 'RECEIPT_TOPOLOGY_UNEXPECTED');
      save('release-summary.json', { historicalMigrations: baseline.length, activeChainMigrations: baseline.length + chain.length, schemaEntries: [releaseCaptures.baseline.schemaManifest.length, releaseCaptures.m24.schemaManifest.length, post.schemaManifest.length], migrationChecksums: final.migrations.map(row => ({ name: row.migration_name, checksum: row.checksum, finished: Boolean(row.finished_at), rolledBack: Boolean(row.rolled_back_at) })) });
    } else if (plan.kind === 'compat') {
      // Read-only structural check, then the one guarded child: the compatibility test (normal application-client operations only).
      assertCompatColumn(JSON.parse(psqlMany([MANIFEST_SQL.columns])[0]));
      const compatReceipt = issue(plan.stepName, { ...deployRequest(), operation: 'test', command: plan.testCommand, providerFile: join(stage, 'providers.json'), providers: state.pins.filter(pin => pin.role !== 'postgres') }, plan.testCommand);
      must(launch(plan.stepName, compatReceipt, 'test', plan.testCommand) === 0, 'COMPAT_TEST_FAILED');
      verifyCompatBindings(deps); // nothing in the frozen inputs may have changed during the run
      const expectedTopology = [['baseline-deploy', 'deploy', null], ['proposal-1-deploy', 'deploy', null], ['proposal-2-deploy', 'deploy', null], [plan.stepName, 'test', plan.testCommand]];
      must(isDeepStrictEqual(state.topology.map(({ step, operation, command: receiptCommand }) => [step, operation, receiptCommand]), expectedTopology), 'RECEIPT_TOPOLOGY_UNEXPECTED');
    } else if (plan.kind === 'rehearsal') {
      must(pre !== null, 'REHEARSAL_PRECAPTURE_MISSING');
      const post = capture();
      save('m25-post-fingerprint.json', post);
      const assertions = assertMigration25(pre, post, { newColumn: plan.newColumn, fixtureRows: plan.fixtureRows, proposal: chain.at(-1) });
      save('m25-assertions.json', assertions);
      const expectedTopology = [['baseline-deploy', 'deploy', null], ['proposal-1-deploy', 'deploy', null], ['fixture', 'test', plan.fixtureCommand], ['proposal-2-deploy', 'deploy', null]];
      must(isDeepStrictEqual(state.topology.map(({ step, operation, command: receiptCommand }) => [step, operation, receiptCommand]), expectedTopology), 'RECEIPT_TOPOLOGY_UNEXPECTED');
    } else {
      // ---- The one allowlisted command ----
      const testReceipt = issue('test', { ...deployRequest(), operation: 'test', command, providerFile: join(stage, 'providers.json'), providers: state.pins.filter(pin => pin.role !== 'postgres') }, command);
      state.testExit = launch('test', testReceipt, 'test', command);
      if (state.testExit !== 0) state.failures.push(`TEST_COMMAND_FAILED:${state.testExit}`);
    }

    must(treeHash(deps.root, 'prisma/migrations') === protectedBefore.migrations, 'BASELINE_MIGRATIONS_CHANGED');
    must(treeHash(deps.root, 'lib/generated/prisma') === protectedBefore.generated, 'GENERATED_CLIENT_CHANGED');
    must(sha(readFileSync(join(deps.root, 'prisma/schema.prisma'))) === protectedBefore.schema, 'PRISMA_SCHEMA_CHANGED');
  } catch (error) {
    state.failures.push(safe(error));
  } finally {
    state.cleanup = primaryCleanup(state, stage, { run, registry: deps.registry, save });
    state.independent = deps.verifyCleanup(runDir);
    if (state.independent.status !== 0) state.failures.push('INDEPENDENT_CLEANUP_FAILED');
    if (!state.cleanup.ok) state.failures.push('PRIMARY_CLEANUP_FAILED');
    // Identity-based, after the independent verifier too: no receipt registration this run created may remain.
    const remaining = state.receiptIds.filter(id => existsSync(resolve(deps.registry, `${id}.json`)));
    if (remaining.length) state.failures.push('RECEIPT_REGISTRATION_REMAINS');
  }
  const result = state.failures.length === 0 ? 'PASS' : 'FAIL';
  const finalClassification = plan.kind === 'compat' ? { ...classification, [plan.provenFlag]: result === 'PASS' } : plan.kind === 'release' ? { ...classification, releaseChainProven: result === 'PASS' } : plan.kind === 'backfill' ? { ...classification, backfillRehearsalPassed: result === 'PASS' } : plan.kind === 'maintenance' ? { ...classification, maintenanceRehearsalPassed: result === 'PASS' } : classification;
  save('results.json', { ...finalClassification, result, command, runToken: token, testExit: state.testExit, failures: state.failures, receiptTopology: state.topology, cleanup: state.cleanup, independentCleanupExit: state.independent.status });
  return { result, runDir, failures: state.failures, testExit: state.testExit };
}

/** Removes only what this run recorded, after re-proving ownership of each exact container. */
export function primaryCleanup(state, stage, { run, registry, save }) {
  const containers = [];
  for (const pin of [...state.pins].reverse()) {
    let owned = false;
    const inspected = run('docker', ['inspect', '--type', 'container', pin.id]);
    if (inspected.status === 0) {
      try {
        const info = JSON.parse(inspected.stdout)[0];
        owned = info?.Id === pin.id && info?.Name?.replace(/^\//, '') === pin.name && info?.Config?.Labels?.['annotation.run'] === state.token && info?.Config?.Labels?.['annotation.safety'] === 'g1-disposable';
      } catch { owned = false; }
    } else if (/No such (object|container)/i.test(inspected.stderr)) { containers.push({ id: pin.id, removed: true, alreadyAbsent: true }); continue; }
    if (!owned) { containers.push({ id: pin.id, removed: false, refused: 'NOT_RUN_OWNED' }); continue; }
    const removal = run('docker', ['rm', '-fv', pin.id]);
    containers.push({ id: pin.id, removed: removal.status === 0 });
  }
  // Identity-based: every registration this run recorded is removed by its exact id and then re-checked (the count is only a derived figure).
  let registrationsRemoved = 0;
  const registrationIds = [];
  for (const id of state.receiptIds) {
    const file = resolve(registry, `${id}.json`);
    if (UUID.test(id) && file.startsWith(resolve(registry) + sep)) { try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') continue; } if (!existsSync(file)) { registrationsRemoved += 1; registrationIds.push(id); } }
  }
  let stageRemoved = false;
  if (stage.startsWith('/tmp/phase029-g1-') && !stage.includes('..')) { rmSync(stage, { recursive: true, force: true }); stageRemoved = !existsSync(stage); }
  const ok = containers.every(entry => entry.removed) && registrationIds.length === state.receiptIds.length && state.receiptIds.every(id => registrationIds.includes(id)) && stageRemoved;
  const summary = { containers, privateStageRemoved: stageRemoved, receiptRegistrationsRemoved: registrationsRemoved, receiptRegistrationIds: registrationIds, ok };
  save('cleanup.json', { containers: containers.map(({ id, removed }) => ({ id, removed })), privateStageRemoved: stageRemoved, receiptRegistrationsRemoved: registrationsRemoved, receiptRegistrationIds: registrationIds });
  return summary;
}

if (process.argv[1] && basename(process.argv[1]) === 'disposable-test.mjs') {
  const args = process.argv.slice(2);
  if (args.length !== 1) { console.error('usage: disposable-test.mjs <allowlisted-command | rehearse:...>'); process.exit(2); }
  try {
    const outcome = await runFocusedTest(args[0]);
    console.log(JSON.stringify({ result: outcome.result, runDir: outcome.runDir, testExit: outcome.testExit, failures: outcome.failures }));
    process.exit(outcome.result === 'PASS' ? 0 : 1);
  } catch (error) { console.error('SAFETY_ABORT', safe(error)); process.exit(2); }
}
