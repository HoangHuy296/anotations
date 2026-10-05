// READ ONLY. Intentionally has no migration-execution mode.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
const require=createRequire(import.meta.url);
const root=resolve(import.meta.dirname,'../..');
process.chdir(root);
const out=resolve(process.argv[2] || 'specs/029-modality-specific-datasets/verification/application-preflight-v2');
if(existsSync(out)&&readdirSync(out).length) throw Error('EVIDENCE_DIRECTORY_NOT_EMPTY_USE_FRESH_PATH');
mkdirSync(out,{recursive:true});
const save=(name,data)=>writeFileSync(join(out,name),typeof data==='string'?data:JSON.stringify(data,null,2)+'\n');
const sha=(x)=>createHash('sha256').update(x).digest('hex');
const sql=readFileSync('specs/proposals/phase029-modality/recovery.v2.review.sql','utf8');
const expected='3bb6389f380ffaa5c3be88d26d56782065a00b3844f0326ccba1c05ee4b5a1db';
if(sha(sql)!==expected) throw Error('FROZEN_RECOVERY_SQL_CHANGED');
const {loadConfigFromFile}=createRequire(require.resolve('prisma/config'))('@prisma/config');
const loaded=await loadConfigFromFile({configFile:resolve(process.argv[3] || 'prisma.config.ts'),configRoot:root});
if(loaded.error || !loaded.config?.datasource?.url) throw Error('CONFIG_RESOLUTION_FAILED');
const c=loaded.config, url=new URL(c.datasource.url);
const target={host:url.hostname,port:url.port||'5432',database:decodeURIComponent(url.pathname.slice(1)),schema:url.searchParams.get('schema')||'public'};
console.log('EFFECTIVE_PRISMA_TARGET',JSON.stringify(target));
if(target.host!=='127.0.0.1'||target.port!=='5433'||target.database!=='fieldframe'||target.schema!=='public') throw Error('UNREVIEWED_TARGET');
if([...url.searchParams.keys()].some(k=>k!=='schema')) throw Error('UNREVIEWED_CONNECTION_OPTIONS');
const container='annotationplatformdev-postgres-1';
const inspection=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0];
if(!inspection.NetworkSettings.Ports['5432/tcp']?.some(b=>b.HostIp==='127.0.0.1'&&b.HostPort==='5433')) throw Error('BINDING_MISMATCH');
if(inspection.Id!=='0a4ca1285c5ae8ccd7f1770340c4d9c31546d63113d9701d19ce89f2756ed7d9') throw Error('CONTAINER_ID_CHANGED');
// Read PostgreSQL's control file before opening any database connection.
const control=execFileSync('docker',['exec',container,'sh','-c','LC_ALL=C pg_controldata "$PGDATA"'],{encoding:'utf8'});
const controlId=control.match(/^Database system identifier:\s+(\d+)/m)?.[1];
if(controlId!=='7662655305624969250') throw Error('PRECONNECT_SYSTEM_IDENTIFIER_MISMATCH');
save('preconnect-identity.json',{effectiveTarget:target,containerId:inspection.Id,systemIdentifier:controlId,source:'read-only pg_controldata; no SQL connection',recoverySha256:expected});
console.log('PRECONNECT_INSTANCE_VERIFIED',controlId);
const pgEnv={...process.env,PGHOST:target.host,PGPORT:target.port,PGDATABASE:target.database,
 PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),
 PGOPTIONS:'-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=10000',
 PGAPPNAME:'phase029-readonly-preflight',PGCONNECT_TIMEOUT:'10'};
