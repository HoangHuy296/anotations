// DB-free Prisma client staging and (separately gated) promotion for ONE approved schema change:
//   model PreparedImport { ... creationRequestHash String? ... }   (frozen migration 25, promoted to the active chain)
//
// Phase A (`stage`): generate entirely inside a private staging tree, never into the repository.
//   1. generate from the CURRENT canonical schema (raw Prisma output), canonicalize ONLY the two known absolute paths in
//      internal/class.ts, and require the result to reproduce the tracked client byte-for-byte, 44/44 files
//      (otherwise stop: the proposed client is never generated). Raw bytes and canonicalized candidate bytes are kept apart;
//      no whitespace normalization is ever applied: the tracked raw generator representation is authoritative;
//   2. generate from the staged PROPOSED schema (current + exactly one inserted line), canonicalize the same way, and require the changed-file set to equal
//      CHANGED_ALLOWLIST exactly (no added, deleted or extra changed file; engine binary identical);
//   3. generate the proposed client a second time and require identical output (determinism);
//   4. require the inlined schema, the runtime data model and PreparedImportScalarFieldEnum to correspond to the staged schema;
//   5. a schema-to-schema Prisma diff is corroboration only (one nullable TEXT column, no other structure).
// Phase B (`promote`): writes ONLY PROMOTION_ALLOWLIST after re-checking every hash; it is never invoked by `stage`.
//
// Safety boundary (environment/config isolation first, unreachable URL last):
//   * the only child process is this repository's pinned Prisma CLI run through node with a fixed, validated argv;
//   * the environment is built from scratch (no inherited connection variables, no receipt, no environment-file loading);
//   * the private config carries a literal placeholder URL and is the only config Prisma sees (the working directory is the stage);
//   * no database client, container tool, receipt tooling or DB-backed generation path is ever invoked.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const ROOT = resolve(import.meta.dirname, '../..');
export const CLIENT_DIR = 'lib/generated/prisma';
export const SCHEMA_PATH = 'prisma/schema.prisma';
export const FIELD = Object.freeze({ model: 'PreparedImport', name: 'creationRequestHash', line: '  creationRequestHash String?', after: 'idempotencyKey' });
export const ENGINE_FILE = 'libquery_engine-debian-openssl-3.0.x.so.node';
export const CHANGED_ALLOWLIST = Object.freeze(['models/PreparedImport.ts', 'internal/prismaNamespace.ts', 'internal/prismaNamespaceBrowser.ts', 'internal/class.ts']);
export const PROMOTION_ALLOWLIST = Object.freeze([SCHEMA_PATH, ...CHANGED_ALLOWLIST.map(file => `${CLIENT_DIR}/${file}`)]);
export const DUMMY_DATABASE_URL = 'postgresql://stage:unused@127.0.0.1:9/unused';
export const CONFIRM = 'promote-prepared-import-creation-request-hash';
export const STAGE_PREFIX = '/tmp/phase029-prisma-stage-';
export const MIGRATION_25 = Object.freeze({ path: 'prisma/migrations/20261006000000_prepared_import_creation_request_hash/migration.sql', sha256: 'a8ffbc84bde7f18aac93bbb2e87423e6cfcbf6efd95c01e6650824fdcc3ed859' });
export const CLASS_FILE = 'internal/class.ts';
/** Audited occurrence counts of the two Prisma-generated absolute paths in the raw class.ts (output directory, schema source). */
export const EXPECTED_PATH_OCCURRENCES = Object.freeze({ output: 1, schema: 1 });
const WATCHED_TREES = ['prisma/migrations'];
const ALLOWED_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'DATABASE_URL', 'CHECKPOINT_DISABLE', 'PRISMA_HIDE_UPDATE_MESSAGE', 'NO_COLOR'];

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const fail = code => { throw Error(code); };
const must = (value, code) => { if (!value) fail(code); };
const sorted = list => [...list].sort();

