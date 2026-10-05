// READ-ONLY catalog investigation. Does not create functions or execute recovery.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url),root=resolve(import.meta.dirname,'../..');process.chdir(root);
const out=join(root,'specs/029-modality-specific-datasets/verification/manifest-investigation');mkdirSync(out,{recursive:true});
const frozen=readFileSync('specs/proposals/phase029-modality/recovery.review.sql','utf8');
const hash=createHash('sha256').update(frozen).digest('hex');
if(hash!=='b5be6dcf4cec4b87b4e6b150bdd41f71794dbdcbb57a44d3d606e9abc8cb73ac')throw Error('FROZEN_SQL_CHANGED');
const {loadConfigFromFile}=createRequire(require.resolve('prisma/config'))('@prisma/config');
const loaded=await loadConfigFromFile({configFile:resolve('prisma.config.ts'),configRoot:root});
if(loaded.error)throw Error('CONFIG_FAILED');const url=new URL(loaded.config.datasource.url);
if(url.hostname!=='127.0.0.1'||url.port!=='5433'||url.pathname!=='/fieldframe'||[...url.searchParams.keys()].some(k=>k!=='schema')||(url.searchParams.get('schema')||'public')!=='public')throw Error('UNREVIEWED_TARGET');
console.log('EFFECTIVE_PRISMA_TARGET',JSON.stringify({host:url.hostname,port:url.port,database:url.pathname.slice(1)}));
const original=frozen.split('LANGUAGE sql AS $manifest$\n')[1].split('\nSELECT coalesce(jsonb_agg')[0].replaceAll('expected_after','false');
// Proposal is exercised only as catalog SELECTs, never as CREATE FUNCTION or DDL.
let proposed=original;
const changes=[
 ["SELECT 'relation' AS kind, c.relname AS name,","SELECT 'relation'::text AS kind, jsonb_build_array(n.nspname::text,c.relname::text)::text AS name,"],
 ["SELECT 'column',c.relname||'.'||a.attname,","SELECT 'column',jsonb_build_array(n.nspname::text,c.relname::text,a.attname::text)::text,"],
 ["SELECT 'constraint',coalesce(c.conrelid::regclass::text,c.contypid::regtype::text)||'.'||c.conname,","SELECT 'constraint',jsonb_build_array(n.nspname::text,CASE WHEN c.conrelid<>0 THEN 'relation' ELSE 'domain' END,CASE WHEN c.conrelid<>0 THEN c.conrelid::regclass::text ELSE c.contypid::regtype::text END,c.conname::text)::text,"],
 ["SELECT 'index',c.relname,","SELECT 'index',jsonb_build_array(n.nspname::text,c.relname::text)::text,"],
 ["SELECT 'trigger',c.relname||'.'||t.tgname,","SELECT 'trigger',jsonb_build_array(n.nspname::text,c.relname::text,t.tgname::text)::text,"],
 ["SELECT 'routine',p.oid::regprocedure::text,","SELECT 'routine',jsonb_build_array(n.nspname::text,p.oid::regprocedure::text)::text,"],
 ["SELECT 'type',t.typname,","SELECT 'type',jsonb_build_array(n.nspname::text,t.typname::text)::text,"],
 ["SELECT 'enum',t.typname||'.'||e.enumlabel,","SELECT 'enum',jsonb_build_array(n.nspname::text,t.typname::text,e.enumlabel)::text,"],
 ["SELECT 'policy',c.relname||'.'||p.polname,","SELECT 'policy',jsonb_build_array(n.nspname::text,c.relname::text,p.polname::text)::text,"],
 ["SELECT 'sequence',c.relname,","SELECT 'sequence',jsonb_build_array(n.nspname::text,c.relname::text)::text,"],
 ["SELECT 'rule',c.relname||'.'||r.rulename,","SELECT 'rule',jsonb_build_array(n.nspname::text,c.relname::text,r.rulename::text)::text,"],
];
for(const [from,to] of changes){if(!proposed.includes(from))throw Error('MANIFEST_SOURCE_DRIFT');proposed=proposed.replace(from,to);}
const sql=`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path=pg_catalog,public;
DO $identity$ BEGIN IF current_database()<>'fieldframe' OR (SELECT system_identifier::text FROM pg_control_system())<>'7662655305624969250' THEN RAISE EXCEPTION 'INSTANCE_MISMATCH'; END IF; END $identity$;
SELECT jsonb_build_object('kind','identity','value',jsonb_build_object('systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),'database',current_database(),'maxIdentifierLength',current_setting('max_identifier_length'),'readOnly',current_setting('transaction_read_only'),'isolation',current_setting('transaction_isolation'),'snapshot',pg_current_snapshot()::text,'capturedAt',transaction_timestamp()));
${original}
SELECT jsonb_build_object('kind','original','value',jsonb_build_object('nameType',(SELECT pg_typeof(name)::text FROM objects LIMIT 1),'objectCount',(SELECT count(*) FROM objects),'duplicates',(SELECT jsonb_agg(to_jsonb(d)) FROM (SELECT kind,name,count(*),jsonb_agg(shape ORDER BY shape::text) shapes FROM objects GROUP BY kind,name HAVING count(*)>1) d)));
SELECT jsonb_build_object('kind','distinctCatalogObjects','value',jsonb_agg(jsonb_build_object('catalog','pg_class','relationOid',c.oid,'attnum',a.attnum,'schema',n.nspname,'relation',c.relname,'column',a.attname,'fullKey',c.relname::text||'.'||a.attname::text,'fullBytes',octet_length(c.relname::text||'.'||a.attname::text),'legacyKey',(c.relname::text||'.'||a.attname::text)::name::text,'type',format_type(a.atttypid,a.atttypmod)) ORDER BY c.relname,a.attnum)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND c.relname IN ('CollaborationOutboxEvent_datasetId_dispatchedAt_createdAt_idx','AssetVersion_storageProvider_storageBucket_storageKey_key','VisualizationArtifact_datasetId_snapshotId_kind_algorithm_s_key') AND a.attnum>0 AND NOT a.attisdropped;
${proposed}
SELECT jsonb_build_object('kind','proposed','value',jsonb_build_object('nameType',(SELECT pg_typeof(name)::text FROM objects LIMIT 1),'objectCount',count(*),'distinctIdentities',count(DISTINCT (kind,name)),'manifestMd5',md5(jsonb_agg(jsonb_build_array(kind,name,shape) ORDER BY kind COLLATE "C",name COLLATE "C")::text))) FROM objects;
${proposed},
ordering AS (SELECT jsonb_agg(jsonb_build_array(kind,name,shape) ORDER BY kind COLLATE "C",name COLLATE "C") canonical FROM objects),
reverse_input AS (SELECT * FROM objects ORDER BY name COLLATE "C" DESC,kind COLLATE "C" DESC),
reordered AS (SELECT jsonb_agg(jsonb_build_array(kind,name,shape) ORDER BY kind COLLATE "C",name COLLATE "C") canonical FROM reverse_input)
SELECT jsonb_build_object('kind','orderTest','value',jsonb_build_object('canonicalEqual',(SELECT canonical FROM ordering)=(SELECT canonical FROM reordered)));
SELECT jsonb_build_object('kind','separatorTest','value',jsonb_build_object('legacyCollision',('a.b'||'.'||'c')=('a'||'.'||'b.c'),'structuredIdentitiesDistinct',jsonb_build_array('public','a.b','c')<>jsonb_build_array('public','a','b.c')));
ROLLBACK;`;
writeFileSync(join(out,'investigation.readonly.sql'),sql);
const p=spawnSync('psql',['-X','-qAt','-v','ON_ERROR_STOP=1'],{input:sql,encoding:'utf8',maxBuffer:4*1024*1024,env:{...process.env,PGHOST:url.hostname,PGPORT:url.port,PGDATABASE:url.pathname.slice(1),PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGOPTIONS:'-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=10000',PGAPPNAME:'phase029-manifest-investigation'}});
if(p.status!==0){writeFileSync(join(out,'error.log'),p.stderr);throw Error('READONLY_INVESTIGATION_FAILED');}
const evidence={sqlSha256:hash};for(const line of p.stdout.trim().split('\n')){const x=JSON.parse(line);evidence[x.kind]=x.value;}
if(evidence.original.nameType!=='name'||evidence.proposed.nameType!=='text'||evidence.proposed.objectCount!==evidence.proposed.distinctIdentities||evidence.proposed.objectCount!==evidence.original.objectCount||!evidence.orderTest.canonicalEqual||!evidence.separatorTest.structuredIdentitiesDistinct)throw Error('INVESTIGATION_ASSERTION_FAILED');
writeFileSync(join(out,'results.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
