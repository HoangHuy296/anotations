// Offline validation only. No database connections or modifications.
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'../..');
const dir=resolve(process.argv[2]||join(root,'specs/029-modality-specific-datasets/verification/application-preflight-v2'));
const read=p=>JSON.parse(p.endsWith('.gz')?gunzipSync(readFileSync(p)):readFileSync(p));
const a=read(join(dir,'evidence.json')),i=read(join(dir,'target-and-integrity.json'));
const base=join(root,'specs/029-modality-specific-datasets/verification/rehearsal-v2');
const r=read(join(base,'success-evidence.json.gz')),receipt=read(join(base,'results.json'));
const check=(condition,message)=>{if(!condition)throw Error(message);};
const sha=x=>createHash('sha256').update(x).digest('hex');
const canonical=items=>items.map(x=>JSON.stringify(x)).sort();
const eq=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
const keys=new Set(receipt.removedObjects.map(x=>JSON.stringify(x)));
const target=s=>s.filter(x=>keys.has(JSON.stringify(x.slice(0,2))));
check(i.recoverySha256===receipt.sqlSha256&&sha(readFileSync(join(root,'specs/proposals/phase029-modality/recovery.v2.review.sql')))===receipt.sqlSha256,'SQL_CHECKSUM_CHANGED');
const required=['success','receipt','trigger','function','constraint','rls','forced-rls'];
check(required.every(name=>receipt.scenarios.some(x=>x.scenario===name&&x.result==='PASS'&&x.exactCandidate&&x.executedSqlSha256===receipt.sqlSha256))&&receipt.scenarios.every(x=>x.result==='PASS'),'REHEARSAL_RECEIPT_INVALID');
check(target(a.schema.value).length===12&&eq(canonical(target(a.schema.value)),canonical(target(r.before.schema))),'TARGET_SHAPE_MISMATCH');
check(a.functions.value.length===3&&a.functions.value.every(f=>f.argCount===0&&f.result==='trigger'&&f.language==='plpgsql'&&!f.securityDefiner&&!f.strict&&f.volatility==='v'&&f.parallel==='u'&&f.config===null),'FUNCTION_ATTRIBUTES_CHANGED');
check(a.history.value.length===22&&a.history.value.every(h=>h.finishedAt&&!h.rolledBackAt&&h.checksum===i.migrationHashes[h.name]),'HISTORY_CHANGED');
check(Object.keys(i.migrationHashes).length===22,'PENDING_OR_UNEXPECTED_MIGRATION');
check(read(join(dir,'status-result.json')).exitCode===0,'PRISMA_STATUS_FAILED');
check(a.identity.value.readOnly==='on'&&a.identity.value.isolation==='repeatable read','UNSAFE_CAPTURE');
check(a.manifestChecks&&Object.keys(a.manifestChecks.value).length===12&&Object.values(a.manifestChecks.value).every(x=>x===true),'MANIFEST_REGRESSIONS_FAILED');
check(a.visibility.value.length===35&&a.visibility.value.every(t=>!t.rls&&!t.forceRls&&t.select)&&Object.keys(a.rows.value).length===35,'INCOMPLETE_VISIBILITY');
check(a.receipts.value.modalityNonNull===0&&a.receipts.value.timeNonNull===0&&a.receipts.value.subjectNonNull===0,'BUSINESS_RECEIPT_PRESENT');
check(a.eventTriggers.value.length===0,'EVENT_TRIGGER_REVIEW_REQUIRED');
const external=a.dependencies.value.filter(d=>d.referenced_is_target&&!d.dependent_is_target);
check(external.length===1&&external[0].dependent==='default value for column modalityContentRevision of table "Dataset"'&&external[0].deptype==='a','UNEXPECTED_INBOUND_DEPENDENCY');
check(!/\b(?:DROP|ALTER)\b[^;]*\bCASCADE\b/i.test(readFileSync(join(root,'specs/proposals/phase029-modality/recovery.v2.review.sql'),'utf8')),'CASCADE_PRESENT');
const duplicates=Object.entries(a.schema.value.reduce((m,x)=>{const k=JSON.stringify(x.slice(0,2));m[k]=(m[k]||0)+1;return m;},{})).filter(([,n])=>n>1);
const summary={result:duplicates.length?'BLOCKED_AMBIGUOUS_SQL_MANIFEST':'PASS',capturedAt:a.identity.value.capturedAt,snapshot:a.identity.value.snapshot,
 effectiveTarget:i.effectiveTarget,systemIdentifier:i.systemIdentifier,recoverySha256:i.recoverySha256,rehearsalScenarios:receipt.scenarios.length,
 migrationHistoryRows:22,localMigrationChecksumsMatch:true,targetObjects:target(a.schema.value),unexpectedInboundDependencies:[],ownColumnDefault:external[0],
 fullSchemaSameDefinitionsAsRehearsal:eq(canonical(a.schema.value),canonical(r.before.schema)),
 rawSchemaSameOrderAsRehearsal:eq(a.schema.value,r.before.schema),duplicateManifestSortKeys:duplicates,
 schemaMd5:a.schema.md5,expectedPostSchemaMd5:a.expectedSchema.md5,
 canonicalSchemaSha256:sha(JSON.stringify(canonical(a.schema.value))),
 receipts:a.receipts.value,tableFingerprints:a.rows.value,applicationSessionsAtCapture:a.sessions.value.length,
 writersDrained:false,applicationRecoveryExecuted:false};
check(summary.fullSchemaSameDefinitionsAsRehearsal&&summary.rawSchemaSameOrderAsRehearsal,'SCHEMA_DRIFT_REQUIRES_REVIEW');
writeFileSync(process.argv[3]||join(dir,'verification.json'),JSON.stringify(summary,null,2)+'\n');
console.log(summary.result);
check(duplicates.length===0,'AMBIGUOUS_SQL_MANIFEST_REQUIRES_REVIEW_AND_REHEARSAL');
console.log('Exact target shape, history, full visibility, dependencies and unique manifest identities verified; no database writes.');
