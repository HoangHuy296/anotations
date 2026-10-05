// Recovery rehearsal only. No default target and no application-database override.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const prismaRequire = createRequire(require.resolve('prisma/config'));
const { loadConfigFromFile } = prismaRequire('@prisma/config');
const [configFile, command = 'deploy'] = process.argv.slice(2);
if (!configFile || !['deploy', 'status', 'probe'].includes(command)) throw Error('Explicit config/command required');
const loaded = await loadConfigFromFile({ configFile: resolve(configFile), configRoot: process.cwd() });
if (loaded.error || !loaded.config?.datasource?.url) throw Error('CONFIG_RESOLUTION_FAILED');
const c = loaded.config;
const u = new URL(c.datasource.url);
console.log('EFFECTIVE_PRISMA_TARGET', JSON.stringify({host:u.hostname,port:u.port || '5432',database:u.pathname.slice(1),config:loaded.resolvedPath}));
// Positive instance allowlist excludes application host/port and all aliases.
if (u.protocol !== 'postgresql:' || u.hostname !== '127.0.0.1' || u.port !== '55450' || u.pathname !== '/fieldframe' || u.search || u.username !== 'postgres' || u.password) throw Error('APPLICATION_OR_UNAPPROVED_TARGET_ABORT');
const container='phase029-recovery-rehearsal-v2';
const inspect=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0];
const binding=inspect.NetworkSettings.Ports['5432/tcp'];
if (inspect.Config.Labels?.['phase029.disposable'] !== 'recovery-v2' || binding?.length !== 1 || binding[0].HostIp !== '127.0.0.1' || binding[0].HostPort !== '55450') throw Error('UNVERIFIED_CONTAINER_BINDING');
const identity=execFileSync('docker',['exec',container,'psql','-U','postgres','-d','fieldframe','-Atc',"SELECT system_identifier FROM pg_control_system()"],{encoding:'utf8'}).trim();
if (!process.env.RECOVERY_DISPOSABLE_SYSTEM_ID || identity !== process.env.RECOVERY_DISPOSABLE_SYSTEM_ID) throw Error('INSTANCE_ID_MISMATCH');
const tcpIdentity=execFileSync('psql',['-X','-qAt','-v','ON_ERROR_STOP=1','-c','SELECT system_identifier FROM pg_control_system()'],{encoding:'utf8',env:{...process.env,PGHOST:u.hostname,PGPORT:u.port,PGDATABASE:'fieldframe',PGUSER:'postgres',PGPASSWORD:'',PGOPTIONS:'-c default_transaction_read_only=on'}}).trim();
if(tcpIdentity!==identity) throw Error('TCP_INSTANCE_MISMATCH');
console.log('VERIFIED_DISPOSABLE_INSTANCE',JSON.stringify({containerId:inspect.Id,systemIdentifier:identity}));
if(command === 'probe') process.exit(0);
// Freeze the fully resolved config. The CLI does not reload the root dotenv config.
const dir=mkdtempSync('/tmp/phase029-frozen-');
const file=join(dir,'prisma.config.ts');
const modulePath=require.resolve('prisma/config');
writeFileSync(file,`import {defineConfig} from ${JSON.stringify(modulePath)}; export default defineConfig(${JSON.stringify({schema:c.schema,migrations:c.migrations,engine:'classic',datasource:{url:u.toString()}})});`,{mode:0o400});
console.log('FROZEN_CONFIG_SHA256',createHash('sha256').update(readFileSync(file)).digest('hex'));
try {
 const result=spawnSync(process.execPath,[join(dirname(require.resolve('prisma/config')),'build/index.js'),'migrate',command,'--config',file],{stdio:'inherit',env:{...process.env,DATABASE_URL:u.toString()}});
 process.exitCode=result.status ?? 1;
} finally {rmSync(dir,{recursive:true,force:true});}
