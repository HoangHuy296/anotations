import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, cleanEnv } from '../guard.mjs';

const entry = join(root, 'scripts/db-safety/test-entry.cjs');
const run = (script, env = cleanEnv()) => { const dir = mkdtempSync(join(tmpdir(), 'te-')); const file = join(dir, 'probe.cjs'); writeFileSync(file, script); try { return spawnSync(process.execPath, [file], { cwd: root, env, encoding: 'utf8' }); } finally { rmSync(dir, { recursive: true, force: true }); } };

test('test-entry.cjs treats worker threads like network-fence.cjs: loader-thread reverification, main thread keeps the entry-scope check', () => {
  const source = readFileSync(entry, 'utf8');
  const fence = readFileSync(join(root, 'scripts/db-safety/network-fence.cjs'), 'utf8');
  assert.match(source, /isMainThread \? \(process\.argv\[1\] \|\| ''\) : '--loader-thread'/);
  assert.match(fence, /isMainThread \? \(process\.argv\[1\] \|\| ''\) : '--loader-thread'/);
  assert.match(source, /require\('\.\/network-fence\.cjs'\)/, 'the network fence is still installed after the gate');
});

test('without a receipt the gate still denies in the main thread AND in a worker thread (nothing is loosened for unreceipted runs)', () => {
  const main = run(`require(${JSON.stringify(entry)});`);
  assert.notEqual(main.status, 0); assert.match(main.stderr, /DB_SAFETY_ENTRY_DENIED/);
  const worker = run(`
    const { Worker } = require('node:worker_threads');
    const w = new Worker(${JSON.stringify(`require(${JSON.stringify(entry)}); process.exit(0);`)}, { eval: true });
    w.on('error', error => { console.error('WORKER_ERROR ' + error.message); process.exit(3); });
    w.on('exit', code => { if (code === 0) { console.log('WORKER_LOADED'); } process.exit(code === 0 ? 0 : 4); });
  `);
  assert.notEqual(worker.status, 0, worker.stdout + worker.stderr);
  assert.doesNotMatch(worker.stdout, /WORKER_LOADED/);
  assert.match(worker.stderr, /DB_SAFETY_ENTRY_DENIED/);
});

test('a forged or unknown receipt is rejected in a worker thread too, and the loader-thread marker is no bypass of receipt verification', () => {
  const env = { ...cleanEnv(), DB_SAFETY_RECEIPT: '/tmp/does-not-exist-receipt.json' };
  const worker = run(`
    const { Worker } = require('node:worker_threads');
    const w = new Worker(${JSON.stringify(`require(${JSON.stringify(entry)});`)}, { eval: true });
    w.on('error', error => { console.error('WORKER_ERROR ' + error.message); process.exit(3); });
    w.on('exit', code => process.exit(code));
  `, env);
  assert.notEqual(worker.status, 0); assert.match(worker.stderr, /DB_SAFETY_ENTRY_DENIED/);
  const check = spawnSync(process.execPath, [join(root, 'scripts/db-safety/entry-check.mjs'), '--loader-thread', '[]'], { cwd: root, env: { ...cleanEnv(), DB_SAFETY_RECEIPT: '/tmp/does-not-exist-receipt.json' }, encoding: 'utf8' });
  assert.notEqual(check.status, 0); assert.match(check.stderr, /SAFETY_ABORT/);
  const bare = spawnSync(process.execPath, [join(root, 'scripts/db-safety/entry-check.mjs'), '--loader-thread', '[]'], { cwd: root, env: cleanEnv(), encoding: 'utf8' });
  assert.notEqual(bare.status, 0); assert.match(bare.stderr, /RECEIPT_REQUIRED/);
});
