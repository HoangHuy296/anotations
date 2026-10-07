import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  ROOT, CLIENT_DIR, SCHEMA_PATH, FIELD, ENGINE_FILE, CHANGED_ALLOWLIST, PROMOTION_ALLOWLIST, DUMMY_DATABASE_URL, CONFIRM, STAGE_PREFIX, MIGRATION_25,
  applyApprovedChange, isSingleLineInsertion, canonicalizeClassFile, EXPECTED_PATH_OCCURRENCES, CLASS_FILE, collapse, readTree, treeHash, compareTrees, inspectGenerated, verifyCorrespondence,
  semanticAddColumn, buildEnv, configText, assertAllowedSpawn, prismaCli, prismaVersionEvidence, stageGeneration, promoteStaged, safeTarget,
} from '../prisma-client-stage.mjs';

import { execFileSync } from 'node:child_process';
// The "post-promotion" facts below are historical claims about the M25 snapshot of the schema/client/chain. They are anchored to that immutable commit instead of
// the working tree, so the A2 promotion of M26 (which legitimately changes the tracked schema, client and chain) does not rewrite what M25 was proven to be.
const M25_COMMIT = 'c46c928e07a5cfeac2672532066a28bea3755c52';
let m25SnapshotRoot = null;
const M25_ROOT = () => {
  if (m25SnapshotRoot) return m25SnapshotRoot;
  const dir = mkdtempSync(join(tmpdir(), 'm25-snapshot-'));
  const archive = execFileSync('git', ['archive', M25_COMMIT, '--', 'lib/generated', 'prisma/schema.prisma', 'prisma/migrations'], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: archive });
  return (m25SnapshotRoot = dir);
};
// Offline only. A fake Prisma CLI (injected spawn) writes a deterministic fake client into the private stage; no real Prisma,
// database client, container tool or network is used by these tests.
const sha = value => createHash('sha256').update(value).digest('hex');
const SCHEMA = `generator client {
  provider = "prisma-client"
  output   = "../lib/generated/prisma"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model PreparedImport {
  id                String               @id @default(cuid())
  committedAt       DateTime?
  idempotencyKey    String
  createdAt         DateTime             @default(now())
}

model Other {
  id String @id
}
`;
const M25_BYTES = readFileSync(join(ROOT, MIGRATION_25.path));

// ---- fake generator -------------------------------------------------------------------------------------------------
function fakeGenerate(schemaText, outDir, mode = {}, counter = { n: 0 }) {
  const has = schemaText.includes(`${FIELD.name} String?`);
  const schemaPath = join(dirname(dirname(dirname(outDir))), 'prisma/schema.prisma');
  const generated = outDir.startsWith('/tmp/phase029-prisma-stage-');
  const put = (rel, text) => { mkdirSync(dirname(join(outDir, rel)), { recursive: true }); writeFileSync(join(outDir, rel), text); };
  put('client.ts', 'export const client = 1;   \n');
  put('models.ts', 'export {};\t\n');
  for (let index = 0; index < 8; index += 1) {
    if (mode.deleteFile && has && index === 3) continue;
    const stray = mode.otherFilePath && generated && index === 0 ? `// ${outDir}\n` : '';
    const text = stray + `export const m${index} = ${mode.fifthChanged && has && index === 5 ? 'changed' : mode.currentDiffers && !has && index === 1 ? 'differs' : 'same'};   \n`;
    put(`models/M${index}.ts`, text);
  }
  put('models/PreparedImport.ts', `export type Hash = ${has && !mode.missingChange ? 'string | null' : 'never'};${mode.nondeterministic && has ? ` // run ${counter.n++}` : ''}  \n`);
  const enumBlock = `export const PreparedImportScalarFieldEnum = {\n  id: 'id',\n  idempotencyKey: 'idempotencyKey'${has ? ",\n  creationRequestHash: 'creationRequestHash'" : ''}\n} as const\n`;
  put('internal/prismaNamespace.ts', enumBlock + '   \n');
  put('internal/prismaNamespaceBrowser.ts', enumBlock);
  const fields = [{ name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false }, ...(has ? [{ name: FIELD.name, kind: 'scalar', type: 'String', isRequired: false, isList: false }] : [])];
  const aligned = schemaText.split('\n').map(line => line.replace(/ +/g, '   ')).join('\n');
  const pathLines = [
    mode.missingPath && generated ? null : `    "value": ${JSON.stringify(outDir)},`,
    mode.duplicatePath && generated ? `    "value": ${JSON.stringify(outDir)},` : null,
    `    "sourceFilePath": ${JSON.stringify(schemaPath)},`,
    mode.strayStagePath && generated ? '    "extra": "/tmp/phase029-prisma-stage-leak/elsewhere",' : null,
    mode.genericAbsolute ? '    "generic": "/home/other/project/schema.prisma", "tmpOnly": "/tmp/unrelated/x"' : null,
  ].filter(Boolean).join('\n');
  put('internal/class.ts', `const config = {\n${pathLines}\n  "inlineSchema": ${JSON.stringify(aligned)},\n  "inlineSchemaHash": "${sha(schemaText)}"\n}\nconfig.runtimeDataModel = JSON.parse(${JSON.stringify(JSON.stringify({ models: { PreparedImport: { fields } } }))})\n`);
  if (mode.extraFile && has) put('models/Extra.ts', 'export {};\n');
  writeFileSync(join(outDir, ENGINE_FILE), mode.engineChanged && has ? Buffer.from([9, 9, 9]) : Buffer.from([1, 2, 3, 4]));
}

function fixture(mode = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ps-root-'));
  const put = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  put('pnpm-lock.yaml', "lockfileVersion: '9.0'\n\npackages:\n\n  prisma@6.19.3:\n    resolution: {integrity: x}\n");
  put('package.json', JSON.stringify({ devDependencies: { prisma: '^6.19.3' } }));
  put('node_modules/prisma/package.json', JSON.stringify({ name: 'prisma', version: '6.19.3' }));
  put('node_modules/prisma/build/index.js', '');
  put('node_modules/prisma/config.js', '');
  put(SCHEMA_PATH, SCHEMA);
  put('prisma/migrations/20260101000_a/migration.sql', 'SELECT 1;\n');
  put('prisma/migrations/migration_lock.toml', 'provider = "postgresql"\n');
  put('prisma/migrations/20260930030000_dataset_modality_g2/migration.sql', 'SELECT 24;\n');
  mkdirSync(join(root, dirname(MIGRATION_25.path)), { recursive: true });
  writeFileSync(join(root, MIGRATION_25.path), M25_BYTES);
  put('.env', 'DATABASE_URL=postgresql://app:secret@10.9.9.9:5432/appdb\n');
  put('prisma.config.ts', 'throw new Error("ROOT_CONFIG_MUST_NOT_BE_LOADED");\n');
  put('apps/web/src/untouched.ts', 'export const untouched = true;\n');
  const client = join(root, CLIENT_DIR);
  fakeGenerate(SCHEMA, client, mode.tracked ?? {}); // raw generator representation (trailing whitespace kept): no normalization
  return root;
}
const snapshot = root => { const files = []; const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const full = join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (entry.isSymbolicLink()) files.push(`${relative(root, full)}->link`); else files.push(`${relative(root, full)}:${sha(readFileSync(full))}`); } }; walk(root); return files.sort().join('\n'); };

