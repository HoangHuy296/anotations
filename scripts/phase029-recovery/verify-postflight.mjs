// Future execution verification only; offline, never executes a migration.
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const [beforeDir,afterDir]=process.argv.slice(2);if(!beforeDir||!afterDir)throw Error('BEFORE_AND_AFTER_REQUIRED');
const read=p=>JSON.parse(readFileSync(p));
const b=read(join(beforeDir,'evidence.json')),a=read(join(afterDir,'evidence.json'));
const eq=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
const check=(v,m)=>{if(!v)throw Error(m);};
for(const manifest of [b.schema.value,b.expectedSchema.value,a.schema.value]){
 const keys=manifest.map(x=>JSON.stringify(x.slice(0,2)));
 check(new Set(keys).size===keys.length,'AMBIGUOUS_SQL_MANIFEST');
}
check(b.identity.value.systemIdentifier===a.identity.value.systemIdentifier,'INSTANCE_CHANGED');
check(eq(b.rows.value,a.rows.value),'APPLICATION_ROW_FINGERPRINT_CHANGED');
check(eq(b.expectedSchema.value,a.schema.value),'UNEXPECTED_SCHEMA_CHANGE');
check(a.receipts.value.phase029ColumnsAbsent===true,'PHASE029_COLUMNS_REMAIN');
check(a.visibility.value.length===35&&a.visibility.value.every(x=>!x.rls&&!x.forceRls&&x.select),'VISIBILITY_CHANGED');
const before=new Map(b.history.value.map(h=>[h.name,h]));
check(before.size===22&&a.history.value.length===23,'UNEXPECTED_MIGRATION_HISTORY');
for(const h of a.history.value){
 if(before.has(h.name))check(eq(h,before.get(h.name)),'ORIGINAL_HISTORY_CHANGED');
 else check(h.name==='20260930020000_revert_dataset_modality'&&h.checksum==='3bb6389f380ffaa5c3be88d26d56782065a00b3844f0326ccba1c05ee4b5a1db'&&h.finishedAt&&!h.rolledBackAt,'CORRECTIVE_HISTORY_NOT_FINISHED');
}
check(read(join(afterDir,'status-result.json')).exitCode===0,'PRISMA_STATUS_FAILED');
writeFileSync(join(afterDir,'postflight-verification.json'),JSON.stringify({result:'PASS',sameInstance:true,all35TableFingerprintsUnchanged:true,all22OriginalHistoryRecordsUnchanged:true,onlyApprovedObjectsRemoved:true,correctiveMigrationFinished:true,prismaStatusClean:true,rawSchemaOrderMatchesPreflight:eq(b.expectedSchema.value,a.schema.value)},null,2)+'\n');
console.log('POSTFLIGHT_PASS');