const session=[];
const helper=sql.split('LANGUAGE plpgsql AS $manifest$\n')[1].split('\n$manifest$;')[0];
const manifest=helper.slice(helper.indexOf('WITH objects AS ('),helper.indexOf(';\nIF EXISTS (')).replace(' INTO manifest FROM objects',' FROM objects');
const rows=sql.split('AS $rows$\n')[1].split('\n$rows$;')[0].replace('RETURN result;',"RAISE NOTICE 'PREFLIGHT_ROWS %',result;");
session.push(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path=pg_catalog,public;
SET LOCAL row_security=off;
DO $identity$ BEGIN
 IF current_database()<>'fieldframe' OR (SELECT system_identifier::text FROM pg_control_system())<>'7662655305624969250' THEN
 RAISE EXCEPTION 'READONLY_CONNECTION_IDENTITY_MISMATCH'; END IF;
END $identity$;
DO $visibility$ DECLARE r record; BEGIN
 FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname LOOP
 EXECUTE format('LOCK TABLE public.%I IN ACCESS SHARE MODE',r.relname); END LOOP;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'_prisma_migrations'
 AND (c.relrowsecurity OR c.relforcerowsecurity OR NOT has_table_privilege(current_user,c.oid,'SELECT')))
 THEN RAISE EXCEPTION 'PREFLIGHT_FULL_VISIBILITY_UNPROVEN'; END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('p','f')) THEN RAISE EXCEPTION 'UNSUPPORTED_TABLE_KIND'; END IF;
END $visibility$;
SELECT jsonb_build_object('kind','identity','value',jsonb_build_object(
 'database',current_database(),'user',current_user,'serverAddress',inet_server_addr(),'serverPort',inet_server_port(),
 'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),'serverVersion',version(),
 'readOnly',current_setting('transaction_read_only'),'isolation',current_setting('transaction_isolation'),
 'snapshot',pg_current_snapshot()::text,'capturedAt',transaction_timestamp(),
 'rowSecurity',current_setting('row_security'),'superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),
 'bypassRls',(SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user)));
SELECT jsonb_build_object('kind','visibility','value',jsonb_agg(jsonb_build_object('table',c.relname,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'select',has_table_privilege(current_user,c.oid,'SELECT')) ORDER BY c.relname))
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'_prisma_migrations';`);
for(const [kind,value] of [['schema',false],['expectedSchema',true]]) session.push(`SELECT jsonb_build_object('kind','${kind}','value',manifest,'md5',md5(manifest::text)) FROM (${manifest.replaceAll('expected_after',String(value))}) e(manifest);`);
// Reuse accepted v2 regressions as pure SELECTs; do not create temp DB helpers.
let manifestChecks=readFileSync(join(root,'scripts/phase029-recovery/manifest-regressions.sql'),'utf8').trim().replace(/;$/,'');
for(const value of [false,true]) manifestChecks=manifestChecks.replaceAll(`pg_temp.phase029_schema_manifest(${value})`,`(SELECT m FROM (${manifest.replaceAll('expected_after',String(value))}) evaluated(m))`);
session.push(`SELECT jsonb_build_object('kind','manifestChecks','value',checks) FROM (${manifestChecks}) evaluated(checks);`);
session.push(`DO $rowaudit$\n${rows}\n$rowaudit$;`);
session.push(`DO $receipt$ DECLARE state jsonb; BEGIN
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public."Dataset"'::regclass AND attname='modality' AND NOT attisdropped) THEN
  SELECT jsonb_build_object('datasets',count(*),'modalityNonNull',count("modality"),'timeNonNull',count("modalityResolvedAt"),'subjectNonNull',count("modalityResolverSubject"),'nonzeroFences',count(*) FILTER(WHERE "modalityContentRevision"<>0),'fenceMin',min("modalityContentRevision"),'fenceMax',max("modalityContentRevision"),'fenceSum',sum("modalityContentRevision")) INTO state FROM public."Dataset";
 ELSE state:=jsonb_build_object('phase029ColumnsAbsent',true); END IF;
 RAISE NOTICE 'PREFLIGHT_RECEIPTS %',state;
