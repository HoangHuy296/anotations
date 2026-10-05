// Synchronous process/socket checks. Full G1 verification runs at child startup.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const fail = code => { throw Error(code); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
function identity(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const uid = Number(/^Uid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]);
  return { pid: Number(pid), parent: Number(fields[1]), start: fields[19], uid };
}
function same(actual, expected) {
  return actual.pid === expected.pid && actual.start === expected.start && actual.uid === expected.uid;
}
function receipt() {
  const p = process.env.G1_RUNTIME_RECEIPT;
  if (!p) fail('RUNTIME_IDENTITY_REQUIRED');
  const stat = fs.statSync(p);
  if ((stat.mode & 0o077) || stat.uid !== process.getuid()) fail('RUNTIME_PRIVATE_RECEIPT_REQUIRED');
  const r = read(p);
  if (!/^[a-f0-9-]{36}$/.test(r.id || '')) fail('RUNTIME_RECEIPT_INVALID');
  const registration = read(`/tmp/annotation-platform-db-safety-${process.getuid()}/runtime-${r.id}.json`);
  if (registration.path !== fs.realpathSync(p) || registration.hash !== hash(fs.readFileSync(p))) fail('RUNTIME_RECEIPT_MISMATCH');
  if (Date.now() >= Date.parse(r.expiresAt)) fail('RUNTIME_RECEIPT_STALE');
  if (!same(identity(r.owner.pid), r.owner)) fail('RUNTIME_OWNER_CHANGED');
  if (r.baseReceipt !== process.env.DB_SAFETY_RECEIPT) fail('RUNTIME_BASE_RECEIPT_MISMATCH');
  if (hash(fs.readFileSync(r.config)) !== r.configHash) fail('RUNTIME_CONFIG_CHANGED');
  return r;
}
function environment(r) {
  const env = read(r.config);
  for (const [key, value] of Object.entries(env)) if (process.env[key] !== value) fail('RUNTIME_ENVIRONMENT_MISMATCH');
  for (const key of ['DATABASE_URL_DOCKER','DIRECT_URL','SHADOW_DATABASE_URL','REDIS_URL','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD']) {
    if (process.env[key]) fail('RUNTIME_UNVERIFIED_ENVIRONMENT');
  }
  return env;
}
function ports() {
  const r = receipt(); environment(r);
  const allowed = [];
  for (const [role, spec] of Object.entries(r.roles)) {
    if (!spec.port) continue;
    const file = path.join(r.ledger, `${role}.json`);
    if (!fs.existsSync(file)) continue;
    const record = read(file);
    if (record.runtime !== r.id || record.role !== role || !same(identity(record.pid), record)) fail('RUNTIME_PROCESS_CHANGED');
    allowed.push(spec.port);
  }
  return allowed;
}
module.exports = { identity, same, receipt, environment, ports, hash, read, fail };
