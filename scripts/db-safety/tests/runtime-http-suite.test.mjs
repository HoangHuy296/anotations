// Offline contract of the receipt-owned disposable HTTP runtime (runtime-http-suite.mjs). The live behavior is proven by running its commands through the focused runner.
// The supervisor verifies a G1 receipt at import time, so its contract is checked from its source text and the shared catalog, never by importing it.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { FOCUSED_FULL_CHAIN, SUPPORTED_COMMANDS, resolvePlan } from '../disposable-test.mjs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const suite = read('runtime-http-suite.mjs'), check = read('runtime-check.mjs'), child = read('runtime-child.mjs');
const commands = JSON.parse(read('commands.json'));
const testsDir = new URL('../../../apps/web/tests/', import.meta.url);
const metadataDir = new URL('dataset-metadata/', testsDir);
const declared = path => (readFileSync(new URL(path, testsDir), 'utf8').match(/^test\(/gm) ?? []).length;
const quoted = text => [...text.matchAll(/'([^']+)'/g)].map(match => match[1]);
const roleFilesText = /roleFiles: Object\.freeze\((\{.*?\})\), dir:/.exec(suite)[1];
const roleFiles = { legacy: quoted(/legacy: \[(.*?)\]/.exec(roleFilesText)[1]), 'dataset-patch': quoted(/'dataset-patch': \[(.*?)\]/.exec(roleFilesText)[1]) };
const integrationFiles = quoted(/WORKSPACE_INTEGRATION_FILES = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(suite)[1]);
const childApproved = quoted(/const approved = new Set\(\[([\s\S]*?)\]\);/.exec(child)[1]);
const APPROVED_COMMANDS = ['web:test:dataset-metadata', 'web:test:workspace-integration'];

test('both commands are exact catalogued tests that run only the supervisor, on the full 26-migration chain; no interim command remains', () => {
  for (const name of APPROVED_COMMANDS) {
    assert.deepEqual(commands[name], { kind: 'test', cwd: '.', args: ['--import', 'tsx', 'scripts/db-safety/runtime-http-suite.mjs'] }, name);
    assert.ok(SUPPORTED_COMMANDS.includes(name), name); assert.ok(FOCUSED_FULL_CHAIN.includes(name), name);
    assert.deepEqual(resolvePlan(name), { kind: 'test', id: name, through: 3 }, name);
    assert.ok(suite.includes(`'${name}':`), `${name} is in the supervisor's approved table`);
  }
  assert.equal(commands['http:dataset-metadata'], undefined); assert.ok(!SUPPORTED_COMMANDS.includes('http:dataset-metadata'));
  assert.deepEqual([...suite.matchAll(/^  '(web:test:[a-z-]+)': Object\.freeze\(\{ flags/gm)].map(match => match[1]), APPROVED_COMMANDS, 'the supervisor approves exactly these commands');
});

test('dataset-metadata: file coverage is exactly the directory, every file runs in exactly one role, nothing is skipped or counted twice (21 declared tests)', () => {
  const onDisk = readdirSync(metadataDir).filter(name => name.endsWith('.test.ts')).map(name => name.slice(0, -'.test.ts'.length)).sort();
  const assigned = Object.values(roleFiles).flat();
  assert.deepEqual([...assigned].sort(), onDisk, 'every file is assigned once');
  assert.equal(new Set(assigned).size, assigned.length, 'no file is assigned to two roles');
  assert.equal(assigned.reduce((sum, file) => sum + declared(`dataset-metadata/${file}.test.ts`), 0), 21, 'the contract is 21 tests');
  assert.deepEqual(roleFiles.legacy, ['assets', 'datasets', 'labels', 'http-routes']);
  assert.match(child, /for \(const file of \['assets','datasets','labels','http-routes'\]\)/, 'the legacy role runs exactly those four files (unchanged for G4/G5)');
  assert.match(child, /role === 'dataset-patch'[\s\S]*dataset-patch-route\.test\.ts/, 'the additive role runs the fifth file');
  assert.match(suite, /HTTP_RUNTIME_ROLES = Object\.freeze\(\['web', 'legacy', 'dataset-patch', 'suite'\]\)/);
});

test('workspace-integration: the suite list equals the child allowlist, exists on disk, has no duplicates, and covers every TEXT suite file', () => {
  assert.deepEqual([...childApproved].sort(), [...integrationFiles].sort(), 'the supervisor list and the child allowlist are the same');
  assert.equal(new Set(integrationFiles).size, integrationFiles.length, 'no file twice');
  for (const file of integrationFiles) assert.ok(existsSync(new URL(file, testsDir)), file);
  for (const dir of ['text-annotations', 'text-source']) {
    const onDisk = readdirSync(new URL(`${dir}/`, testsDir)).filter(name => name.endsWith('.test.ts')).map(name => `${dir}/${name}`);
    for (const file of onDisk) assert.ok(integrationFiles.includes(file), `${file} is part of the TEXT coverage`);
  }
  for (const file of ['annotation-api/annotation-service.test.ts', 'workspace/annotation-mutations.test.ts', 'workspace/annotation-locking.test.ts', 'workspace/video-engine-read.test.ts', 'annotation-api/text-generic-reader.test.ts']) assert.ok(integrationFiles.includes(file), file);
  assert.match(child, /role === 'suite'/); assert.match(child, /RUNTIME_SUITE_FILE_UNAPPROVED/); assert.match(child, /files\.length !== 1/);
});

test('workspace-integration: exactly the three opt-in flags, only inside the receipt-verified environment, a disposable bucket, and zero skips', () => {
  const flags = /'web:test:workspace-integration': Object\.freeze\(\{ flags: Object\.freeze\(\{([^}]*)\}\)/.exec(suite)[1];
  assert.deepEqual([...flags.matchAll(/(\w+): '1'/g)].map(match => match[1]).sort(), ['ANNOTATION_API_INTEGRATION_TESTS', 'VIDEO_VIEW_INTEGRATION_TESTS', 'WORKSPACE_INTEGRATION_TESTS']);
  assert.match(suite, /\.\.\.PLAN\.flags/, 'the flags are spread into the runtime environment config (which every child must match exactly)');
  assert.match(suite, /makeBucket\(checked\.env\.MINIO_BUCKET\)/); assert.match(suite, /\/\^g1-\[a-z0-9-\]\+\$\//); assert.match(suite, /127\\\.0\\\.0\\\.1/);
  for (const required of ["problems.push('skipped tests')", "problems.push('todo tests')", "problems.push('a declared test did not run')", "problems.push('not all passed')", 'suites with problems:']) assert.ok(suite.includes(required), required);
  assert.match(suite, /key === 'G1_RUNTIME_SUITE_FILES'/, 'a child receives no other extra environment');
  // the VIDEO view test keeps its Compose topology and gains the runtime topology without weakening an assertion
  const view = readFileSync(new URL('workspace/video-engine-read.test.ts', testsDir), 'utf8');
  assert.match(view, /expectedViewHosts\.includes\(new URL\(body\.data\.viewUrl\)\.host\)/); assert.match(view, /\["localhost:9000", "127\.0\.0\.1:9000"\]/);
  assert.match(view, /enabled && process\.env\.G1_RUNTIME_RECEIPT \? authority\.receipt\(\) : null/);
});

test('the supervisor checks counts, not just exit codes: executed == declared, pass == declared, fail == 0, skipped == 0', () => {
  for (const required of ['every declared test ran exactly once', "tap(output, 'pass'), want", "tap(output, 'fail'), 0", "tap(output, 'skipped'), 0", 'dataset-metadata-contract-complete']) assert.ok(suite.includes(required), required);
});

test('the supervisor refuses any other base receipt command and verifies the G1 receipt before anything else', () => {
  assert.match(suite, /Object\.hasOwn\(HTTP_RUNTIME_COMMANDS, COMMAND\)/); assert.match(suite, /assert\.ok\(PLAN,/);
  assert.ok(suite.indexOf('await verify(baseReceipt') < suite.indexOf('mkdtempSync('), 'the base receipt is verified before any directory is created');
});

test('isolation: only receipt-owned loopback resources; the canonical port, ambient services and any provider/worker/browser are not part of the runtime', () => {
  assert.match(suite, /HTTP_RUNTIME_WEB_PORT = 55470/); assert.match(suite, /assert\.notEqual\(HTTP_RUNTIME_WEB_PORT, 3000/);
  assert.ok(!/localhost:3000|127\.0\.0\.1:3000/.test(suite), 'the canonical origin never appears');
  for (const forbidden of ["launch('provider')", "launch('worker')", 'prepareBrowser', 'runtime-browser', "launch('probe')", 'DATABASE_URL_DOCKER']) assert.ok(!suite.includes(forbidden), forbidden);
  assert.match(suite, /process\.env\.DATABASE_URL = checked\.target\.url\.toString\(\)/, 'the database is exactly the G1-verified disposable target');
  assert.match(suite, /NODE_OPTIONS: `--require=\$\{join\(root, 'scripts\/db-safety\/network-fence\.cjs'\)\}`/, 'every child runs behind the network fence');
  assert.match(suite, /await verify\(baseReceipt, 'test'\);\s*\n\s*Object\.assign/, 'the disposable target and migration set are re-verified before every child');
  assert.match(suite, /claimedPorts\.includes\(HTTP_RUNTIME_WEB_PORT\)/); assert.match(suite, /RUNTIME_WEB_PORT_IN_USE/);
  assert.match(child, /server\.listen\(spec\.port, '127\.0\.0\.1'/, 'the web role listens exactly on its receipt port (no fallback)');
  assert.ok(!/port:\s*0\b|listen\(0\b|findFreePort|get-port/.test(suite + child), 'no ephemeral or fallback port selection');
});

test('exact-PID cleanup, the compiler ancestry ledger and interruption handling are present; no pattern-based or forced kill', () => {
  for (const kept of ['authority.same(actual, owned.identity)', 'no unverified kill permitted', 'compilerAuthority.claim', 'owned compiler remains after cleanup', 'rmSync(registration', 'rmSync(privateRoot', "['SIGINT', 'SIGTERM']", 'authority.same(authority.identity(owned.identity.pid), owned.identity)']) assert.ok(suite.includes(kept), kept);
  assert.ok(!/process\.kill\((?!c\.observed\.pid)/.test(suite), 'the only direct kill targets the verified, identity-checked compiler PID');
  assert.ok(!/pkill|killall|kill -9|SIGKILL/.test(suite), 'no pattern-based or forced kill');
});

test('the child scope check allows exactly the three G4/G5 commands and the two approved HTTP-runtime commands', () => {
  assert.match(check, /\['g4:runtime:safety','g4:runtime:e2e','g5:runtime:e2e','web:test:dataset-metadata','web:test:workspace-integration'\]\.includes\(base\.command\)/);
  assert.ok(!check.includes('http:dataset-metadata'));
});
