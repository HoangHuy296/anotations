import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OUTPUT_LIMIT, boundedRedacted, describeChild, runCompatibilityChecks } from '../g2-compat-runner.mjs';

// Fake spawn only: no Prisma, database, container or network.
const CHECKS = [{ name: 'migrate-diff' }, { name: 'migrate-status' }];
const harness = outcomes => {
  const calls = [], lines = []; let t = 0;
  const spawn = check => { calls.push(check.name); const next = outcomes[calls.length - 1]; if (typeof next === 'function') return next(); return next; };
  const run = options => { try { return { records: runCompatibilityChecks(CHECKS, spawn, { log: line => lines.push(line), now: () => (t += 7), ...options }) }; } catch (error) { return { error }; } };
  return { calls, lines, run };
};
const jsonLines = lines => lines.filter(line => line.startsWith('G2_COMPAT_CHECK ')).map(line => JSON.parse(line.slice('G2_COMPAT_CHECK '.length)));

test('normal exit: both checks run once, each is recorded with identity, spawn success, status 0, no signal and duration', () => {
  const h = harness([{ status: 0, signal: null, stdout: '', stderr: 'Loaded Prisma config\n' }, { status: 0, signal: null, stdout: 'Database schema is up to date!\n', stderr: '' }]);
  const { records, error } = h.run();
  assert.equal(error, undefined);
  assert.deepEqual(h.calls, ['migrate-diff', 'migrate-status']);
  assert.deepEqual(records.map(record => [record.check, record.outcome, record.spawned, record.spawnErrorCode, record.status, record.signal]), [['migrate-diff', 'EXIT_0', true, null, 0, null], ['migrate-status', 'EXIT_0', true, null, 0, null]]);
  assert.ok(records.every(record => Number.isInteger(record.durationMs) && record.durationMs >= 0));
  assert.deepEqual(jsonLines(h.lines).map(record => record.check), ['migrate-diff', 'migrate-status']);
  // Legacy combined output is still printed, unchanged, before each record.
  assert.equal(h.lines[0], 'Loaded Prisma config\n'); assert.equal(h.lines[2], 'Database schema is up to date!\n');
});

test('non-zero exit fails closed with the exact error, records status and output, and does not run later checks or retry', () => {
  const h = harness([{ status: 2, signal: null, stdout: 'drift detected\n', stderr: 'Loaded Prisma config\n' }, { status: 0 }]);
  const { error } = h.run();
  assert.equal(error.message, 'G2_SCHEMA_COMPATIBILITY_FAILED');
  assert.deepEqual(h.calls, ['migrate-diff']); // never retried, status check not reached
  const [record] = error.compatibilityRecords;
  assert.equal(record.outcome, 'EXIT_NONZERO'); assert.equal(record.status, 2); assert.equal(record.signal, null); assert.equal(record.spawned, true);
  assert.equal(record.stdout.text, 'drift detected\n'); assert.equal(record.stderr.text, 'Loaded Prisma config\n');
  assert.equal(jsonLines(h.lines).length, 1);
});

test('signal termination is recorded as KILLED_BY_SIGNAL with the signal name, and fails closed', () => {
  const h = harness([{ status: null, signal: 'SIGKILL', stdout: '', stderr: 'Loaded Prisma config from /tmp/x/compatibility.config.ts.\n' }]);
  const { error } = h.run();
  assert.equal(error.message, 'G2_SCHEMA_COMPATIBILITY_FAILED');
  const [record] = error.compatibilityRecords;
  assert.equal(record.outcome, 'KILLED_BY_SIGNAL'); assert.equal(record.signal, 'SIGKILL'); assert.equal(record.status, null); assert.equal(record.spawned, true);
  assert.deepEqual(h.calls, ['migrate-diff']);
});

test('spawn failure (error object) is recorded as SPAWN_FAILED with its code, and fails closed', () => {
  const h = harness([{ error: Object.assign(Error('spawn node ENOENT'), { code: 'ENOENT' }), status: null, signal: null, stdout: null, stderr: null }]);
  const { error } = h.run();
  assert.equal(error.message, 'G2_SCHEMA_COMPATIBILITY_FAILED');
  const [record] = error.compatibilityRecords;
  assert.equal(record.outcome, 'SPAWN_FAILED'); assert.equal(record.spawned, false); assert.equal(record.spawnErrorCode, 'ENOENT'); assert.equal(record.status, null);
  assert.equal(record.stdout.text, '');
});

