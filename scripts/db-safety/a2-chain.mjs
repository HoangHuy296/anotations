#!/usr/bin/env node
// release:phase029-a2-chain — guarded, disposable-only rehearsal of the A2 M26 CANDIDATE on top of the unchanged 25-migration chain.
//   node scripts/db-safety/a2-chain.mjs
// It never touches the fresh-MVP, shared-dev or application database: it provisions its own G1 postgres (labels, loopback port, container name), applies
// the chain through the repository's receipt-bound approve-disposable.mjs -> cli.mjs deploy path (25 migrations, then the candidate as the 26th), proves
// M24/M25 are unchanged, captures the reviewed schema manifest before/after, proves the candidate equals its Prisma schema (no drift), proves PostgreSQL
// enum-value visibility, checks generated-client compatibility, and removes exactly what it created. The candidate lives in specs/proposals (not in
// prisma/migrations) so every existing 25-migration plan keeps working; promotion into prisma/migrations is a later, separately approved A2 step.
// F13 pinning in this plan: the candidate migration bytes, the candidate schema, M24/M25, the 23-migration baseline tree and the reviewed manifest CTE.
// job-contract.ts and the tracked generated client are NOT pinned here because A2.2 does not change them (they change with the A2 runtime increment).
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as guard from './guard.mjs';
import { manifestDigest, manifestSql } from './backfill-binding.mjs';
import { BASELINE_MIGRATIONS, PROPOSAL_CHAIN, RECOVERY_REVIEW, RELEASE_COUNTS } from './disposable-test.mjs';

export const A2_CHAIN_ID = 'release:phase029-a2-chain';
const ROOT = resolve(import.meta.dirname, '../..');
const PROPOSAL_DIR = 'specs/proposals/phase029-a2-media-verification';
export const M26 = Object.freeze({
  name: '20261007000000_media_verification_a2',
  path: `${PROPOSAL_DIR}/20261007000000_media_verification_a2`,
  sha256: 'ede5e8c511705521e1e6a18563ebaa602e9c24430946acddbed91340d923df5a',
  candidateSchema: `${PROPOSAL_DIR}/schema.candidate.prisma`,
  candidateSchemaSha256: '4a85c754d067ae64f0f767d5e6cd49f37c6d5f004865257faef66025d6000993',
});
/** Reviewed-manifest entry count after M26; pinned after the first disposable computation (null while discovering). */
export const A2_COUNTS = Object.freeze({ ...RELEASE_COUNTS, m26: 1942 });
const EXPECTED_COLUMNS = ['id', 'datasetId', 'requestedById', 'source', 'preparedImportItemId', 'currentJobId', 'generation', 'boundDatasetModality', 'stagedBucket', 'stagedKey', 'stagedEtag', 'stagedSizeBytes', 'stagedLastModified', 'stagedVersionId', 'filename', 'relativePathHint', 'declaredContentType', 'declaredSizeBytes', 'sealedKey', 'sealedEtag', 'sealedSizeBytes', 'sealedLastModified', 'sealedVersionId', 'contentSha256', 'status', 'verifiedModality', 'resultCode', 'resultReason', 'probe', 'policyVersion', 'processorVersion', 'lastFailureCode', 'lastFailureReason', 'lastFailureAt', 'objectsClearedAt', 'assetId', 'verificationDeadlineAt', 'sealedAt', 'verifiedAt', 'publishedAt', 'finishedAt', 'createdAt', 'updatedAt'];
const EXPECTED_INDEXES = ['MediaVerification_assetId_key', 'MediaVerification_currentJobId_idx', 'MediaVerification_datasetId_status_idx', 'MediaVerification_pkey', 'MediaVerification_preparedImportItemId_generation_key', 'MediaVerification_requestedById_status_idx', 'MediaVerification_sealedKey_key', 'MediaVerification_stagedBucket_stagedKey_generation_key', 'MediaVerification_status_verificationDeadlineAt_idx'];
const EXPECTED_FKS = [['MediaVerification_assetId_fkey', 'SET NULL'], ['MediaVerification_currentJobId_fkey', 'SET NULL'], ['MediaVerification_datasetId_fkey', 'CASCADE'], ['MediaVerification_preparedImportItemId_fkey', 'CASCADE'], ['MediaVerification_requestedById_fkey', 'RESTRICT']];