// ---------------------------------------------------------------- pure helpers
/** Applies exactly the approved change: one inserted line after `idempotencyKey` inside `model PreparedImport`. */
export function applyApprovedChange(schemaText) {
  const start = schemaText.indexOf(`model ${FIELD.model} {`);
  must(start >= 0 && schemaText.indexOf(`model ${FIELD.model} {`, start + 1) === -1, 'SCHEMA_MODEL_NOT_FOUND_OR_AMBIGUOUS');
  const end = schemaText.indexOf('\n}', start);
  must(end > start, 'SCHEMA_MODEL_UNTERMINATED');
  const block = schemaText.slice(start, end);
  must(!new RegExp(`^\\s*${FIELD.name}\\b`, 'm').test(block), 'CHANGE_ALREADY_APPLIED');
  const anchor = new RegExp(`^  ${FIELD.after}\\s+String$`, 'm').exec(block);
  must(anchor, 'SCHEMA_ANCHOR_NOT_FOUND');
  const insertAt = start + anchor.index + anchor[0].length;
  return `${schemaText.slice(0, insertAt)}\n${FIELD.line}${schemaText.slice(insertAt)}`;
}
export function isSingleLineInsertion(before, after, line = FIELD.line) {
  const a = before.split('\n'), b = after.split('\n');
  if (b.length !== a.length + 1) return false;
  const index = a.findIndex((value, i) => value !== b[i]);
  const at = index === -1 ? a.length : index;
  return b[at] === line && isDeepStrictEqual(b.slice(at + 1), a.slice(at)) && isDeepStrictEqual(b.slice(0, at), a.slice(0, at));
}
/** Whitespace-insensitive line comparison (the generator inlines a column-aligned copy of the schema). */
export const collapse = text => text.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).join('\n');

export function readTree(dir) {
  const files = new Map();
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      must(!entry.isSymbolicLink(), 'TREE_CONTAINS_SYMLINK');
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.set(relative(dir, full).split(sep).join('/'), sha(readFileSync(full)));
    }
  };
  must(existsSync(dir), 'TREE_MISSING');
  walk(dir);
  return files;
}
export const treeHash = tree => sha([...tree.keys()].sort().map(path => `${path}:${tree.get(path)}`).join('\n'));
export function compareTrees(base, other) {
  const added = [], deleted = [], changed = [];
  for (const [path, hash] of other) { if (!base.has(path)) added.push(path); else if (base.get(path) !== hash) changed.push(path); }
  for (const path of base.keys()) if (!other.has(path)) deleted.push(path);
  return { added: sorted(added), deleted: sorted(deleted), changed: sorted(changed) };
}
const countOccurrences = (text, needle) => (needle.length === 0 ? 0 : text.split(needle).length - 1);
/**
 * Narrow, exact canonicalization of the ONLY two Prisma-generated absolute paths in internal/class.ts:
 *   <stage tree>/lib/generated/prisma  ->  <repo>/lib/generated/prisma
 *   <stage tree>/prisma/schema.prisma  ->  <repo>/prisma/schema.prisma
 * Fixed-string replacement only (no regex, no generic home/tmp handling). It fails closed unless each stage path occurs exactly the
 * audited number of times, and unless no private-stage path remains afterwards. Returns the canonical text plus audit counts.
 */
export function canonicalizeClassFile(rawText, { stageOutput, stageSchema, repoOutput, repoSchema }) {
  const discovered = { output: countOccurrences(rawText, stageOutput), schema: countOccurrences(rawText, stageSchema) };
  must(discovered.output === EXPECTED_PATH_OCCURRENCES.output && discovered.schema === EXPECTED_PATH_OCCURRENCES.schema, 'CLASS_PATH_OCCURRENCES_UNEXPECTED');
  must(stageOutput.startsWith(STAGE_PREFIX) && stageSchema.startsWith(STAGE_PREFIX) && !repoOutput.startsWith(STAGE_PREFIX) && !repoSchema.startsWith(STAGE_PREFIX), 'CANONICAL_PATHS_INVALID');
  const canonical = rawText.split(stageOutput).join(repoOutput).split(stageSchema).join(repoSchema);
  must(!canonical.includes(STAGE_PREFIX), 'STAGE_PATH_REMAINS');
  return { canonical, discovered, expected: { ...EXPECTED_PATH_OCCURRENCES } };
}

