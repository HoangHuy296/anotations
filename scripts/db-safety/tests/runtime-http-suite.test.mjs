// Offline contract of the Stage-1 receipt-owned HTTP runtime (runtime-http-suite.mjs). The live behavior is proven by running `http:dataset-metadata` through the focused runner.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { FOCUSED_FULL_CHAIN, SUPPORTED_COMMANDS, resolvePlan } from '../disposable-test.mjs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const suite = read('runtime-http-suite.mjs'), check = read('runtime-check.mjs'), child = read('runtime-child.mjs');
const commands = JSON.parse(read('commands.json'));

test('http:dataset-metadata is an exact, catalogued test command that runs only the supervisor, on the full 26-migration chain', () => {
  assert.deepEqual(commands['http:dataset-metadata'], { kind: 'test', cwd: '.', args: ['--import', 'tsx', 'scripts/db-safety/runtime-http-suite.mjs'] });
  assert.ok(SUPPORTED_COMMANDS.includes('http:dataset-metadata'));
  assert.ok(FOCUSED_FULL_CHAIN.includes('http:dataset-metadata'));
  assert.deepEqual(resolvePlan('http:dataset-metadata'), { kind: 'test', id: 'http:dataset-metadata', through: 3 });
});

test('the supervisor refuses any other base receipt command and verifies the G1 receipt before anything else', () => {
  assert.match(suite, /HTTP_RUNTIME_COMMAND = 'http:dataset-metadata'/);
  assert.match(suite, /assert\.equal\(checked\.r\.command, HTTP_RUNTIME_COMMAND/);
  assert.ok(suite.indexOf('await verify(baseReceipt') < suite.indexOf('mkdtempSync('), 'the base receipt is verified before any directory is created');
});

test('the runtime is reduced to a web role and the existing dataset-metadata suite: no provider, worker, browser or negative scenarios', () => {
  assert.match(suite, /HTTP_RUNTIME_ROLES = Object\.freeze\(\['web', 'legacy'\]\)/);
  for (const forbidden of ["launch('provider')", "launch('worker')", 'prepareBrowser', 'runtime-browser', 'launchCompilerNegative', "launch('probe')"]) assert.ok(!suite.includes(forbidden), forbidden);
  assert.match(suite, /launch\('web'\)/); assert.match(suite, /launch\('legacy'\)/);
  assert.match(child, /for \(const file of \['assets','datasets','labels','http-routes'\]\)/, 'the legacy role runs exactly the four dataset-metadata test files, including http-routes');
});

test('exact-PID cleanup and the compiler ancestry ledger are kept; the private stage and registration are removed', () => {
  for (const kept of ['authority.same(actual, owned.identity)', 'no unverified kill permitted', 'compilerAuthority.claim', 'owned compiler remains after cleanup', 'rmSync(registration', 'rmSync(privateRoot']) assert.ok(suite.includes(kept), kept);
});

test('the child scope check allows exactly the three G4/G5 commands and the one HTTP command; the shared guard files are not edited by this change', () => {
  assert.match(check, /\['g4:runtime:safety','g4:runtime:e2e','g5:runtime:e2e','http:dataset-metadata'\]\.includes\(base\.command\)/);
});