function harness(root, mode = {}, options = {}) {
  const calls = [], configs = [], counter = { n: 0 };
  const deps = {
    root,
    spawn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts: { ...opts, env: { ...opts.env } } });
      if (args[1] === 'generate') {
        const config = readFileSync(args[3], 'utf8');
        configs.push(config);
        const schemaPath = JSON.parse(`"${/"schema":"([^"]+)"/.exec(config)[1]}"`);
        fakeGenerate(readFileSync(schemaPath, 'utf8'), join(dirname(schemaPath), '..', CLIENT_DIR), mode, counter);
        return { status: 0, stdout: 'generated', stderr: '' };
      }
      if (args[1] === 'migrate') { configs.push(readFileSync(args[4], 'utf8')); return { status: 0, stdout: options.diffOutput ?? `-- AlterTable\nALTER TABLE "PreparedImport" ADD COLUMN     "creationRequestHash" TEXT;\n`, stderr: '' }; }
      return { status: 99, stdout: '', stderr: 'UNEXPECTED' };
    },
    mkStage: () => { const dir = mkdtempSync(STAGE_PREFIX); chmodSync(dir, 0o700); return dir; },
    now: () => new Date('2026-10-05T00:00:00Z'),
  };
  return { deps, calls, configs };
}
const cleanupRoot = root => rmSync(root, { recursive: true, force: true });

// ---- pure helpers ---------------------------------------------------------------------------------------------------
test('applyApprovedChange inserts exactly one line after idempotencyKey inside PreparedImport and refuses ambiguity', () => {
  const next = applyApprovedChange(SCHEMA);
  assert.ok(isSingleLineInsertion(SCHEMA, next));
  assert.equal(next.split('\n').length, SCHEMA.split('\n').length + 1);
  const lines = next.split('\n');
  assert.equal(lines[lines.indexOf(FIELD.line) - 1].trim().startsWith('idempotencyKey'), true);
  assert.throws(() => applyApprovedChange(next), /CHANGE_ALREADY_APPLIED/);
  assert.throws(() => applyApprovedChange(SCHEMA.replace('model PreparedImport {', 'model Renamed {')), /SCHEMA_MODEL_NOT_FOUND_OR_AMBIGUOUS/);
  assert.throws(() => applyApprovedChange(SCHEMA + SCHEMA.slice(SCHEMA.indexOf('model PreparedImport'), SCHEMA.indexOf('model Other'))), /SCHEMA_MODEL_NOT_FOUND_OR_AMBIGUOUS/);
  assert.throws(() => applyApprovedChange(SCHEMA.replace('  idempotencyKey    String\n', '')), /SCHEMA_ANCHOR_NOT_FOUND/);
  assert.equal(isSingleLineInsertion(SCHEMA, next + '\nextra'), false);
  assert.equal(isSingleLineInsertion(SCHEMA, SCHEMA.replace('committedAt', 'committedAt2')), false);
});

test('post-promotion: the real canonical schema contains exactly the approved one-line change (removing it restores the audited pre-state hash)', () => {
  const real = readFileSync(join(M25_ROOT(), SCHEMA_PATH), 'utf8');
  assert.throws(() => applyApprovedChange(real), /CHANGE_ALREADY_APPLIED/, 'the change is already applied');
  const start = real.indexOf('model PreparedImport {');
  const block = real.slice(start, real.indexOf('\n}', start));
  assert.match(block, /idempotencyKey\s+String\n  creationRequestHash String\?\n/);
  assert.equal(real.split('\n').filter(line => line === FIELD.line).length, 1);
  const pre = real.replace(`\n${FIELD.line}`, '');
  assert.ok(isSingleLineInsertion(pre, real));
  assert.equal(sha(pre), 'a013d71ae7771476b1770c3962f6bfe366856482365ed29d0bc8f6d7941ba793', 'without the one line the schema is byte-identical to the audited pre-promotion schema');
  assert.equal(applyApprovedChange(pre), real);
});

test('canonicalizeClassFile rewrites ONLY the two audited stage paths, with exact occurrence counts, and fails closed otherwise', () => {
  const stage = `${STAGE_PREFIX}t1/current`, repo = '/repo';
  const paths = { stageOutput: `${stage}/lib/generated/prisma`, stageSchema: `${stage}/prisma/schema.prisma`, repoOutput: `${repo}/lib/generated/prisma`, repoSchema: `${repo}/prisma/schema.prisma` };
  const raw = `{\n  "value": "${paths.stageOutput}",\n  "sourceFilePath": "${paths.stageSchema}"\n}\n`;
  assert.deepEqual(EXPECTED_PATH_OCCURRENCES, { output: 1, schema: 1 });
  const ok = canonicalizeClassFile(raw, paths);
  assert.equal(ok.canonical, `{\n  "value": "${repo}/lib/generated/prisma",\n  "sourceFilePath": "${repo}/prisma/schema.prisma"\n}\n`);
  assert.deepEqual(ok.discovered, { output: 1, schema: 1 }); assert.ok(!ok.canonical.includes(STAGE_PREFIX));
  // missing, wrong-count and duplicated expected paths
  assert.throws(() => canonicalizeClassFile(raw.replace(paths.stageOutput, '/somewhere/else'), paths), /CLASS_PATH_OCCURRENCES_UNEXPECTED/, 'missing output path');
  assert.throws(() => canonicalizeClassFile(raw.replace(paths.stageSchema, '/somewhere/else'), paths), /CLASS_PATH_OCCURRENCES_UNEXPECTED/, 'missing schema path');
  assert.throws(() => canonicalizeClassFile(raw + `"again": "${paths.stageOutput}"\n`, paths), /CLASS_PATH_OCCURRENCES_UNEXPECTED/, 'duplicated output path');
  assert.throws(() => canonicalizeClassFile(raw + `"again": "${paths.stageSchema}"\n`, paths), /CLASS_PATH_OCCURRENCES_UNEXPECTED/, 'duplicated schema path');
  assert.throws(() => canonicalizeClassFile('', paths), /CLASS_PATH_OCCURRENCES_UNEXPECTED/, 'no path at all');
  // an unexpected private-stage path remains after canonicalization
  assert.throws(() => canonicalizeClassFile(raw + `"stray": "${STAGE_PREFIX}other/leak"\n`, paths), /STAGE_PATH_REMAINS/);
  // invalid canonical targets / non-stage sources
  assert.throws(() => canonicalizeClassFile(raw, { ...paths, repoOutput: `${STAGE_PREFIX}x/lib/generated/prisma` }), /CANONICAL_PATHS_INVALID/);
  assert.throws(() => canonicalizeClassFile('"/home/user/lib/generated/prisma" "/home/user/prisma/schema.prisma"', { ...paths, stageOutput: '/home/user/lib/generated/prisma', stageSchema: '/home/user/prisma/schema.prisma' }), /CANONICAL_PATHS_INVALID/, 'only private-stage paths may be rewritten');
  // generic / unrelated absolute paths are never rewritten
  const generic = raw + '"home": "/home/other/project", "tmp": "/tmp/unrelated", "root": "/", "own": "/home/aioz-huy/anotations/lib/generated/prisma"\n';
  const kept = canonicalizeClassFile(generic, paths).canonical;
  for (const untouched of ['/home/other/project', '/tmp/unrelated', '"/"', '/home/aioz-huy/anotations/lib/generated/prisma']) assert.ok(kept.includes(untouched), untouched);
  // fixed-string replacement: regex metacharacters in a stage path are literal
  const odd = { ...paths, stageOutput: `${STAGE_PREFIX}a.b+c/current/lib/generated/prisma`, stageSchema: `${STAGE_PREFIX}a.b+c/current/prisma/schema.prisma` };
  assert.equal(canonicalizeClassFile(`"${odd.stageOutput}" "${odd.stageSchema}"`, odd).discovered.output, 1);
  assert.throws(() => canonicalizeClassFile(`"${STAGE_PREFIX}aXb+c/current/lib/generated/prisma" "${odd.stageSchema}"`, odd), /CLASS_PATH_OCCURRENCES_UNEXPECTED/);
});

