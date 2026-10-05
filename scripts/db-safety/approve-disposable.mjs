// Receipt issuance only for positively verified disposable resources. No migration.
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {configTarget,probe,providerEnvironment,filesHash,migrationFiles,protectedSources,approve,newId,read,must,safeFailure,root,sha} from './guard.mjs';
try {
  const [requestPath,receiptPath,...rest]=process.argv.slice(2);
  must(requestPath&&receiptPath&&!rest.length,'EXPLICIT_APPROVAL_REQUEST_REQUIRED');
  const request=read(resolve(requestPath));
  must(['deploy','test','seed'].includes(request.operation),'OPERATION_NOT_APPROVED');
  must(sha(readFileSync(resolve(request.config)))===request.configSha256,'UNAPPROVED_CONFIG');
  const target=await configTarget(resolve(request.config));
  const env=providerEnvironment(request.providerFile,request.providers);void env;
  if(request.operation!=='deploy')must(request.providerFile,'ISOLATED_PROVIDERS_REQUIRED');
  const files=migrationFiles(target.migrations);
  // Approval request must enumerate exact bytes, never silently approve a discovered new set.
  const actual=filesHash(files);
  must(JSON.stringify(actual)===JSON.stringify(request.migrationHashes),'UNAPPROVED_MIGRATION_SET');
  must(sha(readFileSync(target.schema))===request.schemaSha256,'UNAPPROVED_SCHEMA');
  const commands=read(new URL('./commands.json',import.meta.url));
  if(request.operation==='test')must(commands[request.command]?.kind==='test','UNAPPROVED_TEST_COMMAND');
  if(request.operation==='seed')must(commands[request.command]?.kind==='seed','UNAPPROVED_SEED_COMMAND');
  const {history,schemaFingerprint}=probe(target,request.postgres);
  must(history.every(h=>h.finished&&!h.rolledBack),'INCOMPLETE_HISTORY');
  const r={id:newId(),issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+20*60000).toISOString(),operation:request.operation,command:request.command??null,config:target.config,schema:target.schema,migrations:target.migrations,postgres:request.postgres,providers:request.providers??[],providerFile:request.providerFile??null,history,schemaFingerprint,migrationFiles:files,files:filesHash([target.config,target.schema,join(target.migrations,'migration_lock.toml'),...files,...(request.providerFile?[request.providerFile]:[])]),sources:filesHash(protectedSources())};
  approve(r,resolve(receiptPath));
  console.log(JSON.stringify({approvedDisposableReceipt:r.id,operation:r.operation,systemIdentifier:r.postgres.systemIdentifier,migrationCount:files.length,expiresAt:r.expiresAt}));
} catch(error){console.error('SAFETY_ABORT',safeFailure(error));process.exitCode=1;}