/** Facts read from a generated client directory (no execution of generated code). */
export function inspectGenerated(clientDir) {
  const classSource = readFileSync(join(clientDir, 'internal/class.ts'), 'utf8');
  const inline = /"inlineSchema": (".*"),\n/.exec(classSource), model = /config\.runtimeDataModel = JSON\.parse\((".*")\)\n/.exec(classSource);
  must(inline && model, 'GENERATED_CLASS_UNPARSEABLE');
  const runtime = JSON.parse(JSON.parse(model[1]));
  const enumFields = file => {
    const block = new RegExp(`export const ${FIELD.model}ScalarFieldEnum = \\{([\\s\\S]*?)\\} as const`).exec(readFileSync(join(clientDir, file), 'utf8'));
    must(block, 'GENERATED_ENUM_MISSING');
    return [...block[1].matchAll(/^\s*(\w+):/gm)].map(match => match[1]);
  };
  return {
    inlineSchema: JSON.parse(inline[1]),
    runtimeFields: runtime.models?.[FIELD.model]?.fields ?? [],
    namespaceFields: enumFields('internal/prismaNamespace.ts'),
    browserFields: enumFields('internal/prismaNamespaceBrowser.ts'),
  };
}
/** The generated client must correspond to the staged schema; `expectField` says whether the new field must be present. */
export function verifyCorrespondence(clientDir, schemaText, expectField) {
  const facts = inspectGenerated(clientDir);
  must(collapse(facts.inlineSchema) === collapse(schemaText), 'INLINE_SCHEMA_MISMATCH');
  const runtime = facts.runtimeFields.find(field => field.name === FIELD.name);
  if (expectField) {
    must(runtime && runtime.type === 'String' && runtime.isRequired === false && runtime.isList === false && runtime.kind === 'scalar', 'RUNTIME_DATA_MODEL_MISMATCH');
    must(facts.namespaceFields.includes(FIELD.name) && facts.browserFields.includes(FIELD.name), 'SCALAR_FIELD_ENUM_MISMATCH');
  } else {
    must(!runtime && !facts.namespaceFields.includes(FIELD.name) && !facts.browserFields.includes(FIELD.name), 'UNEXPECTED_FIELD_PRESENT');
  }
  return { inlineSchemaMatches: true, runtimeField: runtime ?? null, namespaceHasField: facts.namespaceFields.includes(FIELD.name), browserHasField: facts.browserFields.includes(FIELD.name) };
}

/** Semantic corroboration only: exactly one statement adding one nullable TEXT column to PreparedImport and no other structure. */
export function semanticAddColumn(script) {
  const statements = script.split('\n').filter(line => !/^\s*(--.*)?$/.test(line)).join('\n').split(';').map(part => part.trim()).filter(Boolean);
  const pattern = new RegExp(`^ALTER TABLE "${FIELD.model}" ADD COLUMN\\s+"${FIELD.name}" TEXT(?: NULL)?$`);
  return statements.length === 1 && pattern.test(statements[0]);
}