test('canonicalization applied to the REAL tracked class.ts (stage paths substituted for the repository paths) restores it byte-for-byte; the audited counts hold', () => {
  const tracked = readFileSync(join(ROOT, CLIENT_DIR, CLASS_FILE), 'utf8');
  const stage = `${STAGE_PREFIX}real/current`;
  // The tracked client embeds the absolute path of the checkout it was generated in; read it from the file so the test is location-independent.
  const embeddedRoot = /"value": "([^"]+)\/lib\/generated\/prisma"/.exec(tracked)[1];
  const repoOutput = join(embeddedRoot, CLIENT_DIR), repoSchema = join(embeddedRoot, SCHEMA_PATH);
  assert.equal(tracked.split(repoOutput).length - 1, 1, 'the tracked class.ts has the output path exactly once');
  assert.equal(tracked.split(repoSchema).length - 1, 1, 'the tracked class.ts has the schema path exactly once');
  const raw = tracked.split(repoOutput).join(`${stage}/${CLIENT_DIR}`).split(repoSchema).join(`${stage}/${SCHEMA_PATH}`);
  assert.notEqual(raw, tracked);
  const { canonical, discovered } = canonicalizeClassFile(raw, { stageOutput: `${stage}/${CLIENT_DIR}`, stageSchema: `${stage}/${SCHEMA_PATH}`, repoOutput, repoSchema });
  assert.equal(canonical, tracked); assert.deepEqual(discovered, { output: 1, schema: 1 });
});

test('the tracked client keeps trailing whitespace and the helper never normalizes it (raw generator representation is authoritative)', () => {
  const root = fixture(), { deps } = harness(root);
  try {
    const trailing = readFileSync(join(root, CLIENT_DIR, 'models.ts'), 'utf8');
    assert.match(trailing, /[ \t]+\n/);
    const report = stageGeneration(deps, { keep: true });
    try {
      assert.equal(report.result, 'STAGED_OK');
      for (const tree of ['current', 'current-candidate', 'proposed', 'proposed-candidate']) assert.equal(readFileSync(join(report.stage, tree, CLIENT_DIR, 'models.ts'), 'utf8'), trailing, tree + ': whitespace untouched');
    } finally { rmSync(report.stage, { recursive: true, force: true }); }
    const source = readFileSync(join(ROOT, 'scripts/db-safety/prisma-client-stage.mjs'), 'utf8');
    assert.ok(!/normalize-generated|normalizeWhitespace|normalizeTree|sed -i/.test(source));
  } finally { cleanupRoot(root); }
});

const stageDirs = () => readdirSync('/tmp').filter(name => `/tmp/${name}`.startsWith(STAGE_PREFIX)).length;
test('stage: path-canonicalization anomalies fail closed (missing, duplicated, stray stage path, stage path in another file) and leave no stage or repository change', () => {
  const cases = { missingPath: /CLASS_PATH_OCCURRENCES_UNEXPECTED/, duplicatePath: /CLASS_PATH_OCCURRENCES_UNEXPECTED/, strayStagePath: /STAGE_PATH_REMAINS/, otherFilePath: /STAGE_PATH_IN_UNEXPECTED_FILE/ };
  for (const [mode, expected] of Object.entries(cases)) {
    const root = fixture(), { deps, calls } = harness(root, { [mode]: true });
    try {
      const before = snapshot(root), dirs = stageDirs();
      assert.throws(() => stageGeneration(deps), expected, mode);
      assert.equal(calls.length, 1, mode + ': stops at the baseline, the proposed client is never generated');
      assert.equal(snapshot(root), before, mode); assert.equal(stageDirs(), dirs, mode + ': stage removed');
    } finally { cleanupRoot(root); }
  }
});

test('stage: generic absolute paths in class.ts are preserved, not rewritten, and baseline reproduction still holds', () => {
  const root = fixture({ tracked: { genericAbsolute: true } }), { deps } = harness(root, { genericAbsolute: true });
  try {
    const report = stageGeneration(deps, { keep: true });
    try {
      assert.equal(report.result, 'STAGED_OK', JSON.stringify(report.steps));
      for (const tree of ['current-candidate', 'proposed-candidate']) { const text = readFileSync(join(report.stage, tree, CLIENT_DIR, CLASS_FILE), 'utf8'); assert.ok(text.includes('/home/other/project/schema.prisma') && text.includes('/tmp/unrelated/x'), tree); }
    } finally { rmSync(report.stage, { recursive: true, force: true }); }
  } finally { cleanupRoot(root); }
});

test('stage keeps raw generated bytes distinct from the canonicalized candidate and reports all three class.ts hashes', () => {
  const root = fixture(), { deps } = harness(root);
  try {
    const report = stageGeneration(deps, { keep: true });
    try {
      const raw = readFileSync(join(report.stage, 'proposed', CLIENT_DIR, CLASS_FILE), 'utf8'), candidate = readFileSync(join(report.stage, 'proposed-candidate', CLIENT_DIR, CLASS_FILE), 'utf8');
      assert.ok(raw.includes(`${report.stage}/proposed`), 'raw class.ts keeps the staging paths exactly as Prisma wrote them');
      assert.ok(!candidate.includes(STAGE_PREFIX) && candidate.includes(join(root, CLIENT_DIR)) && candidate.includes(join(root, SCHEMA_PATH)));
      assert.equal(report.manifest.staged.rawClassSha256, sha(raw)); assert.equal(report.manifest.staged.canonicalClassSha256, sha(candidate));
      assert.notEqual(sha(raw), sha(candidate));
      const baseline = report.steps[0].canonicalization;
      assert.match(baseline.rawClassSha256, /^[0-9a-f]{64}$/); assert.equal(baseline.trackedClassSha256, baseline.canonicalClassSha256);
      assert.equal(report.steps[1].canonicalization.canonicalClassSha256, sha(candidate));
      assert.equal(report.steps[2].rawClassSha256.length, 2); assert.notEqual(report.steps[2].rawClassSha256[0], report.steps[2].rawClassSha256[1], 'raw class.ts differs between runs by stage path only; the canonical candidates are identical');
    } finally { rmSync(report.stage, { recursive: true, force: true }); }
  } finally { cleanupRoot(root); }
});

