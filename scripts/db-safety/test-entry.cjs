// Synchronous first import: no fixture/client initialization before this returns.
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const result = spawnSync(process.execPath, [join(__dirname, 'entry-check.mjs'), process.argv[1] || '', JSON.stringify(process.argv.slice(2))], {
  env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', maxBuffer: 1024 * 1024,
});
if (result.status !== 0) throw new Error('DB_SAFETY_ENTRY_DENIED: use the disposable receipt launcher.');
require('./network-fence.cjs');
