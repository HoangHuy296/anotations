// G1: disposable operations only. Production has no allow flag or execution path.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, dirname, relative, matchesGlob } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
export const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
export const sha = value => createHash('sha256').update(value).digest('hex');
export const read = path => JSON.parse(readFileSync(path, 'utf8'));
export const must = (value, code) => { if (!value) throw Error(code); };
export const registry = `/tmp/annotation-platform-db-safety-${process.getuid()}`;
export const applicationSystem = '7662655305624969250';
export const cleanEnv = () => Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
export function filesHash(paths) {
  return Object.fromEntries(paths.sort().map(p => [p, sha(readFileSync(p))]));
}
export function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(join(dir,d.name)) : [join(dir,d.name)]);
}
export function migrationFiles(path) {
  return readdirSync(path, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(path,d.name,'migration.sql')).sort();
}
export function protectedSources() {
  return [...walk(join(root,'scripts/db-safety')).filter(p => /\.(mjs|cjs|json|ts)$/.test(p)), ...['web','worker','realtime'].flatMap(a => walk(join(root,'apps',a,'tests')).filter(p => /\.[cm]?[jt]sx?$/.test(p))), ...['apps/web/package.json','apps/worker/package.json','apps/realtime/package.json','package.json','prisma.config.ts','prisma/seed.ts','prisma/review.seed.ts'].map(p=>join(root,p))];
}
function privateFile(path) {
  must(!statSync(path).isDirectory() && (statSync(path).mode & 0o077) === 0 && statSync(path).uid === process.getuid(), 'PRIVATE_FILE_REQUIRED');
}
export async function configTarget(configFile) {
  const config = realpathSync(configFile); privateFile(config);
  // The effective config, not the caller's shell value, decides the target.
  delete process.env.DATABASE_URL;
  const { loadConfigFromFile } = createRequire(require.resolve('prisma/config'))('@prisma/config');
  const loaded = await loadConfigFromFile({configFile:config,configRoot:root});
  must(!loaded.error && loaded.config?.datasource?.url,'CONFIG_RESOLUTION_FAILED');
  const c=loaded.config; const url=new URL(c.datasource.url);
  must(url.protocol==='postgresql:' && url.hostname==='127.0.0.1' && /^554[67][0-9]$/.test(url.port) && url.pathname==='/fieldframe' && !url.search && !url.hash && url.username==='postgres' && !!url.password,'DISPOSABLE_TARGET_REQUIRED');
  must(!c.datasource.shadowDatabaseUrl,'SHADOW_DATABASE_FORBIDDEN');
  const schema=realpathSync(c.schema), migrations=realpathSync(c.migrations.path);
  must(schema===join(dirname(config),'schema.prisma') && migrations===join(dirname(config),'migrations'),'STAGED_PATH_MISMATCH');
  // Shadow/direct datasource options must not provide a second connection target.
  const text=readFileSync(schema,'utf8');
  must(!/\b(?:directUrl|shadowDatabaseUrl)\s*=/.test(text) && /url\s*=\s*env\("DATABASE_URL"\)/.test(text),'SCHEMA_DATASOURCE_UNREVIEWED');
  return {config,schema,migrations,url};
}
export function containerIdentity(pin,role) {
  must(pin && /^phase029-g1-[a-z0-9-]+$/.test(pin.name) && /^[a-f0-9]{64}$/.test(pin.id),'DISPOSABLE_CONTAINER_REQUIRED');
  const c=JSON.parse(execFileSync('docker',['inspect',pin.name],{encoding:'utf8',stdio:['ignore','pipe','pipe']}))[0];
  must(c.Id===pin.id && c.State.Running && c.Config.Labels?.['annotation.safety']==='g1-disposable' && c.Config.Labels?.['annotation.role']===role,'CONTAINER_IDENTITY_MISMATCH');
  const binds=c.NetworkSettings.Ports[pin.internalPort+'/tcp'];
  must(binds?.length===1 && binds[0].HostIp==='127.0.0.1' && binds[0].HostPort===String(pin.port),'CONTAINER_BINDING_MISMATCH');
  must(/^554[67][0-9]$/.test(String(pin.port)),'DISPOSABLE_PORT_REQUIRED');
  return c;
}
export function controlIdentity(pin) {
  containerIdentity(pin,'postgres');
  const output=execFileSync('docker',['exec',pin.name,'sh','-c','LC_ALL=C pg_controldata "$PGDATA"'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const id=output.match(/^Database system identifier:\s+(\d+)/m)?.[1];
  must(id && id!==applicationSystem && id===pin.systemIdentifier,'SYSTEM_IDENTITY_MISMATCH');
}
export function probe(target,pin) {
  controlIdentity(pin); must(target.url.port===String(pin.port),'URL_CONTAINER_MISMATCH');
  // No writes; this proof runs before Prisma or any test module is started.
  const query=`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT json_build_object('systemIdentifier',system_identifier::text,'database',current_database()) FROM pg_control_system();
SELECT to_regclass('public._prisma_migrations') IS NOT NULL;
ROLLBACK;`;
  const env={...cleanEnv(),PGHOST:'127.0.0.1',PGPORT:target.url.port,PGDATABASE:'fieldframe',PGUSER:'postgres',PGPASSWORD:decodeURIComponent(target.url.password),PGAPPNAME:'g1-safety-readonly',PGOPTIONS:'-c default_transaction_read_only=on -c statement_timeout=10000',PGCONNECT_TIMEOUT:'5'};
  const p=spawnSync('psql',['-X','-qAt','-v','ON_ERROR_STOP=1'],{input:query,encoding:'utf8',env});
  must(p.status===0,'READONLY_PROBE_FAILED');const lines=p.stdout.trim().split('\n'), identity=JSON.parse(lines[0]);
  must(identity.systemIdentifier===pin.systemIdentifier && identity.database==='fieldframe','TCP_IDENTITY_MISMATCH');
  const dump=spawnSync('pg_dump',['--schema-only','--schema=public','--no-password'],{encoding:'utf8',env,maxBuffer:16*1024*1024});
  must(dump.status===0,'SCHEMA_FINGERPRINT_FAILED');
  const schemaFingerprint=sha(dump.stdout.split('\n').filter(line=>!/^\\(?:un)?restrict /.test(line)).join('\n'));
  if(lines[1]!=='t')return {history:[],schemaFingerprint};
  const h=spawnSync('psql',['-X','-qAt','-v','ON_ERROR_STOP=1','-c',`SELECT coalesce(json_agg(json_build_object('name',migration_name,'checksum',checksum,'finished',finished_at IS NOT NULL,'rolledBack',rolled_back_at IS NOT NULL,'record',md5(to_jsonb(m)::text)) ORDER BY migration_name,id),'[]'::json) FROM public._prisma_migrations m`],{encoding:'utf8',env});
  must(h.status===0,'HISTORY_READ_FAILED');return {history:JSON.parse(h.stdout.trim()),schemaFingerprint};
}
export function providerEnvironment(path,pins) {
  if(!path){must(!pins?.length,'UNBOUND_PROVIDER_PINS');return {};}
  privateFile(path);const env=read(path);
  const allowed=new Set(['MINIO_ENDPOINT','MINIO_ACCESS_KEY','MINIO_SECRET_KEY','MINIO_BUCKET','MINIO_PUBLIC_ENDPOINT','MINIO_CORS_ALLOWED_ORIGIN','REDIS_HOST','REDIS_PORT','REDIS_PASSWORD','REDIS_DB','BULLMQ_PREFIX','REALTIME_TICKET_SECRET','SOURCE_CONNECTION_ENCRYPTION_KEY']);
  must(Object.entries(env).every(([k,v])=>allowed.has(k)&&typeof v==='string'),'UNAPPROVED_TEST_ENVIRONMENT');
  must(pins?.length===2,'ISOLATED_PROVIDERS_REQUIRED');
  for(const pin of pins)containerIdentity(pin,pin.role);
  const redis=pins.find(p=>p.role==='redis'),minio=pins.find(p=>p.role==='minio');
  must(redis && minio && env.REDIS_HOST==='127.0.0.1' && env.REDIS_PORT===String(redis.port) && env.MINIO_ENDPOINT===`http://127.0.0.1:${minio.port}` && (!env.MINIO_PUBLIC_ENDPOINT||env.MINIO_PUBLIC_ENDPOINT===env.MINIO_ENDPOINT),'PROVIDER_TARGET_MISMATCH');
  must(/^g1-[a-z0-9-]+$/.test(env.MINIO_BUCKET||'') && /^g1-[a-z0-9-]+$/.test(env.BULLMQ_PREFIX||'') && env.REDIS_DB==='0' && env.REDIS_PASSWORD && env.MINIO_ACCESS_KEY && env.MINIO_SECRET_KEY,'PROVIDER_NAMESPACE_REQUIRED');
  return env;
}
export function approve(receipt,path) {
  mkdirSync(registry,{recursive:true,mode:0o700});
  must((statSync(registry).mode & 0o077)===0 && statSync(registry).uid===process.getuid(),'PRIVATE_REGISTRY_REQUIRED');
  const bytes=JSON.stringify(receipt,null,2)+'\n';writeFileSync(path,bytes,{mode:0o400,flag:'wx'});
  writeFileSync(join(registry,receipt.id+'.json'),JSON.stringify({receiptPath:realpathSync(path),sha256:sha(bytes)}),{mode:0o400,flag:'wx'});
}
export async function verify(path,operation) {
  must(path,'RECEIPT_REQUIRED');privateFile(path);
  const r=read(path);must(/^[a-f0-9-]{36}$/.test(r.id),'INVALID_RECEIPT');
  const registration=read(join(registry,r.id+'.json'));
  must(registration.receiptPath===realpathSync(path) && registration.sha256===sha(readFileSync(path)),'RECEIPT_NOT_APPROVED');
  const now=Date.now(),issued=Date.parse(r.issuedAt),expiry=Date.parse(r.expiresAt);
  must(issued<=now && now<expiry && expiry-issued<=1800000,'STALE_RECEIPT');
  must(r.operation===operation && ['deploy','test','seed'].includes(operation),'OPERATION_NOT_APPROVED');
  const hashes={...r.files,...r.sources};
  for(const [p,h] of Object.entries(hashes))must(sha(readFileSync(p))===h,'APPROVED_FILE_CHANGED');
  const target=await configTarget(r.config);
  must(target.schema===r.schema && target.migrations===r.migrations,'EFFECTIVE_PATH_MISMATCH');
  must(JSON.stringify(migrationFiles(target.migrations))===JSON.stringify(r.migrationFiles),'MIGRATION_SET_CHANGED');
  must(JSON.stringify(protectedSources().sort())===JSON.stringify(Object.keys(r.sources).sort()),'ENTRY_POINT_SET_CHANGED');
  must(r.files[join(target.migrations,'migration_lock.toml')], 'MIGRATION_LOCK_NOT_PINNED');
  const env=providerEnvironment(r.providerFile,r.providers);
  const {history,schemaFingerprint}=probe(target,r.postgres);
  must(JSON.stringify(history)===JSON.stringify(r.history),'STALE_HISTORY');
  must(schemaFingerprint===r.schemaFingerprint,'STALE_DATABASE_SCHEMA');
  must(history.every(h=>h.finished&&!h.rolledBack),'INCOMPLETE_MIGRATION_HISTORY');
  const migrations=new Map(r.migrationFiles.map(p=>[p.split('/').at(-2),sha(readFileSync(p))]));
  must(history.every(h=>migrations.get(h.name)===h.checksum),'HISTORY_CHECKSUM_MISMATCH');
  if(operation!=='deploy')must(history.length===migrations.size,'PENDING_MIGRATIONS_FOR_TEST');
  return {r,target,env};
}
export const newId = () => randomUUID();
export function redact(text) { return String(text??'').replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi,'[REDACTED_DATABASE_URL]'); }
export function safeFailure(error) { return /^[A-Z][A-Z0-9_]+$/.test(error?.message||'')?error.message:'SAFETY_CONFIGURATION_OR_IO_FAILURE'; }

export function assertEntryScope(spec,entry,args=[]) {
  const local=relative(resolve(root,spec.cwd),resolve(entry));
  must(spec.args.some(arg=>!arg.startsWith('-') && /\.(?:[cm]?[jt]sx?)$/.test(arg) && matchesGlob(local,arg)),'ENTRY_COMMAND_SCOPE_MISMATCH');
  // Vitest is a CLI entry, so its selected test files/flags must also match.
  if(local===spec.args[0])must(JSON.stringify(args)===JSON.stringify(spec.args.slice(1)),'ENTRY_ARGUMENT_SCOPE_MISMATCH');
}