test('post-promotion: the real tracked client corresponds to the real canonical schema and exposes creationRequestHash', () => {
  const real = readFileSync(join(M25_ROOT(), SCHEMA_PATH), 'utf8');
  const evidence = verifyCorrespondence(join(M25_ROOT(), CLIENT_DIR), real, true);
  assert.equal(evidence.inlineSchemaMatches, true); assert.equal(evidence.runtimeField.type, 'String'); assert.equal(evidence.runtimeField.isRequired, false);
  assert.equal(evidence.namespaceHasField, true); assert.equal(evidence.browserHasField, true);
  assert.throws(() => verifyCorrespondence(join(M25_ROOT(), CLIENT_DIR), real, false), /UNEXPECTED_FIELD_PRESENT/);
  assert.throws(() => verifyCorrespondence(join(M25_ROOT(), CLIENT_DIR), real.replace(`\n${FIELD.line}`, ''), true), /INLINE_SCHEMA_MISMATCH/, 'a schema without the field does not correspond to the promoted client');
  assert.equal(collapse('  a   b  \n c'), 'a b\nc');
  assert.equal(inspectGenerated(join(M25_ROOT(), CLIENT_DIR)).namespaceFields.includes('idempotencyKey'), true);
  assert.ok(!readFileSync(join(M25_ROOT(), CLIENT_DIR, CLASS_FILE), 'utf8').includes(STAGE_PREFIX), 'no staging path in the promoted class.ts');
});

test('semantic corroboration accepts only one nullable TEXT column addition and nothing else', () => {
  assert.ok(semanticAddColumn('-- AlterTable\nALTER TABLE "PreparedImport" ADD COLUMN     "creationRequestHash" TEXT;\n'));
  assert.ok(semanticAddColumn('ALTER TABLE "PreparedImport" ADD COLUMN "creationRequestHash" TEXT NULL;'));
  for (const bad of ['', 'ALTER TABLE "PreparedImport" ADD COLUMN "creationRequestHash" TEXT NOT NULL;', 'ALTER TABLE "PreparedImport" ADD COLUMN "creationRequestHash" TEXT DEFAULT \'\';', 'ALTER TABLE "PreparedImport" ADD COLUMN "other" TEXT;',
    'ALTER TABLE "PreparedImport" ADD COLUMN "creationRequestHash" TEXT;\nCREATE INDEX x ON "PreparedImport"("creationRequestHash");', 'ALTER TABLE "PreparedImport" ADD COLUMN "creationRequestHash" JSONB;',
    'ALTER TABLE "PreparedImport" ADD COLUMN "creationRequestHash" TEXT;\nALTER TABLE "PreparedImport" ADD COLUMN "b" TEXT;']) assert.equal(semanticAddColumn(bad), false, bad);
});

// ---- version pin ----------------------------------------------------------------------------------------------------
test('Prisma version evidence: installed CLI equals the repository lockfile pin (real repo) and mismatches fail closed', () => {
  const real = prismaVersionEvidence(ROOT);
  assert.equal(real.installed, '6.19.3'); assert.equal(real.lockfile, real.installed); assert.equal(real.declared, '^6.19.3'); assert.equal(real.cli, 'node_modules/prisma/build/index.js');
  const root = fixture();
  try {
    assert.equal(prismaVersionEvidence(root).installed, '6.19.3');
    writeFileSync(join(root, 'node_modules/prisma/package.json'), JSON.stringify({ version: '6.20.0' }));
    assert.throws(() => prismaVersionEvidence(root), /PRISMA_VERSION_NOT_PINNED/);
    writeFileSync(join(root, 'pnpm-lock.yaml'), "packages:\n  prisma@6.19.3:\n  prisma@6.20.0:\n");
    assert.throws(() => prismaVersionEvidence(root), /PRISMA_LOCK_ENTRY_NOT_UNIQUE/);
  } finally { cleanupRoot(root); }
});

// ---- Phase A --------------------------------------------------------------------------------------------------------
test('stage: reproduces the current client, produces exactly the four-file delta, is deterministic and corresponds to the proposed schema; the repository is untouched', async () => {
  const root = fixture(), { deps, calls } = harness(root);
  try {
    const before = snapshot(root);
    const report = stageGeneration(deps);
    assert.equal(report.result, 'STAGED_OK', JSON.stringify(report.steps));
    assert.deepEqual(report.steps.map(step => step.name), ['current-schema-reproduction', 'proposed-delta', 'second-generation-determinism', 'schema-correspondence', 'migration-25-semantic-corroboration']);
    assert.ok(report.steps.every(step => step.pass));
    const baseline = report.steps[0];
    assert.equal(baseline.trackedFiles, baseline.identicalFiles, 'every tracked file reproduced');
    assert.equal(baseline.rawIdenticalWithoutCanonicalization, baseline.trackedFiles - 1, 'all files except class.ts need no canonicalization');
    assert.deepEqual(baseline.canonicalization.expected, { output: 1, schema: 1 }); assert.deepEqual(baseline.canonicalization.discovered, { output: 1, schema: 1 });
    assert.notEqual(baseline.canonicalization.rawClassSha256, baseline.canonicalization.canonicalClassSha256, 'raw and canonical bytes are distinct and both reported');
    assert.equal(baseline.canonicalization.canonicalClassSha256, baseline.canonicalization.trackedClassSha256);
    assert.deepEqual(report.steps[1].delta, { added: [], deleted: [], changed: [...CHANGED_ALLOWLIST].sort() });
    assert.equal(report.steps[1].engineIdentical, true);
    assert.equal(report.steps[3].namespaceHasField, true); assert.equal(report.steps[3].runtimeField.name, FIELD.name);
    assert.equal(snapshot(root), before, 'nothing in the repository changed (including .env, prisma.config.ts, migrations, the tracked client)');
    assert.equal(report.stage, null); // staging directory removed
    assert.deepEqual(calls.map(call => call.args.slice(1, 3)), [['generate', '--config'], ['generate', '--config'], ['generate', '--config'], ['migrate', 'diff']]);
    assert.equal(report.prisma.installed, '6.19.3');
  } finally { cleanupRoot(root); }
});