test('a spawn that throws synchronously is recorded as SPAWN_FAILED and fails closed (never an unhandled crash without evidence)', () => {
  const h = harness([() => { throw Object.assign(Error('boom'), { code: 'EAGAIN' }); }]);
  const { error } = h.run();
  assert.equal(error.message, 'G2_SCHEMA_COMPATIBILITY_FAILED');
  assert.equal(error.compatibilityRecords[0].outcome, 'SPAWN_FAILED'); assert.equal(error.compatibilityRecords[0].spawnErrorCode, 'EAGAIN');
  assert.equal(jsonLines(h.lines).length, 1);
});

test('no exit status and no signal is still a failure (NO_EXIT_STATUS), never a pass', () => {
  const { error } = harness([{ status: null, signal: null, stdout: '', stderr: '' }]).run();
  assert.equal(error.compatibilityRecords[0].outcome, 'NO_EXIT_STATUS');
  assert.equal(error.message, 'G2_SCHEMA_COMPATIBILITY_FAILED');
});

test('failure of the second check keeps the first check\'s passing record and stops', () => {
  const h = harness([{ status: 0, stdout: '', stderr: '' }, { status: 1, signal: null, stdout: 'Following migration have not yet been applied\n', stderr: '' }]);
  const { error } = h.run();
  assert.deepEqual(error.compatibilityRecords.map(record => record.outcome), ['EXIT_0', 'EXIT_NONZERO']);
  assert.deepEqual(h.calls, ['migrate-diff', 'migrate-status']);
});

test('output is bounded (tail kept, truncation reported) and redacted (database URLs and literal secrets)', () => {
  const big = 'x'.repeat(10000) + ' tail postgresql://user:hunter2pw@127.0.0.1:55460/fieldframe end';
  const bounded = boundedRedacted(big);
  assert.equal(bounded.truncated, true); assert.ok(bounded.text.length <= OUTPUT_LIMIT); assert.ok(bounded.totalChars > OUTPUT_LIMIT);
  assert.ok(bounded.text.endsWith('end')); assert.equal(bounded.text.includes('hunter2pw'), false); assert.ok(bounded.text.includes('[REDACTED_DATABASE_URL]'));
  const small = boundedRedacted('password was s3cretvalue here', OUTPUT_LIMIT, ['s3cretvalue']);
  assert.equal(small.text, 'password was [REDACTED] here'); assert.equal(small.truncated, false);
  const record = describeChild('c', { status: 1, signal: null, stdout: 'a s3cretvalue b', stderr: 'postgres://u:p4ssword@h/db' }, 3.4, ['s3cretvalue']);
  assert.equal(JSON.stringify(record).includes('s3cretvalue'), false); assert.equal(JSON.stringify(record).includes('p4ssword'), false);
  assert.equal(record.durationMs, 3);
});

test('printed legacy output is also bounded-safe: secrets never reach the log', () => {
  const h = harness([{ status: 1, signal: null, stdout: 'leak s3cretvalue\n', stderr: '' }]);
  h.run({ secrets: ['s3cretvalue'] });
  assert.equal(h.lines.join('\n').includes('s3cretvalue'), false);
});

test('failures are never downgraded: no warning path, the thrown error is exact, and the script keeps its client-field gate', () => {
  const source = readFileSync(new URL('../g2-compat-runner.mjs', import.meta.url), 'utf8').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.equal(/retry|retries|warn/i.test(source), false);
  const script = readFileSync(new URL('../g2-compatibility.mjs', import.meta.url), 'utf8');
  assert.match(script, /import \{runCompatibilityChecks\} from '\.\/g2-compat-runner\.mjs';/);
  assert.match(script, /runCompatibilityChecks\(checks,/);
  assert.match(script, /must\(client\.includes\(name\),'G2_CLIENT_FIELD_MISSING'\)/);
  assert.match(script, /'--exit-code'\]/);
  assert.match(script, /PGOPTIONS:'-c default_transaction_read_only=on'/);
  assert.equal(/catch\s*\(/.test(script), false);
  const commands = JSON.parse(readFileSync(new URL('../commands.json', import.meta.url), 'utf8'));
  assert.ok(commands['g2:compatibility']);
});
