// Defense in depth for JS clients. Native drivers/admin credentials are not a sandbox.
const fs = require('node:fs');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { isMainThread } = require('node:worker_threads');
const checked = spawnSync(process.execPath, [join(__dirname, 'entry-check.mjs'), isMainThread ? (process.argv[1] || '') : '--loader-thread', JSON.stringify(process.argv.slice(2))], {env:{...process.env,NODE_OPTIONS:''},encoding:'utf8'});
if (checked.status !== 0) throw new Error('DB_SAFETY_NETWORK_ENTRY_DENIED: ' + (checked.stderr.match(/SAFETY_ABORT ([A-Z_]+)/)?.[1] || 'VERIFICATION_FAILED'));
const receipt = JSON.parse(fs.readFileSync(process.env.DB_SAFETY_RECEIPT, 'utf8'));
const ports = new Set([receipt.postgres.port, ...receipt.providers.map(p => p.port)].map(Number));
const fixedEnvironment = Object.fromEntries(['DATABASE_URL','REDIS_HOST','REDIS_PORT','MINIO_ENDPOINT'].map(k=>[k,process.env[k]]));
const runtimeAuthority = require('./runtime-authority.cjs');
if (process.env.G1_RUNTIME_ROLE) require('./runtime-compilers.cjs').install();
if (process.env.G1_RUNTIME_ROLE) {
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function(...args) {
    const r = runtimeAuthority.receipt(); runtimeAuthority.environment(r);
    if (process.env.G1_COMPILER_CLAIM) throw Error('RUNTIME_COMPILER_LISTEN_DENIED');
    const spec = r.roles[process.env.G1_RUNTIME_ROLE];
    const port = typeof args[0] === 'object' ? args[0].port : args[0];
    const host = typeof args[0] === 'object' ? args[0].host : args[1];
    if (!spec?.port || Number(port) !== spec.port || host !== '127.0.0.1') throw Error('RUNTIME_LISTEN_TARGET_DENIED');
    return listen.apply(this,args);
  };
}
const emit = net.Server.prototype.emit;
net.Server.prototype.emit = function(event, ...args) {
  if(event==='listening') { const address=this.address(); if(address&&typeof address==='object')ports.add(address.port); }
  return emit.call(this,event,...args);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  for(const [k,v] of Object.entries(fixedEnvironment))if(process.env[k]!==v)throw new Error('DB_SAFETY_ENVIRONMENT_CHANGED');
  const options=net._normalizeArgs(Array.isArray(args[0]) ? args[0] : args)[0];
  const ownedRuntimePorts = process.env.G1_RUNTIME_RECEIPT ? runtimeAuthority.ports() : [];
  if(options.path || !['127.0.0.1','localhost','::1'].includes(options.host||'localhost') || !(ports.has(Number(options.port)) || ownedRuntimePorts.includes(Number(options.port))))throw new Error('DB_SAFETY_NETWORK_TARGET_DENIED');
  return connect.apply(this,args);
};

// Prisma's native engine bypasses net.Socket. Gate its constructor independently.
// Do not edit generated client code. Intercept the installed runtime factory.
const Module = require('node:module');
const load = Module._load;
const factories = new WeakMap();
Module._load = function(id, parent, isMain) {
  const exported = load.call(this, id, parent, isMain);
  if (/^@prisma\/client\/runtime\/(library|client)/.test(id)) {
    if (!factories.has(exported)) factories.set(exported, new Proxy(exported, {
      get(target, key) {
        if (key !== 'getPrismaClient') return Reflect.get(target, key);
        return config => {
          const Client = target.getPrismaClient(config);
          return class VerifiedPrismaClient extends Client {
            constructor(options = {}) {
              const expected = fixedEnvironment.DATABASE_URL;
              if (process.env.DATABASE_URL !== expected || options.adapter || options.accelerateUrl ||
                  (options.datasourceUrl && options.datasourceUrl !== expected) ||
                  (options.datasources && (Object.keys(options.datasources).some(k => k !== 'db') ||
                    options.datasources.db?.url !== expected))) {
                throw new Error('DB_SAFETY_PRISMA_DATASOURCE_DENIED');
              }
              // Always provide a literal verified URL; generated dotenv paths cannot redirect it.
              const { datasourceUrl: ignored, ...safeOptions } = options;
              super({...safeOptions, datasources:{db:{url:expected}}});
            }
          };
        };
      }
    }));
    return factories.get(exported);
  }
  return exported;
};

// Exercise listen rejection inside a real receipt-owned compiler during the
// independent safety rehearsal. This never calls the native bind path.
if (process.env.G1_COMPILER_CLAIM) {
  const r = runtimeAuthority.receipt();
  if (r.mode === 'safety') {
    let denied = false;
    try { net.createServer().listen(r.roles.web.port, '127.0.0.1'); }
    catch (error) { if (error.message !== 'RUNTIME_COMPILER_LISTEN_DENIED') throw error; denied = true; }
    if (!denied) throw Error('RUNTIME_COMPILER_LISTEN_GUARD_FAILED');
    require('./runtime-compilers.cjs').recordState(r, process.env.G1_COMPILER_CLAIM, 'listenDenied', true);
  }
}