test('stage: a current-schema reproduction mismatch stops BEFORE the proposed client is generated, reporting exact paths and hashes', () => {
  const root = fixture({ tracked: { currentDiffers: false } });
  writeFileSync(join(root, CLIENT_DIR, 'models/M1.ts'), 'export const m1 = tampered;\n');
  const { deps, calls } = harness(root);
  try {
    const before = snapshot(root);
    const report = stageGeneration(deps);
    assert.equal(report.result, 'REPRODUCTION_FAILED');
    assert.equal(calls.length, 1, 'only the current-schema generation ran');
    const step = report.steps[0];
    assert.equal(step.pass, false); assert.deepEqual(step.differing.changed, ['models/M1.ts']);
    assert.match(step.differing.hashes['models/M1.ts'].tracked, /^[0-9a-f]{64}$/); assert.match(step.differing.hashes['models/M1.ts'].candidate, /^[0-9a-f]{64}$/); assert.match(step.differing.hashes['models/M1.ts'].raw, /^[0-9a-f]{64}$/);
    assert.notEqual(step.differing.hashes['models/M1.ts'].tracked, step.differing.hashes['models/M1.ts'].candidate);
    assert.equal(snapshot(root), before);
  } finally { cleanupRoot(root); }
  const added = fixture();
  writeFileSync(join(added, CLIENT_DIR, 'models/M7.ts'), 'x');
  rmSync(join(added, CLIENT_DIR, 'models/M2.ts'));
  try { const report = stageGeneration(harness(added).deps); assert.equal(report.result, 'REPRODUCTION_FAILED'); assert.deepEqual(report.steps[0].differing.deleted, []); assert.deepEqual(report.steps[0].differing.added, ['models/M2.ts']); assert.deepEqual(report.steps[0].differing.changed, ['models/M7.ts']); } finally { cleanupRoot(added); }
});

test('stage: any deviation from the four-file allowlist is a hard failure (fifth changed file, added file, missing change, deleted file, engine change)', () => {
  const cases = { fifthChanged: 'models/M5.ts', extraFile: 'models/Extra.ts', missingChange: 'models/PreparedImport.ts', deleteFile: 'models/M3.ts', engineChanged: ENGINE_FILE };
  for (const [mode, path] of Object.entries(cases)) {
    const root = fixture(), { deps } = harness(root, { [mode]: true });
    try {
      const before = snapshot(root);
      const report = stageGeneration(deps);
      assert.equal(report.result, 'DELTA_NOT_ALLOWLIST', mode);
      const delta = report.steps[1].delta;
      assert.ok([...delta.added, ...delta.deleted, ...delta.changed].includes(path) || (mode === 'missingChange' && !delta.changed.includes(path)), mode + JSON.stringify(delta));
      assert.equal(snapshot(root), before, mode);
      assert.equal(report.manifest, undefined, 'no manifest is produced for a failed delta');
    } finally { cleanupRoot(root); }
  }
});

test('stage: a non-deterministic second generation is a hard failure', () => {
  const root = fixture(), { deps } = harness(root, { nondeterministic: true });
  try { assert.equal(stageGeneration(deps).result, 'GENERATION_NOT_DETERMINISTIC'); } finally { cleanupRoot(root); }
});

test('stage: migration-diff corroboration failures stop staging (extra structure or a different column)', () => {
  for (const diffOutput of ['ALTER TABLE "PreparedImport" ADD COLUMN "creationRequestHash" TEXT;\nCREATE UNIQUE INDEX "u" ON "PreparedImport"("creationRequestHash");', 'ALTER TABLE "PreparedImport" ADD COLUMN "other" TEXT;', '']) {
    const root = fixture(), { deps } = harness(root, {}, { diffOutput });
    try { assert.equal(stageGeneration(deps).result, 'MIGRATION_SEMANTICS_MISMATCH', diffOutput); } finally { cleanupRoot(root); }
  }
  const tampered = fixture(); writeFileSync(join(tampered, MIGRATION_25.path), 'ALTER TABLE "PreparedImport" ADD COLUMN "creationRequestHash" TEXT; -- edited\n');
  try { assert.equal(stageGeneration(harness(tampered).deps).result, 'MIGRATION_SEMANTICS_MISMATCH', 'frozen migration bytes are also checked'); } finally { cleanupRoot(tampered); }
});