END $receipt$;
SELECT jsonb_build_object('kind','history','value',jsonb_agg(jsonb_build_object('id',id,'name',migration_name,'checksum',checksum,'startedAt',started_at,'finishedAt',finished_at,'rolledBackAt',rolled_back_at,'appliedSteps',applied_steps_count,'recordMd5',md5(to_jsonb(m)::text)) ORDER BY migration_name,id)) FROM public._prisma_migrations m;
SELECT jsonb_build_object('kind','eventTriggers','value',coalesce(jsonb_agg(jsonb_build_object('name',evtname,'enabled',evtenabled)),'[]'::jsonb)) FROM pg_event_trigger;
SELECT jsonb_build_object('kind','functions','value',jsonb_agg(jsonb_build_object('name',p.proname,'bodyMd5',md5(p.prosrc),'argCount',p.pronargs,'result',p.prorettype::regtype::text,'language',l.lanname,'securityDefiner',p.prosecdef,'strict',p.proisstrict,'volatility',p.provolatile,'parallel',p.proparallel,'config',p.proconfig) ORDER BY p.proname)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND p.proname IN ('phase029_guard_dataset_insert','phase029_guard_dataset_assignment','phase029_guard_asset_write');
WITH targets AS (
 SELECT 'pg_class'::regclass::oid classid,a.attrelid objid,a.attnum::int objsubid FROM pg_attribute a WHERE a.attrelid='public."Dataset"'::regclass AND a.attname IN ('modality','modalityContentRevision','modalityResolvedAt','modalityResolverSubject') AND NOT a.attisdropped
 UNION ALL SELECT 'pg_constraint'::regclass,oid,0 FROM pg_constraint WHERE conrelid='public."Dataset"'::regclass AND conname IN ('dataset_modality_resolution_shape','dataset_modality_revision_nonnegative')
 UNION ALL SELECT 'pg_proc'::regclass,p.oid,0 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND proname IN ('phase029_guard_dataset_insert','phase029_guard_dataset_assignment','phase029_guard_asset_write') AND pronargs=0
 UNION ALL SELECT 'pg_trigger'::regclass,oid,0 FROM pg_trigger WHERE (tgrelid='public."Dataset"'::regclass AND tgname IN ('dataset_modality_insert_guard','dataset_modality_assignment_guard')) OR (tgrelid='public."Asset"'::regclass AND tgname='asset_modality_write_guard')
), edges AS (
 SELECT DISTINCT pg_describe_object(d.classid,d.objid,d.objsubid) dependent,pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid) referenced,d.deptype,
 EXISTS(SELECT 1 FROM targets t WHERE (t.classid,t.objid,t.objsubid)=(d.classid,d.objid,d.objsubid)) dependent_is_target,
 EXISTS(SELECT 1 FROM targets t WHERE (t.classid,t.objid,t.objsubid)=(d.refclassid,d.refobjid,d.refobjsubid)) referenced_is_target
 FROM pg_depend d WHERE EXISTS(SELECT 1 FROM targets t WHERE (t.classid,t.objid,t.objsubid)=(d.classid,d.objid,d.objsubid) OR (t.classid,t.objid,t.objsubid)=(d.refclassid,d.refobjid,d.refobjsubid))
) SELECT jsonb_build_object('kind','dependencies','value',coalesce(jsonb_agg(to_jsonb(e) ORDER BY dependent,referenced),'[]'::jsonb)) FROM edges e;
SELECT jsonb_build_object('kind','sessions','value',coalesce(jsonb_agg(jsonb_build_object('user',usename,'application',application_name,'client',client_addr,'state',state,'transactionOpen',xact_start IS NOT NULL,'waitType',wait_event_type)),'[]'::jsonb)) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid();
SELECT jsonb_build_object('kind','diagnostics','value',jsonb_build_object('logDestination',current_setting('log_destination'),'loggingCollector',current_setting('logging_collector'),'logMinMessages',current_setting('log_min_messages'),'logMinErrorStatement',current_setting('log_min_error_statement'),'logLinePrefix',current_setting('log_line_prefix')));
ROLLBACK;`);
const query=session.join('\n'); save('capture.readonly.sql',query+'\n');
const read=spawnSync('psql',['-X','-qAt','-v','ON_ERROR_STOP=1'],{input:query,env:pgEnv,encoding:'utf8',maxBuffer:32*1024*1024});
if(read.status!==0){ save('capture-error.log',read.stderr); throw Error('READONLY_CAPTURE_FAILED'); }
const evidence={};
for(const line of read.stdout.trim().split('\n')){const e=JSON.parse(line); evidence[e.kind]=e;}
const rowLine=read.stderr.split('\n').find(x=>x.includes('PREFLIGHT_ROWS '));
if(!rowLine) throw Error('NO_ROW_FINGERPRINTS');
evidence.rows={kind:'rows',value:JSON.parse(rowLine.split('PREFLIGHT_ROWS ')[1])};
const receiptLine=read.stderr.split('\n').find(x=>x.includes('PREFLIGHT_RECEIPTS '));
if(!receiptLine) throw Error('NO_RECEIPT_STATE');
evidence.receipts={kind:'receipts',value:JSON.parse(receiptLine.split('PREFLIGHT_RECEIPTS ')[1])};
if(evidence.identity.value.readOnly!=='on'||evidence.identity.value.isolation!=='repeatable read') throw Error('NOT_READONLY_REPEATABLE_READ');
const tcpId=evidence.identity.value.systemIdentifier;
const socketId=execFileSync('docker',['exec','-e','PGOPTIONS=-c default_transaction_read_only=on',container,'psql','-X','-qAt','-U',decodeURIComponent(url.username),'-d',target.database,'-c','SELECT system_identifier FROM pg_control_system()'],{encoding:'utf8'}).trim();
if(tcpId!==socketId||tcpId!==controlId) throw Error('INSTANCE_IDENTITY_MISMATCH');
save('evidence.json',evidence);
const migrationHashes=Object.fromEntries(readdirSync(c.migrations.path,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>[d.name,sha(readFileSync(join(c.migrations.path,d.name,'migration.sql')))]));
save('target-and-integrity.json',{effectiveTarget:target,resolvedConfig:loaded.resolvedPath,configSha256:sha(readFileSync(loaded.resolvedPath)),recoverySha256:expected,systemIdentifier:tcpId,containerId:inspection.Id,containerImage:inspection.Image,migrationHashes,captureSqlSha256:sha(query+'\n')});
// Status only, with a frozen config and explicit server-side read-only startup option.
const temporary=mkdtempSync('/tmp/phase029-readonly-status-');
try {
 const readonlyUrl=new URL(url); readonlyUrl.searchParams.set('options','-c default_transaction_read_only=on');
 const file=join(temporary,'prisma.config.ts');
 writeFileSync(file,`import {defineConfig} from ${JSON.stringify(require.resolve('prisma/config'))}; export default defineConfig({schema:${JSON.stringify(c.schema)},migrations:${JSON.stringify(c.migrations)},engine:'classic',datasource:{url:process.env.PHASE029_READONLY_URL!}});`,{mode:0o400});
 const status=spawnSync(process.execPath,[join(dirname(require.resolve('prisma/config')),'build/index.js'),'migrate','status','--config',file],{encoding:'utf8',env:{...process.env,PHASE029_READONLY_URL:readonlyUrl.toString(),DATABASE_URL:readonlyUrl.toString()},maxBuffer:4*1024*1024});
 save('prisma-status.log',status.stdout+status.stderr); save('status-result.json',{exitCode:status.status});
 console.log('READONLY_CAPTURE_COMPLETE',JSON.stringify({systemIdentifier:tcpId,tables:Object.keys(evidence.rows.value).length,receipts:evidence.receipts.value,prismaStatusExit:status.status}));
} finally {rmSync(temporary,{recursive:true,force:true});}
