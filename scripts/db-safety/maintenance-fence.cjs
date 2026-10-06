// Defense in depth for the Phase029 maintenance child (apps/web/scripts/backfill-run.ts), loaded with --require by backfill-launcher.mjs.
// It restricts JS sockets to the exact host:port pairs the launcher bound, and pins the Prisma datasource to the launcher's verified URL.
// Native drivers are not a sandbox; the launcher's identity checks come first, this only narrows what a bug could reach.
const net = require('node:net');
const Module = require('node:module');

const allowed = (() => {
  try { const list = JSON.parse(process.env.BACKFILL_ALLOWED_ENDPOINTS || ''); if (Array.isArray(list) && list.length && list.every(item => typeof item === 'string' && /^[A-Za-z0-9.-]+:\d{1,5}$/.test(item))) return new Set(list); } catch { /* fall through */ }
  throw new Error('MAINTENANCE_FENCE_ENDPOINTS_REQUIRED');
})();
const expectedDatabaseUrl = process.env.DATABASE_URL;
if (!expectedDatabaseUrl) throw new Error('MAINTENANCE_FENCE_DATABASE_REQUIRED');
const fixed = { DATABASE_URL: expectedDatabaseUrl, STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT };

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  for (const [key, value] of Object.entries(fixed)) if (process.env[key] !== value) throw new Error('MAINTENANCE_FENCE_ENVIRONMENT_CHANGED');
  const options = net._normalizeArgs(Array.isArray(args[0]) ? args[0] : args)[0];
  if (options.path || !allowed.has(`${options.host || 'localhost'}:${Number(options.port)}`)) throw new Error('MAINTENANCE_FENCE_CONNECTION_DENIED');
  return connect.apply(this, args);
};
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function () { throw new Error('MAINTENANCE_FENCE_LISTEN_DENIED'); };
void listen;

// Prisma's native engine bypasses net.Socket: gate the constructor so only the verified URL can be used.
const load = Module._load;
const factories = new WeakMap();
Module._load = function (id, parent, isMain) {
  const exported = load.call(this, id, parent, isMain);
  if (/^@prisma\/client\/runtime\/(library|client)/.test(id)) {
    if (!factories.has(exported)) factories.set(exported, new Proxy(exported, {
      get(target, key) {
        if (key !== 'getPrismaClient') return Reflect.get(target, key);
        return config => {
          const Client = target.getPrismaClient(config);
          return class VerifiedPrismaClient extends Client {
            constructor(options = {}) {
              if (process.env.DATABASE_URL !== expectedDatabaseUrl || options.adapter || options.accelerateUrl ||
                  (options.datasourceUrl && options.datasourceUrl !== expectedDatabaseUrl) ||
                  (options.datasources && (Object.keys(options.datasources).some(k => k !== 'db') || options.datasources.db?.url !== expectedDatabaseUrl))) {
                throw new Error('MAINTENANCE_FENCE_PRISMA_DATASOURCE_DENIED');
              }
              const { datasourceUrl: ignored, ...safe } = options;
              void ignored;
              super({ ...safe, datasources: { db: { url: expectedDatabaseUrl } } });
            }
          };
        };
      },
    }));
    return factories.get(exported);
  }
  return exported;
};