test('environment and config isolation: scrubbed environment, placeholder URL, private config only, no environment-file or inherited-connection influence', () => {
  const saved = { url: process.env.DATABASE_URL, receipt: process.env.DB_SAFETY_RECEIPT, pg: process.env.PGHOST, redis: process.env.REDIS_HOST, minio: process.env.MINIO_ENDPOINT, opts: process.env.NODE_OPTIONS };
  Object.assign(process.env, { DATABASE_URL: 'postgresql://evil:hostile@10.9.9.9:5432/appdb', DB_SAFETY_RECEIPT: '/tmp/evil-receipt.json', PGHOST: '10.9.9.9', REDIS_HOST: '10.9.9.8', MINIO_ENDPOINT: 'http://10.9.9.7:9000', NODE_OPTIONS: '--require=/tmp/evil.cjs' });
  const root = fixture(), { deps, calls, configs } = harness(root);
  try {
    const report = stageGeneration(deps);
    assert.equal(report.result, 'STAGED_OK');
    assert.ok(calls.length === 4);
    for (const call of calls) {
      assert.equal(call.cmd, process.execPath); assert.equal(call.args[0], prismaCli(root));
      assert.deepEqual(Object.keys(call.opts.env).sort(), ['CHECKPOINT_DISABLE', 'DATABASE_URL', 'HOME', 'LANG', 'NO_COLOR', 'PATH', 'PRISMA_HIDE_UPDATE_MESSAGE', 'TMPDIR']);
      assert.equal(call.opts.env.DATABASE_URL, DUMMY_DATABASE_URL);
      assert.ok(call.opts.cwd.startsWith(STAGE_PREFIX), 'the working directory is the private stage, not the repository (so no repository config or environment file is picked up)');
      assert.ok(call.args.filter(arg => arg.startsWith('/')).slice(1).every(arg => arg.startsWith(STAGE_PREFIX)), 'every path argument is inside the stage');
      assert.ok(!JSON.stringify(call).includes('10.9.9') && !JSON.stringify(call).includes('evil'));
    }
    for (const text of configs) { assert.ok(text.includes(DUMMY_DATABASE_URL)); assert.ok(!/dotenv|\.env|10\.9\.9|evil|process\.env/.test(text), text); }
    assert.equal(configText('/x/schema.prisma', root).includes(DUMMY_DATABASE_URL), true);
    assert.deepEqual(buildEnv('/h'), { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: '/h', TMPDIR: '/h', LANG: 'C', DATABASE_URL: DUMMY_DATABASE_URL, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1', NO_COLOR: '1' });
  } finally {
    for (const [key, name] of [['url', 'DATABASE_URL'], ['receipt', 'DB_SAFETY_RECEIPT'], ['pg', 'PGHOST'], ['redis', 'REDIS_HOST'], ['minio', 'MINIO_ENDPOINT'], ['opts', 'NODE_OPTIONS']]) { if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key]; }
    cleanupRoot(root);
  }
  const source = readFileSync(join(ROOT, 'scripts/db-safety/prisma-client-stage.mjs'), 'utf8');
  for (const forbidden of ['dotenv', "'.env'", '".env"', '.env.local', 'psql', 'pg_dump', 'docker', 'g2-generate', 'approve-disposable', 'process.env', 'cli.mjs']) assert.ok(!source.includes(forbidden), `helper source must not mention ${forbidden}`);
});

test('forbidden DB/process invocations are refused before any process starts', () => {
  const root = '/repo', stage = `${STAGE_PREFIX}abc`;
  const env = buildEnv(`${stage}/home`), cli = prismaCli(root), cwd = `${stage}/current`, config = `${stage}/current/prisma.config.ts`;
  const ok = (cmd, args, options = { cwd, env }) => assertAllowedSpawn(cmd, args, options, { root, stage });
  assert.doesNotThrow(() => ok(process.execPath, [cli, 'generate', '--config', config]));
  assert.doesNotThrow(() => ok(process.execPath, [cli, 'migrate', 'diff', '--config', `${stage}/diff/prisma.config.ts`, '--from-schema-datamodel', `${stage}/diff/from.prisma`, '--to-schema-datamodel', `${stage}/diff/to.prisma`, '--script']));
  for (const cmd of ['psql', 'pg_dump', 'docker', 'redis-cli', 'mc', 'sh', 'bash', '/usr/bin/node']) assert.throws(() => ok(cmd, ['-c', 'select 1']), /FORBIDDEN_PROCESS/, cmd);
  assert.throws(() => ok(process.execPath, ['scripts/db-safety/g2-generate.mjs']), /FORBIDDEN_PROCESS/);
  assert.throws(() => ok(process.execPath, ['scripts/db-safety/cli.mjs', 'test', 'g2:generate']), /FORBIDDEN_PROCESS/);
  for (const sub of [['migrate', 'deploy'], ['migrate', 'dev'], ['migrate', 'reset'], ['migrate', 'resolve'], ['db', 'push'], ['db', 'execute'], ['db', 'pull'], ['studio'], ['generate'], ['generate', '--schema', '/repo/prisma/schema.prisma'], ['generate', '--config', config, '--watch'], ['migrate', 'diff', '--from-url', 'postgresql://x', '--to-url', 'postgresql://y']]) assert.throws(() => ok(process.execPath, [cli, ...sub]), /FORBIDDEN_PROCESS_ARGUMENTS/, sub.join(' '));
  assert.throws(() => ok(process.execPath, [cli, 'generate', '--config', '/repo/prisma.config.ts']), /FORBIDDEN_CONFIG_PATH/);
  assert.throws(() => ok(process.execPath, [cli, 'migrate', 'diff', '--config', `${stage}/d/c.ts`, '--from-schema-datamodel', '/repo/prisma/schema.prisma', '--to-schema-datamodel', `${stage}/d/to.prisma`, '--script']), /FORBIDDEN_CONFIG_PATH/);
  assert.throws(() => ok(process.execPath, [cli, 'generate', '--config', config], { cwd: '/repo', env }), /FORBIDDEN_CWD/);
  assert.throws(() => ok(process.execPath, [cli, 'generate', '--config', config], { cwd, env: { ...env, DATABASE_URL: 'postgresql://app:pw@10.0.0.1:5432/app' } }), /FORBIDDEN_ENVIRONMENT/);
  assert.throws(() => ok(process.execPath, [cli, 'generate', '--config', config], { cwd, env: { ...env, DB_SAFETY_RECEIPT: '/tmp/r.json' } }), /FORBIDDEN_ENVIRONMENT/);
  assert.throws(() => ok(process.execPath, [cli, 'generate', '--config', config], { cwd, env: { ...env, PGPASSWORD: 'x' } }), /FORBIDDEN_ENVIRONMENT/);
  assert.throws(() => ok(process.execPath, [cli, 'generate', '--config', config], { cwd, env: { ...env, NODE_OPTIONS: '--require x' } }), /FORBIDDEN_ENVIRONMENT/);
});

// ---- Phase B (offline; never invoked against the real repository) -----------------------------------------------------
function staged(root, mode = {}) {
  const { deps } = harness(root, mode);
  const report = stageGeneration(deps, { keep: true });
  assert.equal(report.result, 'STAGED_OK');
  return report.stage;
}

test('promotion writes only the five allowlisted files and leaves every other path (migrations, proposals, .env, other generated files) untouched', () => {
  const root = fixture(); let stage;
  try {
    stage = staged(root);
    const before = snapshot(root);
    const manifest = JSON.parse(readFileSync(join(stage, 'manifest.json'), 'utf8'));
    const result = promoteStaged({ root, stage, confirm: CONFIRM });
    assert.deepEqual(result.promoted, [...PROMOTION_ALLOWLIST]); assert.equal(PROMOTION_ALLOWLIST.length, 5);
    const after = snapshot(root);
    const changed = before.split('\n').filter(line => !after.split('\n').includes(line)).map(line => line.split(':')[0]);
    assert.deepEqual(changed.sort(), [...PROMOTION_ALLOWLIST].sort());
    assert.equal(sha(readFileSync(join(root, SCHEMA_PATH))), manifest.staged.proposedSchemaSha256);
    assert.equal(treeHash(readTree(join(root, CLIENT_DIR))), manifest.staged.proposedTreeSha256);
    assert.equal(readFileSync(join(root, SCHEMA_PATH), 'utf8'), applyApprovedChange(SCHEMA));
    assert.ok(readdirSync(join(root, CLIENT_DIR, 'models')).every(name => !name.includes('.promote-')), 'no temporary files left');
    assert.throws(() => stageGeneration(harness(root).deps), /CHANGE_ALREADY_APPLIED/, 'staging again after promotion is refused');
  } finally { if (stage) rmSync(stage, { recursive: true, force: true }); cleanupRoot(root); }
});

test('promotion refuses and leaves the repository untouched on: missing confirmation, bad stage path, non-private or unverified stage, allowlist tampering', () => {
  const root = fixture(); let stage;
  try {
    stage = staged(root);
    const before = snapshot(root);
    const manifestPath = join(stage, 'manifest.json'), original = readFileSync(manifestPath, 'utf8');
    const attempt = (expected, options = {}) => assert.throws(() => promoteStaged({ root, stage, confirm: CONFIRM, ...options }), expected);
    for (const confirm of [undefined, '', 'yes', CONFIRM + ' ', CONFIRM.toUpperCase()]) assert.throws(() => promoteStaged({ root, stage, confirm }), /PROMOTION_NOT_CONFIRMED/);
    for (const bad of ['/tmp/elsewhere', `${STAGE_PREFIX}x/../../etc`, '', undefined]) assert.throws(() => promoteStaged({ root, stage: bad, confirm: CONFIRM }), /PROMOTION_STAGE_PATH_INVALID/);
    chmodSync(stage, 0o755); attempt(/PROMOTION_STAGE_NOT_PRIVATE'?/); chmodSync(stage, 0o700);
    const tamper = mutate => { const manifest = JSON.parse(original); mutate(manifest); writeFileSync(manifestPath, JSON.stringify(manifest)); };
    tamper(manifest => { manifest.result = 'REPRODUCTION_FAILED'; }); attempt(/PROMOTION_STAGE_NOT_VERIFIED/);
    tamper(manifest => { manifest.promotion.allowlist.push('prisma/migrations/20260101000_a/migration.sql'); }); attempt(/PROMOTION_ALLOWLIST_MISMATCH/);
    tamper(manifest => { manifest.promotion.allowlist[1] = '../outside.ts'; }); attempt(/PROMOTION_ALLOWLIST_MISMATCH/);
    tamper(manifest => { manifest.promotion.allowlist = manifest.promotion.allowlist.slice(0, 4); }); attempt(/PROMOTION_ALLOWLIST_MISMATCH/);
    tamper(manifest => { manifest.promotion.allowlist.reverse(); }); attempt(/PROMOTION_ALLOWLIST_MISMATCH/);
    writeFileSync(manifestPath, original);
    assert.equal(snapshot(root), before);
  } finally { if (stage) rmSync(stage, { recursive: true, force: true }); cleanupRoot(root); }
});

test('promotion fails closed on source drift, tracked-client drift, watched-tree drift and staged drift', () => {
  const drifts = {
    'schema edited after staging': [root => writeFileSync(join(root, SCHEMA_PATH), SCHEMA + '\n// drift\n'), /SOURCE_SCHEMA_DRIFT/],
    'allowlisted tracked file edited': [root => writeFileSync(join(root, CLIENT_DIR, 'models/PreparedImport.ts'), 'export {};\n'), /TRACKED_CLIENT_DRIFT/],
    'unrelated tracked client file edited': [root => writeFileSync(join(root, CLIENT_DIR, 'models/M2.ts'), 'export {};\n'), /TRACKED_CLIENT_DRIFT/],
    'engine binary edited': [root => writeFileSync(join(root, CLIENT_DIR, ENGINE_FILE), Buffer.from([7])), /TRACKED_CLIENT_DRIFT/],
    'tracked client gains a file': [root => writeFileSync(join(root, CLIENT_DIR, 'models/New.ts'), 'x'), /TRACKED_CLIENT_DRIFT/],
    'active migration chain changed': [root => writeFileSync(join(root, 'prisma/migrations/20260101000_a/migration.sql'), 'SELECT 2;\n'), /WATCHED_TREE_DRIFT/],
    'proposal migration changed': [root => writeFileSync(join(root, MIGRATION_25.path), 'SELECT 3;\n'), /WATCHED_TREE_DRIFT/],
    'an extra migration added to the active chain': [root => { mkdirSync(join(root, 'prisma/migrations/20261006000000_x')); writeFileSync(join(root, 'prisma/migrations/20261006000000_x/migration.sql'), M25_BYTES); }, /WATCHED_TREE_DRIFT/],
  };
  for (const [label, [mutate, expected]] of Object.entries(drifts)) {
    const root = fixture(); let stage;
    try {
      stage = staged(root);
      mutate(root);
      const before = snapshot(root);
      assert.throws(() => promoteStaged({ root, stage, confirm: CONFIRM }), expected, label);
      assert.equal(snapshot(root), before, label + ': nothing was written');
    } finally { if (stage) rmSync(stage, { recursive: true, force: true }); cleanupRoot(root); }
  }
  const stagedDrifts = {
    'staged allowlisted file edited': [stage => writeFileSync(join(stage, 'proposed-candidate', CLIENT_DIR, 'models/PreparedImport.ts'), 'export {};\n'), /STAGED_CLIENT_DRIFT/],
    'staged unrelated file edited': [stage => writeFileSync(join(stage, 'proposed-candidate', CLIENT_DIR, 'models/M2.ts'), 'export {};\n'), /STAGED_CLIENT_DRIFT/],
    'staged extra file': [stage => writeFileSync(join(stage, 'proposed-candidate', CLIENT_DIR, 'models/Extra.ts'), 'x'), /STAGED_CLIENT_DRIFT/],
    'staged file deleted': [stage => rmSync(join(stage, 'proposed-candidate', CLIENT_DIR, 'models/M2.ts')), /STAGED_CLIENT_DRIFT/],
    'staged schema edited': [stage => writeFileSync(join(stage, 'proposed/prisma/schema.prisma'), applyApprovedChange(SCHEMA) + '\n// x\n'), /STAGED_SCHEMA_DRIFT/],
    'staged engine edited': [stage => writeFileSync(join(stage, 'proposed-candidate', CLIENT_DIR, ENGINE_FILE), Buffer.from([5])), /STAGED_CLIENT_DRIFT/],
  };
  for (const [label, [mutate, expected]] of Object.entries(stagedDrifts)) {
    const root = fixture(); let stage;
    try {
      stage = staged(root);
      mutate(stage);
      const before = snapshot(root);
      assert.throws(() => promoteStaged({ root, stage, confirm: CONFIRM }), expected, label);
      assert.equal(snapshot(root), before, label + ': nothing was written');
    } finally { if (stage) rmSync(stage, { recursive: true, force: true }); cleanupRoot(root); }
  }
});

test('promotion path escape and mutation outside the allowlist are impossible', () => {
  const root = fixture(), outside = mkdtempSync(join(tmpdir(), 'ps-outside-'));
  try {
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', '', 'prisma\\schema.prisma', 'x\0y', undefined, 5]) assert.throws(() => safeTarget(root, bad), /PROMOTION_PATH_ESCAPE/, JSON.stringify(bad));
    assert.doesNotThrow(() => safeTarget(root, SCHEMA_PATH));
    // a symlinked directory component pointing outside the root
    symlinkSync(outside, join(root, 'lib/generated/prisma/linked'));
    assert.throws(() => safeTarget(root, `${CLIENT_DIR}/linked/new.ts`), /PROMOTION_PATH_ESCAPE/);
    rmSync(join(root, 'lib/generated/prisma/linked'));
    // a symlink in place of an allowlisted target
    rmSync(join(root, SCHEMA_PATH)); symlinkSync(join(outside, 'target.prisma'), join(root, SCHEMA_PATH)); writeFileSync(join(outside, 'target.prisma'), SCHEMA);
    assert.throws(() => safeTarget(root, SCHEMA_PATH), /PROMOTION_(PATH_ESCAPE|TARGET_NOT_REGULAR_FILE)/);
    assert.equal(readFileSync(join(outside, 'target.prisma'), 'utf8'), SCHEMA, 'the outside file was never written');
    assert.ok(PROMOTION_ALLOWLIST.every(path => path === SCHEMA_PATH || (path.startsWith(`${CLIENT_DIR}/`) && !path.includes('..'))));
    assert.ok(!PROMOTION_ALLOWLIST.some(path => /migrations|scripts\/db-safety|commands\.json|apps\//.test(path)), 'never the migrations, the runner, commands.json or application code');
  } finally { cleanupRoot(root); rmSync(outside, { recursive: true, force: true }); }
});

test('a write failure part-way rolls every promoted file back (all-or-nothing) and leaves no temporary files', () => {
  const root = fixture(); let stage;
  try {
    stage = staged(root);
    const before = snapshot(root);
    let count = 0;
    const flaky = (from, to) => { count += 1; if (count === 3) throw Error('disk full'); renameSync(from, to); };
    assert.throws(() => promoteStaged({ root, stage, confirm: CONFIRM, rename: flaky }), /PROMOTION_FAILED_ROLLED_BACK/);
    assert.equal(snapshot(root), before);
  } finally { if (stage) rmSync(stage, { recursive: true, force: true }); cleanupRoot(root); }
});

// ---- facts about the real repository (read-only) --------------------------------------------------------------------
test('real repository facts: allowlist files exist in the tracked client, before-state hashes, and frozen migration 25 bytes', () => {
  const tracked = readTree(join(M25_ROOT(), CLIENT_DIR));
  assert.ok(CHANGED_ALLOWLIST.every(file => tracked.has(file)) && tracked.has(ENGINE_FILE));
  assert.equal(tracked.size, 44);
  // This helper hashes 'relative/path:sha' lines (no leading slash); an earlier ad-hoc figure used a leading slash and differs.
  assert.equal(treeHash(tracked), 'a750e6b900e00991e818b660f7af67866d1c8ea2ec7774ff2f92f0b40fb54a52'); // post-promotion (pre-promotion: edadf77b...)
  assert.equal(sha(readFileSync(join(M25_ROOT(), SCHEMA_PATH))), '4fe3d96a334e18e504ea14fd5519a1a363fae5ea6d9845355c9d548698eed174'); // post-promotion (pre-promotion: a013d71a...)
  assert.equal(sha(M25_BYTES), 'a8ffbc84bde7f18aac93bbb2e87423e6cfcbf6efd95c01e6650824fdcc3ed859');
  assert.equal(sha(readFileSync(join(M25_ROOT(), 'prisma/migrations/20260930030000_dataset_modality_g2/migration.sql'))), '13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7');
  assert.equal(readdirSync(join(M25_ROOT(), 'prisma/migrations')).filter(name => name.startsWith('2026')).length, 25);
  assert.deepEqual(compareTrees(tracked, tracked), { added: [], deleted: [], changed: [] });
});

test('promotion rejects raw staging-path-bearing artifacts, even when the manifest is rewritten to match them', () => {
  for (const consistent of [false, true]) {
    const root = fixture(); let stage;
    try {
      stage = staged(root);
      const before = snapshot(root);
      const manifestPath = join(stage, 'manifest.json');
      const rawClass = readFileSync(join(stage, 'proposed', CLIENT_DIR, CLASS_FILE));
      const candidateClass = join(stage, 'proposed-candidate', CLIENT_DIR, CLASS_FILE);
      writeFileSync(candidateClass, rawClass);
      if (consistent) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        manifest.staged.files[`${CLIENT_DIR}/${CLASS_FILE}`] = sha(rawClass);
        manifest.staged.canonicalClassSha256 = sha(rawClass);
        manifest.staged.proposedTreeSha256 = treeHash(readTree(join(stage, 'proposed-candidate', CLIENT_DIR)));
        writeFileSync(manifestPath, JSON.stringify(manifest));
        assert.throws(() => promoteStaged({ root, stage, confirm: CONFIRM }), /STAGED_PATH_LEAK/);
      } else assert.throws(() => promoteStaged({ root, stage, confirm: CONFIRM }), /STAGED_CLIENT_DRIFT/);
      assert.equal(snapshot(root), before, 'nothing written');
    } finally { if (stage) rmSync(stage, { recursive: true, force: true }); cleanupRoot(root); }
  }
  // a manifest that claims the canonical class equals the raw one is also refused
  const root = fixture(); let stage;
  try {
    stage = staged(root);
    const manifestPath = join(stage, 'manifest.json'), manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.staged.rawClassSha256 = manifest.staged.canonicalClassSha256; writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => promoteStaged({ root, stage, confirm: CONFIRM }), /STAGED_RAW_ARTIFACT/);
  } finally { if (stage) rmSync(stage, { recursive: true, force: true }); cleanupRoot(root); }
});

test('promotion writes only canonicalized candidate bytes (the promoted class.ts has repository paths and equals the candidate, not the raw file)', () => {
  const root = fixture(); let stage;
  try {
    stage = staged(root);
    const candidate = readFileSync(join(stage, 'proposed-candidate', CLIENT_DIR, CLASS_FILE), 'utf8'), raw = readFileSync(join(stage, 'proposed', CLIENT_DIR, CLASS_FILE), 'utf8');
    promoteStaged({ root, stage, confirm: CONFIRM });
    const promoted = readFileSync(join(root, CLIENT_DIR, CLASS_FILE), 'utf8');
    assert.equal(promoted, candidate); assert.notEqual(promoted, raw); assert.ok(!promoted.includes(STAGE_PREFIX));
  } finally { if (stage) rmSync(stage, { recursive: true, force: true }); cleanupRoot(root); }
});

test('post-A2.3: the promoted repository carries the reviewed M26 bytes, the candidate schema and a regenerated tracked client; M24/M25 are unchanged', () => {
  const tracked = readTree(join(ROOT, CLIENT_DIR));
  assert.equal(sha(readFileSync(join(ROOT, SCHEMA_PATH))), '4a85c754d067ae64f0f767d5e6cd49f37c6d5f004865257faef66025d6000993');
  assert.equal(sha(readFileSync(join(ROOT, 'prisma/migrations/20261007000000_media_verification_a2/migration.sql'))), 'ede5e8c511705521e1e6a18563ebaa602e9c24430946acddbed91340d923df5a');
  assert.equal(sha(readFileSync(join(ROOT, 'prisma/migrations/20260930030000_dataset_modality_g2/migration.sql'))), '13f0e977d1b809da84cdfc5cc415a41adc18b354f9218596e14b9efd8e7aeab7');
  assert.equal(sha(M25_BYTES), 'a8ffbc84bde7f18aac93bbb2e87423e6cfcbf6efd95c01e6650824fdcc3ed859');
  assert.equal(readdirSync(join(ROOT, 'prisma/migrations')).filter(name => name.startsWith('2026')).length, 26);
  assert.equal(tracked.size, 45, 'the 44 tracked files plus the generated MediaVerification model');
  assert.equal(treeHash(tracked), 'b88f7a3dc76134aaf11d4962159bafde47a5904f9eb7e11e0edc4247cd79083c');
  assert.ok(tracked.has('models/MediaVerification.ts'));
  assert.match(readFileSync(join(ROOT, CLIENT_DIR, 'enums.ts'), 'utf8'), /VERIFY_UPLOADED_MEDIA: 'VERIFY_UPLOADED_MEDIA'/);
});