// ---------------------------------------------------------------- process / environment isolation
export const prismaCli = (root = ROOT) => join(root, 'node_modules/prisma/build/index.js');
export function buildEnv(home) {
  return { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: home, LANG: 'C', DATABASE_URL: DUMMY_DATABASE_URL, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1', NO_COLOR: '1' };
}
export function configText(schemaPath, root = ROOT) {
  return `import {defineConfig} from ${JSON.stringify(join(root, 'node_modules/prisma/config.js'))}; export default defineConfig(${JSON.stringify({ schema: schemaPath, engine: 'classic', datasource: { url: DUMMY_DATABASE_URL } })});\n`;
}
/** Every child process passes through this check: the pinned Prisma CLI only, fixed argv shapes, scrubbed environment, stage cwd. */
export function assertAllowedSpawn(cmd, args, options, { root = ROOT, stage }) {
  must(cmd === process.execPath && args[0] === prismaCli(root), 'FORBIDDEN_PROCESS');
  const generate = args.length === 4 && args[1] === 'generate' && args[2] === '--config';
  const diff = args.length === 10 && args[1] === 'migrate' && args[2] === 'diff' && args[3] === '--config' && args[5] === '--from-schema-datamodel' && args[7] === '--to-schema-datamodel' && args[9] === '--script';
  must(generate || diff, 'FORBIDDEN_PROCESS_ARGUMENTS');
  if (diff) must([args[6], args[8]].every(path => typeof path === 'string' && resolve(path).startsWith(resolve(stage) + sep)), 'FORBIDDEN_CONFIG_PATH');
  const env = options?.env ?? {};
  must(Object.keys(env).every(key => ALLOWED_ENV_KEYS.includes(key)) && env.DATABASE_URL === DUMMY_DATABASE_URL && !('DB_SAFETY_RECEIPT' in env), 'FORBIDDEN_ENVIRONMENT');
  must(typeof options?.cwd === 'string' && resolve(options.cwd).startsWith(resolve(stage) + sep), 'FORBIDDEN_CWD');
  const config = generate ? args[3] : args[4];
  must(typeof config === 'string' && resolve(config).startsWith(resolve(stage) + sep), 'FORBIDDEN_CONFIG_PATH');
}

export function realDeps() {
  return {
    root: ROOT,
    spawn: (cmd, args, options) => { const p = spawnSync(cmd, args, { ...options, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000 }); return { status: p.status ?? 1, stdout: p.stdout ?? '', stderr: p.stderr ?? '' }; },
    mkStage: () => { const dir = mkdtempSync(STAGE_PREFIX); chmodSync(dir, 0o700); return dir; },
    now: () => new Date(),
  };
}

// ---------------------------------------------------------------- version pin evidence
export function prismaVersionEvidence(root) {
  const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  const locked = [...lock.matchAll(/^ {2}prisma@(\d+\.\d+\.\d+):$/gm)].map(match => match[1]);
  must(locked.length === 1, 'PRISMA_LOCK_ENTRY_NOT_UNIQUE');
  const installed = JSON.parse(readFileSync(join(root, 'node_modules/prisma/package.json'), 'utf8')).version;
  const declared = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies?.prisma ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies?.prisma;
  must(installed === locked[0], 'PRISMA_VERSION_NOT_PINNED');
  return { declared, lockfile: locked[0], installed, cli: relative(root, prismaCli(root)) };
}

// ---------------------------------------------------------------- Phase A
function generateInto(deps, stage, tree, schemaText, label) {
  const schemaPath = join(tree, 'prisma/schema.prisma');
  mkdirSync(dirname(schemaPath), { recursive: true });
  writeFileSync(schemaPath, schemaText);
  const config = join(tree, 'prisma.config.ts');
  writeFileSync(config, configText(schemaPath, deps.root), { mode: 0o400 });
  const home = join(stage, 'home');
  mkdirSync(home, { recursive: true });
  const args = [prismaCli(deps.root), 'generate', '--config', config];
  const options = { cwd: tree, env: buildEnv(home) };
  assertAllowedSpawn(process.execPath, args, options, { root: deps.root, stage });
  const result = deps.spawn(process.execPath, args, options);
  must(result.status === 0, `GENERATE_FAILED_${label.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`);
  const rawDir = join(tree, CLIENT_DIR);
  must(existsSync(rawDir), 'GENERATE_PRODUCED_NO_OUTPUT');
  // Raw bytes stay untouched in rawDir. The candidate is a separate copy in which ONLY class.ts is canonicalized.
  const rawTree = readTree(rawDir);
  for (const [path] of rawTree) if (path !== CLASS_FILE) must(!readFileSync(join(rawDir, path)).includes(Buffer.from(STAGE_PREFIX)), 'STAGE_PATH_IN_UNEXPECTED_FILE');
  const candidateDir = join(`${tree}-candidate`, CLIENT_DIR);
  mkdirSync(dirname(candidateDir), { recursive: true });
  cpSync(rawDir, candidateDir, { recursive: true });
  const rawClass = readFileSync(join(rawDir, CLASS_FILE), 'utf8');
  const { canonical, discovered, expected } = canonicalizeClassFile(rawClass, { stageOutput: rawDir, stageSchema: schemaPath, repoOutput: join(deps.root, CLIENT_DIR), repoSchema: join(deps.root, SCHEMA_PATH) });
  writeFileSync(join(candidateDir, CLASS_FILE), canonical);
  return { rawDir, candidateDir, canonicalization: { expected, discovered, rawClassSha256: sha(rawClass), canonicalClassSha256: sha(canonical) } };
}

export function stageGeneration(deps = realDeps(), { keep = false } = {}) {
  const root = deps.root;
  const prisma = prismaVersionEvidence(root);
  const currentSchema = readFileSync(join(root, SCHEMA_PATH), 'utf8');
  const proposedSchema = applyApprovedChange(currentSchema);
  must(isSingleLineInsertion(currentSchema, proposedSchema), 'PROPOSED_SCHEMA_NOT_SINGLE_LINE');
  const tracked = readTree(join(root, CLIENT_DIR));
  const repoBefore = {
    schemaSha256: sha(currentSchema), clientTreeSha256: treeHash(tracked),
    files: Object.fromEntries(CHANGED_ALLOWLIST.map(file => [`${CLIENT_DIR}/${file}`, tracked.get(file) ?? null])),
    watched: Object.fromEntries(WATCHED_TREES.map(dir => [dir, existsSync(join(root, dir)) ? treeHash(readTree(join(root, dir))) : null])),
  };
  must(CHANGED_ALLOWLIST.every(file => tracked.has(file)) && tracked.has(ENGINE_FILE), 'TRACKED_CLIENT_INCOMPLETE');
  const stage = deps.mkStage();
  const report = { result: 'STAGING', prisma, repoBefore, steps: [], stage: keep ? stage : null };
  const finish = result => { report.result = result; if (!keep || result !== 'STAGED_OK') { rmSync(stage, { recursive: true, force: true }); report.stage = null; } return report; };
  try {
    // 1. reproduction gate: raw generation of the unchanged schema + exact path canonicalization must equal the tracked client, 44/44
    const current = generateInto(deps, stage, join(stage, 'current'), currentSchema, 'current');
    const currentRaw = readTree(current.rawDir), currentCandidate = readTree(current.candidateDir);
    const reproduction = compareTrees(tracked, currentCandidate);
    const reproduced = !reproduction.added.length && !reproduction.deleted.length && !reproduction.changed.length;
    const rawIdentical = [...tracked.keys()].filter(path => path !== CLASS_FILE && currentRaw.get(path) === tracked.get(path)).length;
    const provenance = { ...current.canonicalization, trackedClassSha256: tracked.get(CLASS_FILE) };
    report.steps.push({ name: 'current-schema-reproduction', pass: reproduced, trackedFiles: tracked.size, identicalFiles: tracked.size - reproduction.changed.length - reproduction.added.length - reproduction.deleted.length, rawIdenticalWithoutCanonicalization: rawIdentical, canonicalization: provenance, ...(reproduced ? { treeSha256: repoBefore.clientTreeSha256 } : { differing: { ...reproduction, hashes: Object.fromEntries([...reproduction.changed, ...reproduction.added].map(path => [path, { tracked: tracked.get(path) ?? null, candidate: currentCandidate.get(path) ?? null, raw: currentRaw.get(path) ?? null }])) } }) });
    if (!reproduced || rawIdentical !== tracked.size - 1) return finish('REPRODUCTION_FAILED'); // never generate the proposed client
    // 2. proposed schema: exactly the allowlisted delta (after the same canonicalization)
    const proposed = generateInto(deps, stage, join(stage, 'proposed'), proposedSchema, 'proposed');
    const proposedTree = readTree(proposed.candidateDir);
    const delta = compareTrees(tracked, proposedTree);
    const exact = !delta.added.length && !delta.deleted.length && isDeepStrictEqual(delta.changed, sorted(CHANGED_ALLOWLIST)) && proposedTree.get(ENGINE_FILE) === tracked.get(ENGINE_FILE);
    report.steps.push({ name: 'proposed-delta', pass: exact, delta, allowlist: sorted(CHANGED_ALLOWLIST), engineIdentical: proposedTree.get(ENGINE_FILE) === tracked.get(ENGINE_FILE), canonicalization: proposed.canonicalization, changedFileSha256: Object.fromEntries(delta.changed.map(path => [path, proposedTree.get(path)])) });
    if (!exact) return finish('DELTA_NOT_ALLOWLIST');
    // 3. determinism: a second proposed generation is identical after canonicalization (raw class.ts differs by stage path only)
    const second = generateInto(deps, stage, join(stage, 'proposed-again'), proposedSchema, 'proposed_again');
    const deterministic = treeHash(readTree(second.candidateDir)) === treeHash(proposedTree);
    report.steps.push({ name: 'second-generation-determinism', pass: deterministic, treeSha256: treeHash(proposedTree), rawClassSha256: [proposed.canonicalization.rawClassSha256, second.canonicalization.rawClassSha256] });
    if (!deterministic) return finish('GENERATION_NOT_DETERMINISTIC');
    // 4. correspondence to the staged schema
    report.steps.push({ name: 'schema-correspondence', pass: true, ...verifyCorrespondence(proposed.candidateDir, proposedSchema, true) });
    // 5. corroboration only (never a hash comparison with the frozen migration)
    const diffDir = join(stage, 'diff');
    mkdirSync(diffDir, { recursive: true });
    const fromPath = join(diffDir, 'from.prisma'), toPath = join(diffDir, 'to.prisma'), config = join(diffDir, 'prisma.config.ts');
    writeFileSync(fromPath, currentSchema); writeFileSync(toPath, proposedSchema); writeFileSync(config, configText(fromPath, root), { mode: 0o400 });
    const diffArgs = [prismaCli(root), 'migrate', 'diff', '--config', config, '--from-schema-datamodel', fromPath, '--to-schema-datamodel', toPath, '--script'];
    const diffOptions = { cwd: diffDir, env: buildEnv(join(stage, 'home')) };
    assertAllowedSpawn(process.execPath, diffArgs, diffOptions, { root, stage });
    const diffResult = deps.spawn(process.execPath, diffArgs, diffOptions);
    const semantic = diffResult.status === 0 && semanticAddColumn(diffResult.stdout);
    const migrationSql = readFileSync(join(root, MIGRATION_25.path), 'utf8');
    report.steps.push({ name: 'migration-25-semantic-corroboration', pass: semantic && sha(readFileSync(join(root, MIGRATION_25.path))) === MIGRATION_25.sha256 && semanticAddColumn(migrationSql), note: 'semantic only: one nullable TEXT column, no other structure; not a byte or hash comparison' });
    if (!report.steps.at(-1).pass) return finish('MIGRATION_SEMANTICS_MISMATCH');
    // manifest for a future, separately authorized promotion
    const stagedFiles = Object.fromEntries(CHANGED_ALLOWLIST.map(file => [`${CLIENT_DIR}/${file}`, proposedTree.get(file)]));
    const stagedSchemaPath = join(stage, 'proposed/prisma/schema.prisma');
    const manifest = { version: 1, createdAt: deps.now().toISOString(), prisma, repo: repoBefore, staged: { proposedSchemaSha256: sha(proposedSchema), proposedTreeSha256: treeHash(proposedTree), files: stagedFiles, schemaFile: relative(stage, stagedSchemaPath), clientDir: relative(stage, proposed.candidateDir), rawClassSha256: proposed.canonicalization.rawClassSha256, canonicalClassSha256: proposed.canonicalization.canonicalClassSha256 }, promotion: { allowlist: [...PROMOTION_ALLOWLIST] }, result: 'STAGED_OK' };
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    report.manifest = manifest;
    return finish('STAGED_OK');
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------- Phase B (never invoked by `stage`)
export function safeTarget(root, rel) {
  must(typeof rel === 'string' && rel.length > 0 && !isAbsolute(rel) && !rel.split('/').includes('..') && !rel.includes('\0') && !rel.includes('\\'), 'PROMOTION_PATH_ESCAPE');
  const target = resolve(root, rel);
  must(target.startsWith(resolve(root) + sep), 'PROMOTION_PATH_ESCAPE');
  let probe = target;
  while (!existsSync(probe)) probe = dirname(probe);
  must(realpathSync(probe).startsWith(realpathSync(root)), 'PROMOTION_PATH_ESCAPE');
  if (existsSync(target)) must(!lstatSync(target).isSymbolicLink() && statSync(target).isFile(), 'PROMOTION_TARGET_NOT_REGULAR_FILE');
  return target;
}

export function promoteStaged({ root = ROOT, stage, confirm, writeFile = writeFileSync, rename = renameSync }) {
  must(confirm === CONFIRM, 'PROMOTION_NOT_CONFIRMED');
  must(typeof stage === 'string' && resolve(stage).startsWith(STAGE_PREFIX) && !stage.includes('..'), 'PROMOTION_STAGE_PATH_INVALID');
  must(statSync(stage).isDirectory() && (statSync(stage).mode & 0o077) === 0, 'PROMOTION_STAGE_NOT_PRIVATE');
  const manifest = JSON.parse(readFileSync(join(stage, 'manifest.json'), 'utf8'));
  must(manifest.version === 1 && manifest.result === 'STAGED_OK', 'PROMOTION_STAGE_NOT_VERIFIED');
  must(isDeepStrictEqual(manifest.promotion?.allowlist, [...PROMOTION_ALLOWLIST]), 'PROMOTION_ALLOWLIST_MISMATCH');
  const targets = PROMOTION_ALLOWLIST.map(rel => [rel, safeTarget(root, rel)]);

  // repository drift since staging
  const currentSchema = readFileSync(join(root, SCHEMA_PATH), 'utf8');
  must(sha(currentSchema) === manifest.repo.schemaSha256, 'SOURCE_SCHEMA_DRIFT');
  const tracked = readTree(join(root, CLIENT_DIR));
  must(treeHash(tracked) === manifest.repo.clientTreeSha256, 'TRACKED_CLIENT_DRIFT');
  for (const [dir, expected] of Object.entries(manifest.repo.watched)) must((existsSync(join(root, dir)) ? treeHash(readTree(join(root, dir))) : null) === expected, 'WATCHED_TREE_DRIFT');
  // staged drift
  const stagedSchemaPath = join(stage, manifest.staged.schemaFile), stagedClient = join(stage, manifest.staged.clientDir);
  const stagedSchema = readFileSync(stagedSchemaPath, 'utf8');
  must(sha(stagedSchema) === manifest.staged.proposedSchemaSha256 && stagedSchema === applyApprovedChange(currentSchema) && isSingleLineInsertion(currentSchema, stagedSchema), 'STAGED_SCHEMA_DRIFT');
  const stagedTree = readTree(stagedClient);
  must(treeHash(stagedTree) === manifest.staged.proposedTreeSha256, 'STAGED_CLIENT_DRIFT');
  const delta = compareTrees(tracked, stagedTree);
  must(!delta.added.length && !delta.deleted.length && isDeepStrictEqual(delta.changed, sorted(CHANGED_ALLOWLIST)), 'STAGED_DELTA_NOT_ALLOWLIST');
  for (const file of CHANGED_ALLOWLIST) must(sha(readFileSync(join(stagedClient, file))) === manifest.staged.files[`${CLIENT_DIR}/${file}`], 'STAGED_CLIENT_DRIFT');
  must(tracked.get(ENGINE_FILE) === stagedTree.get(ENGINE_FILE), 'ENGINE_BINARY_CHANGED');
  // Only canonicalized candidate bytes may be promoted: no private-stage path anywhere, class.ts is the canonicalized (not raw) file.
  for (const file of CHANGED_ALLOWLIST) must(!readFileSync(join(stagedClient, file)).includes(Buffer.from(STAGE_PREFIX)), 'STAGED_PATH_LEAK');
  must(manifest.staged.canonicalClassSha256 === stagedTree.get(CLASS_FILE) && manifest.staged.rawClassSha256 !== manifest.staged.canonicalClassSha256, 'STAGED_RAW_ARTIFACT');
  verifyCorrespondence(stagedClient, stagedSchema, true);

  // write only the allowlist; roll back everything on any failure
  const contents = new Map([[SCHEMA_PATH, stagedSchema], ...CHANGED_ALLOWLIST.map(file => [`${CLIENT_DIR}/${file}`, readFileSync(join(stagedClient, file))])]);
  const backups = new Map(targets.map(([rel, target]) => [rel, readFileSync(target)]));
  const done = [];
  try {
    for (const [rel, target] of targets) {
      const temporary = `${target}.promote-${randomBytes(4).toString('hex')}.tmp`;
      writeFile(temporary, contents.get(rel));
      rename(temporary, target);
      done.push(rel);
    }
  } catch {
    for (const rel of done) writeFileSync(resolve(root, rel), backups.get(rel));
    for (const [, target] of targets) for (const name of readdirSync(dirname(target))) if (name.startsWith(`${basename(target)}.promote-`)) rmSync(join(dirname(target), name), { force: true });
    return fail('PROMOTION_FAILED_ROLLED_BACK');
  }
  const after = readTree(join(root, CLIENT_DIR));
  must(sha(readFileSync(join(root, SCHEMA_PATH))) === manifest.staged.proposedSchemaSha256 && treeHash(after) === manifest.staged.proposedTreeSha256, 'POST_PROMOTION_MISMATCH');
  for (const [dir, expected] of Object.entries(manifest.repo.watched)) must((existsSync(join(root, dir)) ? treeHash(readTree(join(root, dir))) : null) === expected, 'WATCHED_TREE_CHANGED');
  return { promoted: [...PROMOTION_ALLOWLIST], clientTreeSha256: treeHash(after), schemaSha256: manifest.staged.proposedSchemaSha256 };
}

// ---------------------------------------------------------------- CLI
if (process.argv[1] && basename(process.argv[1]) === 'prisma-client-stage.mjs') {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'stage' && rest.every(arg => arg === '--keep')) {
      const report = stageGeneration(realDeps(), { keep: rest.includes('--keep') });
      console.log(JSON.stringify({ ...report, manifest: undefined }, null, 2));
      process.exit(report.result === 'STAGED_OK' ? 0 : 1);
    } else if (command === 'promote' && rest.length === 2 && rest[1].startsWith('--confirm=')) {
      console.log(JSON.stringify(promoteStaged({ stage: rest[0], confirm: rest[1].slice('--confirm='.length) }), null, 2));
    } else { console.error('usage: prisma-client-stage.mjs stage [--keep] | promote <stageDir> --confirm=<token>'); process.exit(2); }
  } catch (error) { console.error('SAFETY_ABORT', /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'STAGING_FAILED'); process.exit(2); }
}
