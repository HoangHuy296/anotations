// Invoked synchronously by the first import/preload before fixture modules run.
import {verify,read,must,safeFailure,assertEntryScope} from './guard.mjs';
if (process.env.G1_RUNTIME_ROLE) {
 await import('./runtime-check.mjs');
} else {
try {
 const path=process.env.DB_SAFETY_RECEIPT;must(path,'RECEIPT_REQUIRED');
 const entry=process.argv[2];must(entry,'EXECUTION_ENTRY_REQUIRED');
 const incoming=process.env.DATABASE_URL, r=read(path);
 must(['test','seed'].includes(r.operation),'TEST_OR_SEED_SCOPE_REQUIRED');
 const spec=read(new URL('./commands.json',import.meta.url))[r.command];
 must(spec?.kind===r.operation,'COMMAND_NOT_ALLOWLISTED');
 if(entry!=='--loader-thread')assertEntryScope(spec,entry,JSON.parse(process.argv[3]||'[]'));
 const result=await verify(path,r.operation);
 must(incoming===result.target.url.toString(),'TEST_DATASOURCE_OVERRIDE');
 for(const [k,v] of Object.entries(result.env))must(process.env[k]===v,'TEST_PROVIDER_OVERRIDE');
 for(const key of ['DATABASE_URL_DOCKER','DIRECT_URL','SHADOW_DATABASE_URL','REDIS_URL','MINIO_ROOT_PASSWORD','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD'])must(!process.env[key],'UNVERIFIED_CONNECTION_ENVIRONMENT');
 console.log('ENTRY_TARGET_VERIFIED');
}catch(error){console.error('SAFETY_ABORT',safeFailure(error));process.exitCode=1;}
}