const sha = value => createHash('sha256').update(value).digest('hex');
const must = (ok, code, detail) => { if (!ok) throw Object.assign(Error(code), { detail }); };
const run = (cmd, argv, options = {}) => { const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options }); return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; };
const base = { PATH: process.env.PATH, HOME: process.env.HOME };
const evidence = { schema: 'phase029-a2-chain/v1', plan: A2_CHAIN_ID, startedAt: new Date().toISOString(), checks: [], failure: null };
const secrets = new Set();
const redact = text => { let out = guard.redact(text); for (const s of secrets) out = out.split(s).join('[REDACTED]'); return out; };
const check = (id, pass, detail) => { evidence.checks.push({ id, pass: Boolean(pass), detail }); must(pass, `CHECK_FAILED_${id}`, detail); };
const owned = [];
const stages = [];
const CONTAINER = 'phase029-g1-a2chain-postgres', PORT = 55474;

async function main() {
  // ---- F13 pins and invariants: nothing is provisioned before they hold
  const migrationsDir = join(ROOT, 'prisma/migrations');
  const active = readdirSync(migrationsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  check('active-chain-is-exactly-the-25-and-has-no-m26', active.length === BASELINE_MIGRATIONS + PROPOSAL_CHAIN.length && !active.includes(M26.name), { count: active.length });
  for (const entry of PROPOSAL_CHAIN) check(`m${23 + entry.order}-bytes-pinned`, sha(readFileSync(join(ROOT, entry.path, 'migration.sql'))) === entry.sha256, entry.name);
  const m26Sql = readFileSync(join(ROOT, M26.path, 'migration.sql'));
  evidence.m26 = { name: M26.name, sha256: sha(m26Sql), bytes: m26Sql.length };
  const schemaCandidate = readFileSync(join(ROOT, M26.candidateSchema));
  evidence.candidateSchemaSha256 = sha(schemaCandidate);
  if (M26.sha256 !== 'M26_SHA256_PIN') check('m26-bytes-pinned', evidence.m26.sha256 === M26.sha256, evidence.m26.sha256);
  if (M26.candidateSchemaSha256 !== 'SCHEMA_SHA256_PIN') check('candidate-schema-pinned', evidence.candidateSchemaSha256 === M26.candidateSchemaSha256, evidence.candidateSchemaSha256);
  check('m26-readdir-is-only-migration-sql', JSON.stringify(readdirSync(join(ROOT, M26.path))) === JSON.stringify(['migration.sql']), readdirSync(join(ROOT, M26.path)));
  check('recovery-review-manifest-pinned', sha(readFileSync(join(ROOT, RECOVERY_REVIEW.path))) === RECOVERY_REVIEW.sha256, RECOVERY_REVIEW.sha256.slice(0, 12));
  const tracked = run('git', ['show', 'HEAD:prisma/schema.prisma'], { cwd: ROOT }).stdout;
  check('tracked-schema-is-the-m25-schema-unchanged', sha(readFileSync(join(ROOT, 'prisma/schema.prisma'))) === sha(tracked), 'working tree equals HEAD');
  const sqlText = m26Sql.toString('utf8');
  check('m26-uses-the-new-enum-value-exactly-once-as-ADD-VALUE', (sqlText.match(/VERIFY_UPLOADED_MEDIA/g) ?? []).length === 1 && /ALTER TYPE "JobType" ADD VALUE 'VERIFY_UPLOADED_MEDIA';/.test(sqlText), 'no later statement references the new value');
  const statements = sqlText.split('\n').filter(l => !l.startsWith('--')).join('\n').split(/;\s*(?:\n|$)/).map(t => t.trim()).filter(Boolean);
  const shapes = [/^CREATE TYPE "MediaVerification(Source|Status)" AS ENUM \(/, /^ALTER TYPE "JobType" ADD VALUE 'VERIFY_UPLOADED_MEDIA'$/, /^CREATE TABLE "MediaVerification" \(/, /^CREATE (UNIQUE )?INDEX "MediaVerification_[A-Za-z_]+" ON "MediaVerification"\(/, /^ALTER TABLE "MediaVerification" ADD CONSTRAINT "MediaVerification_[A-Za-z]+_fkey" FOREIGN KEY /];
  const unexpected = statements.filter(t => !shapes.some(rx => rx.test(t)));
  check('m26-is-additive-only-every-statement-matches-an-allowed-creation-shape', statements.length === 17 && unexpected.length === 0, { statements: statements.length, unexpected: unexpected.map(t => t.slice(0, 60)) });

  // ---- disposable G1 postgres (own container, loopback, random credentials)
  const password = randomBytes(18).toString('hex'); secrets.add(password);
  const started = run('docker', ['run', '-d', '--name', CONTAINER, '--label', 'annotation.safety=g1-disposable', '--label', 'annotation.role=postgres', '-p', `127.0.0.1:${PORT}:5432`, '-e', 'POSTGRES_USER=postgres', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=fieldframe', '--tmpfs', '/var/lib/postgresql/data', 'postgres:16-alpine']);
  must(started.status === 0, 'POSTGRES_NOT_STARTED', redact(started.stderr).slice(0, 200)); owned.push(CONTAINER);
  for (let i = 0; i < 90; i += 1) { if (run('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'fieldframe', '-tAc', 'select 1']).status === 0) break; run('sleep', ['1']); }
  run('sleep', ['3']);
  must(run('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'fieldframe', '-tAc', 'select 1']).status === 0, 'POSTGRES_NOT_READY');
  const inspected = JSON.parse(run('docker', ['inspect', CONTAINER]).stdout)[0];
  const pin = { name: CONTAINER, id: inspected.Id, role: 'postgres', port: PORT, internalPort: 5432 };
  pin.systemIdentifier = run('docker', ['exec', CONTAINER, 'sh', '-c', 'LC_ALL=C pg_controldata "$PGDATA"']).stdout.match(/^Database system identifier:\s+(\d+)/m)?.[1];
  check('target-is-a-fresh-disposable-db-not-the-application-or-mvp-db', pin.systemIdentifier && pin.systemIdentifier !== guard.applicationSystem, { systemIdentifier: pin.systemIdentifier, port: PORT });
  const url = `postgresql://postgres:${password}@127.0.0.1:${PORT}/fieldframe`;
  const psql = (sql, { readonly = true, db = 'fieldframe' } = {}) => {
    const r = run('docker', ['exec', '-i', ...(readonly ? ['-e', 'PGOPTIONS=-c default_transaction_read_only=on'] : []), CONTAINER, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db], { input: sql });
    return { ok: r.status === 0, out: r.stdout.trim(), err: redact(r.stderr).trim() };
  };
  const q = sql => { const r = psql(sql); must(r.ok, 'PSQL_FAILED', r.err.slice(0, 200)); return r.out; };

  const stage = (label, migrations, schemaBytes) => {
    const dir = mkdtempSync(join(tmpdir(), `a2chain-${label}-`)); chmodSync(dir, 0o700); stages.push(dir);
    mkdirSync(join(dir, 'migrations'));
    for (const name of migrations.names) cpSync(join(migrations.from(name), name), join(dir, 'migrations', name), { recursive: true });
    cpSync(join(migrationsDir, 'migration_lock.toml'), join(dir, 'migrations/migration_lock.toml'));
    writeFileSync(join(dir, 'schema.prisma'), schemaBytes);
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'prisma.config.ts'), `import {defineConfig} from ${JSON.stringify(join(ROOT, 'node_modules/prisma/config.js'))}; export default defineConfig(${JSON.stringify({ schema: join(dir, 'schema.prisma'), migrations: { path: join(dir, 'migrations') }, engine: 'classic', datasource: { url } })});`, { mode: 0o600 });
    return dir;
  };
  const deploy = (dir, label) => {
    const request = { config: join(dir, 'prisma.config.ts'), configSha256: sha(readFileSync(join(dir, 'prisma.config.ts'))), operation: 'deploy', postgres: pin, schemaSha256: sha(readFileSync(join(dir, 'schema.prisma'))), migrationHashes: Object.fromEntries(guard.migrationFiles(join(dir, 'migrations')).map(file => [file, sha(readFileSync(file))])) };
    const requestPath = join(dir, `${label}-request.json`), receiptPath = join(dir, `${label}-receipt.json`);
    writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
    const approved = run(process.execPath, [join(ROOT, 'scripts/db-safety/approve-disposable.mjs'), requestPath, receiptPath], { env: base, cwd: ROOT });
    must(approved.status === 0, 'RECEIPT_ISSUE_FAILED', redact(approved.stdout + approved.stderr).slice(0, 300));
    const d = run(process.execPath, [join(ROOT, 'scripts/db-safety/cli.mjs'), 'deploy'], { env: { ...base, DB_SAFETY_RECEIPT: receiptPath }, cwd: ROOT });
    const out = redact(d.stdout + d.stderr);
    return { status: d.status, applied: [...out.matchAll(/Applying migration `([^`]+)`/g)].map(m => m[1]), noPending: /No pending migrations/.test(out), lines: out.split('\n').filter(l => /Applying migration|No pending|migration|Error/.test(l)).slice(-8) };
  };
  const history = () => JSON.parse(q(`SELECT coalesce(json_agg(json_build_object('name',migration_name,'checksum',checksum,'finished',finished_at IS NOT NULL,'rolledBack',rolled_back_at IS NOT NULL) ORDER BY started_at, migration_name),'[]'::json) FROM _prisma_migrations`));
  const catalog = () => {
    const rows = JSON.parse(q(manifestSql(ROOT)));
    const detail = {
      tables: JSON.parse(q(`SELECT coalesce(json_agg(tablename ORDER BY tablename),'[]'::json) FROM pg_tables WHERE schemaname='public'`)),
      columns: JSON.parse(q(`SELECT coalesce(json_agg(json_build_array(table_name,column_name,data_type,udt_name,is_nullable,column_default) ORDER BY table_name, ordinal_position),'[]'::json) FROM information_schema.columns WHERE table_schema='public'`)),
      indexes: JSON.parse(q(`SELECT coalesce(json_agg(json_build_array(tablename,indexname,indexdef) ORDER BY tablename, indexname),'[]'::json) FROM pg_indexes WHERE schemaname='public'`)),
      constraints: JSON.parse(q(`SELECT coalesce(json_agg(json_build_array(conrelid::regclass::text,conname,contype::text,pg_get_constraintdef(oid)) ORDER BY conrelid::regclass::text, conname),'[]'::json) FROM pg_constraint WHERE connamespace='public'::regnamespace`)),
      enums: JSON.parse(q(`SELECT coalesce(json_agg(json_build_array(t.typname,e.enumlabel,e.enumsortorder::text) ORDER BY t.typname, e.enumsortorder),'[]'::json) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typnamespace='public'::regnamespace`)),
      triggers: JSON.parse(q(`SELECT coalesce(json_agg(json_build_array(tgrelid::regclass::text,tgname) ORDER BY tgrelid::regclass::text, tgname),'[]'::json) FROM pg_trigger WHERE NOT tgisinternal`)),
    };
    return { manifestEntries: rows.length, manifestDigest: manifestDigest(rows), manifestRows: rows, detail };
  };
  const names25 = active;
  const promoted = new Set(PROPOSAL_CHAIN.map(e => e.name));
  void promoted;

  // ===== Stage A: the unchanged 25-migration chain with the unchanged tracked schema (receipt-bound deploy)
  check('database-is-genuinely-empty', q(`SELECT count(*) FROM pg_tables WHERE schemaname='public'`) === '0', 'no public tables');
  const stageA = stage('25', { names: names25, from: () => migrationsDir }, readFileSync(join(ROOT, 'prisma/schema.prisma')));
  const depA = deploy(stageA, 'chain25');
  check('deploy-25-succeeded-through-the-guarded-path', depA.status === 0 && depA.applied.length === 25, { status: depA.status, applied: depA.applied.length });
  const h25 = history();
  check('history-25-finished-none-rolled-back-names-and-checksums-equal-the-files', h25.length === 25 && h25.every((row, i) => row.finished && !row.rolledBack && row.name === names25[i] && row.checksum === sha(readFileSync(join(migrationsDir, row.name, 'migration.sql'))) ), { rows: h25.length });
  check('m24-m25-recorded-checksums-exact-before-m26', PROPOSAL_CHAIN.every(entry => h25.find(row => row.name === entry.name)?.checksum === entry.sha256), PROPOSAL_CHAIN.map(e => e.name));
  const before = catalog();
  check('before-manifest-is-the-reviewed-1842-entries', before.manifestEntries === RELEASE_COUNTS.m25, { entries: before.manifestEntries, digest: before.manifestDigest });
  evidence.before = { entries: before.manifestEntries, digest: before.manifestDigest, jobTypeEnum: before.detail.enums.filter(e => e[0] === 'JobType').map(e => e[1]) };
  check('before-state-has-no-media-verification-objects', !before.detail.tables.includes('MediaVerification') && !before.detail.enums.some(e => /MediaVerification|VERIFY_UPLOADED_MEDIA/.test(e[0] + e[1])), 'absent');

  // ===== Stage B: the candidate as the 26th migration, with the candidate schema (receipt-bound deploy of exactly one pending migration)
  const stageB = stage('26', { names: [...names25, M26.name], from: name => (name === M26.name ? join(ROOT, PROPOSAL_DIR) : migrationsDir) }, schemaCandidate);
  const depB = deploy(stageB, 'chain26');
  check('deploy-26-applies-exactly-the-candidate', depB.status === 0 && depB.applied.length === 1 && depB.applied[0] === M26.name, { status: depB.status, applied: depB.applied, lines: depB.lines });
  const h26 = history();
  const expected26 = [...names25, M26.name];
  check('history-26-finished-none-rolled-back-in-order', h26.length === 26 && h26.every((row, i) => row.finished && !row.rolledBack && row.name === expected26[i]), { rows: h26.length });
  check('m24-m25-checksums-unchanged-after-m26', PROPOSAL_CHAIN.every(entry => h26.find(row => row.name === entry.name)?.checksum === entry.sha256) && h26.slice(0, 25).every((row, i) => row.checksum === h25[i].checksum), 'identical to the 25-run');
  check('m26-recorded-checksum-equals-the-candidate-file', h26[25].checksum === evidence.m26.sha256, evidence.m26.sha256.slice(0, 16));
  const after = catalog();
  evidence.after = { entries: after.manifestEntries, digest: after.manifestDigest };
  if (A2_COUNTS.m26 !== 'M26_COUNT_PIN') check('after-manifest-count-pinned', after.manifestEntries === A2_COUNTS.m26, { entries: after.manifestEntries });

  // schema diff: only additions, exactly the frozen object set
  const keyed = rows => new Set(rows.map(r => JSON.stringify(r)));
  const removedOrChanged = [];
  for (const kind of ['tables', 'columns', 'indexes', 'constraints', 'triggers']) { const a = keyed(after.detail[kind].map(x => (Array.isArray(x) ? x : [x]))); for (const row of before.detail[kind]) if (!a.has(JSON.stringify(Array.isArray(row) ? row : [row]))) removedOrChanged.push([kind, row]); }
  const beforeEnums = before.detail.enums.map(e => `${e[0]}:${e[1]}`);
  const afterEnums = after.detail.enums.map(e => `${e[0]}:${e[1]}`);
  check('no-existing-schema-object-removed-or-changed', removedOrChanged.length === 0, removedOrChanged.slice(0, 3));
  const newTables = after.detail.tables.filter(t => !before.detail.tables.includes(t));
  check('exactly-one-new-table-MediaVerification', JSON.stringify(newTables) === JSON.stringify(['MediaVerification']), newTables);
  const newCols = after.detail.columns.filter(c => c[0].replace(/"/g, '') === 'MediaVerification').map(c => c[1]);
  check('table-has-exactly-the-frozen-43-columns-in-contract-order', JSON.stringify(newCols) === JSON.stringify(EXPECTED_COLUMNS), { columns: newCols.length });
  const addedIdx = after.detail.indexes.filter(i => i[0] === 'MediaVerification').map(i => i[1]).sort();
  check('exactly-the-frozen-indexes-pk-4-uniques-incl-sealedKey-assetId-and-4-indexes', JSON.stringify(addedIdx) === JSON.stringify([...EXPECTED_INDEXES].sort()) && addedIdx.length === 9, addedIdx);
  const uniqueDefs = after.detail.indexes.filter(i => i[0] === 'MediaVerification' && /UNIQUE/.test(i[2]) && !/_pkey$/.test(i[1])).map(i => i[1]).sort();
  check('four-unique-indexes', JSON.stringify(uniqueDefs) === JSON.stringify(['MediaVerification_assetId_key', 'MediaVerification_preparedImportItemId_generation_key', 'MediaVerification_sealedKey_key', 'MediaVerification_stagedBucket_stagedKey_generation_key']), uniqueDefs);
  const fks = after.detail.constraints.filter(c => c[0].replace(/"/g, '') === 'MediaVerification' && c[2] === 'f').map(c => [c[1], /ON DELETE (SET NULL|CASCADE|RESTRICT)/.exec(c[3])?.[1] ?? 'NO ACTION']).sort((a, b) => a[0].localeCompare(b[0]));
  check('exactly-the-five-frozen-foreign-keys-with-their-delete-actions', JSON.stringify(fks) === JSON.stringify(EXPECTED_FKS), fks);
  check('no-check-constraint-or-trigger-added-by-m26', after.detail.constraints.filter(c => c[0].replace(/"/g, '') === 'MediaVerification' && c[2] === 'c').length === 0 && JSON.stringify(after.detail.triggers) === JSON.stringify(before.detail.triggers), 'frozen contract: no DB-level verification invariant');
  const newEnums = afterEnums.filter(e => !beforeEnums.includes(e));
  check('exactly-two-new-enum-types-plus-one-JobType-value', JSON.stringify(newEnums.sort()) === JSON.stringify(['JobType:VERIFY_UPLOADED_MEDIA', 'MediaVerificationSource:DIRECT_UPLOAD', 'MediaVerificationSource:LOCAL_FOLDER_ITEM', 'MediaVerificationStatus:CANCELED', 'MediaVerificationStatus:EXPIRED', 'MediaVerificationStatus:PENDING', 'MediaVerificationStatus:PUBLISHED', 'MediaVerificationStatus:REJECTED', 'MediaVerificationStatus:SEALED', 'MediaVerificationStatus:STALE', 'MediaVerificationStatus:VERIFIED'].sort()), newEnums);
  evidence.schemaDiff = { newTables, columnCount: newCols.length, indexes: addedIdx, foreignKeys: fks, newEnumLabels: newEnums, manifestEntriesBefore: before.manifestEntries, manifestEntriesAfter: after.manifestEntries };

  // ---- enum-value ordering/visibility proofs (PostgreSQL)
  const jobBefore = before.detail.enums.filter(e => e[0] === 'JobType').map(e => e[1]);
  const jobAfter = after.detail.enums.filter(e => e[0] === 'JobType').map(e => e[1]);
  check('JobType-existing-labels-keep-their-relative-order-new-label-is-last', JSON.stringify(jobAfter.slice(0, jobBefore.length)) === JSON.stringify(jobBefore) && jobAfter.at(-1) === 'VERIFY_UPLOADED_MEDIA' && jobAfter.length === jobBefore.length + 1, { before: jobBefore.length, after: jobAfter.length });
  const sortOrders = JSON.parse(q(`SELECT json_agg(enumsortorder::float8 ORDER BY enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='JobType'`));
  check('new-JobType-label-sorts-after-every-existing-label', sortOrders.at(-1) > sortOrders.at(-2) && sortOrders.every((v, i, a) => i === 0 || v > a[i - 1]), { last: sortOrders.at(-1), previous: sortOrders.at(-2) });
  const usable = psql(`SELECT 'VERIFY_UPLOADED_MEDIA'::"JobType"::text`);
  check('new-value-is-usable-after-the-migration-committed', usable.ok && usable.out === 'VERIFY_UPLOADED_MEDIA', usable.out || usable.err);
  const scratch = psql(`CREATE TYPE a2_enum_probe AS ENUM ('a'); BEGIN; ALTER TYPE a2_enum_probe ADD VALUE 'b'; SELECT 'b'::a2_enum_probe; ROLLBACK;`, { readonly: false });
  check('postgres-refuses-to-USE-a-new-enum-value-in-the-transaction-that-adds-it-so-the-migration-must-not-and-does-not', !scratch.ok && /unsafe use of new value/.test(scratch.err), scratch.err.split('\n')[0]);
  psql(`ROLLBACK; DROP TYPE IF EXISTS a2_enum_probe;`, { readonly: false });
  check('probe-type-removed', q(`SELECT count(*) FROM pg_type WHERE typname='a2_enum_probe'`) === '0', 'scratch type dropped');

  // ---- replay, status and drift against the candidate schema
  const depReplay = deploy(stageB, 'chain26-replay');
  check('replay-deploy-is-a-no-op', depReplay.status === 0 && depReplay.applied.length === 0 && depReplay.noPending, depReplay.lines);
  check('history-unchanged-by-replay', JSON.stringify(history()) === JSON.stringify(h26), 'identical');
  const prismaCli = join(ROOT, 'node_modules/prisma/build/index.js');
  const status = run(process.execPath, [prismaCli, 'migrate', 'status', '--config', join(stageB, 'prisma.config.ts')], { env: { ...base, DATABASE_URL: url }, cwd: ROOT });
  check('prisma-migrate-status-up-to-date-with-26', status.status === 0 && /Database schema is up to date/.test(status.stdout + status.stderr) && /26 migrations found/.test(status.stdout + status.stderr), redact(status.stdout + status.stderr).split('\n').filter(l => l.trim()).slice(-4));
  const drift = run(process.execPath, [prismaCli, 'migrate', 'diff', '--config', join(stageB, 'prisma.config.ts'), '--from-url', url, '--to-schema-datamodel', join(stageB, 'schema.prisma'), '--exit-code'], { env: { ...base, DATABASE_URL: url }, cwd: stageB });
  check('no-drift-between-the-migrated-database-and-the-candidate-schema', drift.status === 0, { exit: drift.status, out: redact(drift.stdout).split('\n').filter(l => l.trim()).slice(-3) });
  evidence.result = 'PASS';
  evidence.afterDigest = after.manifestDigest;
  return { url, psql, q, stageB, catalogAfter: after };
}

let ctx = null;
try { ctx = await main(); } catch (error) { evidence.result = 'FAIL'; evidence.failure = { code: error.message, detail: error.detail ?? null }; }
finally {
  // client compatibility runs while the database still exists (only when the chain proof passed)
  if (ctx && evidence.result === 'PASS') {
    try {
      const probe = run(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/db-safety/a2-chain-client-probe.mts')], { env: { ...base, A2_PROBE_DATABASE_URL: ctx.url, A2_PROBE_SCHEMA: join(ctx.stageB, 'schema.prisma'), A2_PROBE_ROOT: ROOT }, cwd: ROOT });
      evidence.clientCompatibility = { status: probe.status, report: redact(probe.stdout).trim().split('\n').slice(-30), stderrTail: redact(probe.stderr).trim().split('\n').slice(-6) };
      check('generated-client-and-old-client-compatibility-probe', probe.status === 0, evidence.clientCompatibility.report.slice(-6));
    } catch (error) { evidence.result = 'FAIL'; evidence.failure = { code: error.message, detail: error.detail ?? null }; }
  }
  for (const name of owned.reverse()) run('docker', ['rm', '-fv', name]);
  for (const dir of stages) rmSync(dir, { recursive: true, force: true });
  evidence.cleanup = { removed: owned.length, remaining: run('docker', ['ps', '-a', '--format', '{{.Names}}', '--filter', 'name=phase029-g1-a2chain']).stdout.trim().split('\n').filter(Boolean) };
  evidence.finishedAt = new Date().toISOString();
  const out = resolve(join(ROOT, 'specs/029-modality-specific-datasets/verification/a2-m26', `a2-chain-${evidence.startedAt.replace(/[-:.]/g, '').slice(0, 15)}Z`));
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const text = JSON.stringify(evidence, null, 2) + '\n';
  for (const s of secrets) must(!text.includes(s), 'SECRET_IN_EVIDENCE');
  writeFileSync(join(out, 'a2-chain.json'), text, { mode: 0o400, flag: 'wx' });
  console.log(JSON.stringify({ result: evidence.result, out, failure: evidence.failure, m26: evidence.m26, before: evidence.before && { entries: evidence.before.entries, digest: evidence.before.digest }, after: evidence.after, checks: evidence.checks.map(c => `${c.pass ? 'PASS' : 'FAIL'} ${c.id}`), cleanup: evidence.cleanup }, null, 2));
  process.exitCode = evidence.result === 'PASS' ? 0 : 1;
}
