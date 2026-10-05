// Synchronous first import: no fixture/client initialization before this returns.
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { isMainThread } = require('node:worker_threads');
// Same rule as network-fence.cjs: a worker thread (e.g. Vitest's threads pool) has no entry script of its own, so it is reverified as a
// loader thread (the receipt, files, history and target are still fully verified); only the entry-script scope check applies to the main thread.
const result = spawnSync(process.execPath, [join(__dirname, 'entry-check.mjs'), isMainThread ? (process.argv[1] || '') : '--loader-thread', JSON.stringify(process.argv.slice(2))], {
  env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', maxBuffer: 1024 * 1024,
});
if (result.status !== 0) throw new Error('DB_SAFETY_ENTRY_DENIED: use the disposable receipt launcher.');
require('./network-fence.cjs');
