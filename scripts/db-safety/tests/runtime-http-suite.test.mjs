// Offline contract of the Stage-1 receipt-owned HTTP runtime (runtime-http-suite.mjs). The live behavior is proven by running `web:test:dataset-metadata` through the focused runner.
// The supervisor verifies a G1 receipt at import time, so its contract is checked from its source text and the shared catalog, never by importing it.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { FOCUSED_FULL_CHAIN, SUPPORTED_COMMANDS, resolvePlan } from '../disposable-test.mjs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const suite = read('runtime-http-suite.mjs'), check = read('runtime-check.mjs'), child = read('runtime-child.mjs');
const commands = JSON.parse(read('commands.json'));
const metadataDir = new URL('../../../apps/web/tests/dataset-metadata/', import.meta.url);
const declared = file => (readFileSync(new URL(`${file}.test.ts`, metadataDir), 'utf8').match(/^test\(/gm) ?? []).length;
const roleFiles = JSON.parse(/HTTP_RUNTIME_ROLE_FILES = Object\.freeze\((\{.*\})\);/.exec(suite)[1].replace(/'/g, '"').replace(/(^|[{,]\s*)("?)([\w-]+)\2:/g, '$1"$3":'));

test('web:test:dataset-metadata is the one guarded command for the complete contract: it enters the HTTP-runtime supervisor on the full 26-migration chain', () => {
  assert.deepEqual(commands['web:test:dataset-metadata'], { kind: 'test', cwd: '.', args: ['--import', 'tsx', 'scripts/db-safety/runtime-http-suite.mjs'] });
  assert.equal(commands['http:dataset-metadata'], undefined, 'no second command for the same contract');
  assert.ok(SUPPORTED_COMMANDS.includes('web:test:dataset-metadata')); assert.ok(!SUPPORTED_COMMANDS.includes('http:dataset-metadata'));
  assert.ok(FOCUSED_FULL_CHAIN.includes('web:test:dataset-metadata'));
  assert.deepEqual(resolvePlan('web:test:dataset-metadata'), { kind: 'test', id: 'web:test:dataset-metadata', through: 3 });
  assert.match(suite, /HTTP_RUNTIME_COMMAND = 'web:test:dataset-metadata'/);
});

test('file coverage is exactly the directory: every dataset-metadata test file runs in exactly one role, nothing is skipped or counted twice (21 declared tests)', () => {
  const onDisk = readdirSync(metadataDir).filter(name => name.endsWith('.test.ts')).map(name => name.slice(0, -'.test.ts'.length)).sort();
  const assigned = Object.values(roleFiles).flat();
  assert.deepEqual([...assigned].sort(), onDisk, 'every file is assigned once');
  assert.equal(new Set(assigned).size, assigned.length, 'no file is assigned to two roles');
  assert.equal(assigned.reduce((sum, file) => sum + declared(file), 0), 21, 'the contract is 21 tests');
  assert.deepEqual(roleFiles.legacy, ['assets', 'datasets', 'labels', 'http-routes']);
  assert.match(child, /for \(const file of \['assets','datasets','labels','http-routes'\]\)/, 'the legacy role runs exactly those four files (unchanged for G4/G5)');
  assert.match(child, /role === 'dataset-patch'[\s\S]*dataset-patch-route\.test\.ts/, 'the additive role runs the fifth file');
  assert.match(suite, /HTTP_RUNTIME_ROLES = Object\.freeze\(\['web', 'legacy', 'dataset-patch'\]\)/);
});

test('the supervisor checks counts, not just exit codes: executed == declared, pass == declared, fail == 0, skipped == 0', () => {
  for (const required of ['every declared test ran exactly once', "count('pass'), want", "count('fail'), 0", "count('skipped'), 0", 'dataset-metadata-contract-complete']) assert.ok(suite.includes(required), required);
});

test('the supervisor refuses any other base receipt command and verifies the G1 receipt before anything else', () => {
  assert.match(suite, /assert\.equal\(checked\.r\.command, HTTP_RUNTIME_COMMAND/);
  assert.ok(suite.indexOf('await verify(baseReceipt') < suite.indexOf('mkdtempSync('), 'the base receipt is verified before any directory is created');
});

test('isolation: only receipt-owned loopback resources; the canonical port, ambient services and any provider/worker/browser are not part of the runtime', () => {
  assert.match(suite, /HTTP_RUNTIME_WEB_PORT = 55470/); assert.match(suite, /assert\.notEqual\(HTTP_RUNTIME_WEB_PORT, 3000/);
  assert.ok(!/localhost:3000|127\.0\.0\.1:3000/.test(suite), 'the canonical origin never appears');
  for (const forbidden of ["launch('provider')", "launch('worker')", 'prepareBrowser', 'runtime-browser', "launch('probe')", 'DATABASE_URL_DOCKER']) assert.ok(!suite.includes(forbidden), forbidden);
  assert.match(suite, /process\.env\.DATABASE_URL = checked\.target\.url\.toString\(\)/, 'the database is exactly the G1-verified disposable target');
  assert.match(suite, /NODE_OPTIONS: `--require=\$\{join\(root, 'scripts\/db-safety\/network-fence\.cjs'\)\}`/, 'every child runs behind the network fence');
  assert.match(suite, /await verify\(baseReceipt, 'test'\);\s*\n\s*Object\.assign/, 'the disposable target and migration set are re-verified before every child');
});

test('the web port is a fixed loopback port that cannot collide with the receipt-owned PostgreSQL or fall back to another port', () => {
  assert.match(suite, /claimedPorts\.includes\(HTTP_RUNTIME_WEB_PORT\)/); assert.match(suite, /RUNTIME_WEB_PORT_IN_USE/);
  assert.match(suite, /probe\.listen\(HTTP_RUNTIME_WEB_PORT, '127\.0\.0\.1'/);
  assert.ok(suite.indexOf('RUNTIME_WEB_PORT_IN_USE') < suite.indexOf('mkdtempSync('), 'the port is checked before any directory or child exists');
  assert.match(child, /server\.listen\(spec\.port, '127\.0\.0\.1'/, 'the web role listens exactly on its receipt port (EADDRINUSE fails the child, no fallback)');
  assert.ok(!/port:\s*0\b|listen\(0\b|findFreePort|get-port/.test(suite + child), 'no ephemeral or fallback port selection');
});

test('exact-PID cleanup, the compiler ancestry ledger and interruption handling are present; the private stage and registration are removed', () => {
  for (const kept of ['authority.same(actual, owned.identity)', 'no unverified kill permitted', 'compilerAuthority.claim', 'owned compiler remains after cleanup', 'rmSync(registration', 'rmSync(privateRoot', "['SIGINT', 'SIGTERM']", 'authority.same(authority.identity(owned.identity.pid), owned.identity)']) assert.ok(suite.includes(kept), kept);
  assert.ok(!/process\.kill\((?!c\.observed\.pid)/.test(suite), 'the only direct kill targets the verified, identity-checked compiler PID');
  assert.ok(!/pkill|killall|kill -9|SIGKILL/.test(suite), 'no pattern-based or forced kill');
});

test('the child scope check allows exactly the three G4/G5 commands and the one dataset-metadata command', () => {
  assert.match(check, /\['g4:runtime:safety','g4:runtime:e2e','g5:runtime:e2e','web:test:dataset-metadata'\]\.includes\(base\.command\)/);
  assert.ok(!check.includes('http:dataset-metadata'));
});
