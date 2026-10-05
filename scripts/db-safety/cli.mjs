import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,cpSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {verify,must,read,root,cleanEnv,redact,safeFailure,sha} from './guard.mjs';
const require=createRequire(import.meta.url);
try {
 const [operation,command,...extra]=process.argv.slice(2);
 must(['deploy','test','seed'].includes(operation)&&!extra.length,'OPERATION_NOT_APPROVED');
 const receipt=process.env.DB_SAFETY_RECEIPT;
 const {r,target,env}=await verify(receipt,operation);
 must((r.command??undefined)===command,'COMMAND_SCOPE_MISMATCH');
 console.log('VERIFIED_DISPOSABLE_TARGET',JSON.stringify({host:target.url.hostname,port:target.url.port,database:'fieldframe',systemIdentifier:r.postgres.systemIdentifier,containerId:r.postgres.id,operation}));
 const temp=mkdtempSync('/tmp/phase029-g1-frozen-');
 try {
  const config=join(temp,'prisma.config.ts');
  const frozenSchema=join(temp,'schema.prisma'), frozenMigrations=join(temp,'migrations');
  cpSync(target.schema,frozenSchema);cpSync(target.migrations,frozenMigrations,{recursive:true});
  for(const path of [target.schema,join(target.migrations,'migration_lock.toml'),...r.migrationFiles]) {
    const frozen=path===target.schema?frozenSchema:join(frozenMigrations,path.slice(target.migrations.length+1));
    must(sha(readFileSync(frozen))===r.files[path],'FROZEN_ARTIFACT_MISMATCH');
  }
  writeFileSync(config,`import {defineConfig} from ${JSON.stringify(require.resolve('prisma/config'))}; export default defineConfig(${JSON.stringify({schema:frozenSchema,migrations:{path:frozenMigrations},engine:'classic',datasource:{url:target.url.toString()}})});`,{mode:0o400});
  const childEnv={...cleanEnv(),...env,DATABASE_URL:target.url.toString(),DB_SAFETY_RECEIPT:receipt,NODE_ENV:'test'};
  const cli=join(dirname(require.resolve('prisma/config')),'build/index.js');
  const run=(exe,args,cwd=root)=>{
   const started=performance.now();
   const p=spawnSync(exe,args,{cwd,env:childEnv,encoding:'utf8',maxBuffer:16*1024*1024});
   let output=redact((p.stdout??'')+(p.stderr??''));
   for(const secret of [decodeURIComponent(target.url.password),...Object.entries(env).filter(([k])=>/PASSWORD|SECRET|KEY/.test(k)).map(([,v])=>v)])if(secret)output=output.split(secret).join('[REDACTED]');
   process.stdout.write(output);
   // Preserve the existing fail-closed return value while exposing only safe
   // subprocess outcome metadata; never emit arguments, configuration or env.
   if(p.status!==0)console.error('SAFETY_CHILD_FAILURE',JSON.stringify({
    status:p.status,signal:p.signal,
    spawnErrorCode:typeof p.error?.code==='string'&&/^E[A-Z0-9_]+$/.test(p.error.code)?p.error.code:null,
    durationMs:Math.round(performance.now()-started),
   }));
   return p.status??1;
  };
  must(run(process.execPath,[cli,'validate','--config',config])===0,'SCHEMA_VALIDATION_FAILED');
  // Revalidate full identity/history/files after validation, before the mutating child.
  await verify(receipt,operation);
  if(operation==='deploy') process.exitCode=run(process.execPath,[cli,'migrate','deploy','--config',config]);
  else {
   const spec=read(new URL('./commands.json',import.meta.url))[command];
   must(spec?.kind===operation,'COMMAND_NOT_ALLOWLISTED');
   childEnv.NODE_OPTIONS=`--require=${join(root,'scripts/db-safety/network-fence.cjs')}`;
   process.exitCode=run(process.execPath,spec.args,join(root,spec.cwd));
  }
 }finally{rmSync(temp,{recursive:true,force:true});}
}catch(error){console.error('SAFETY_ABORT',safeFailure(error));process.exitCode=1;}
