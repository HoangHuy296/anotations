import "../../../../scripts/db-safety/test-entry.cjs";
import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { PrismaClient, Prisma } from "@internal/db";
import { resolveEmptyDataset } from "@/lib/datasets/modality";
import { isModalityTransactionConflict, retryModalityTransaction } from "@annotationplatform/domain";
import { db } from "@/lib/db";

const clients=Array.from({length:3},()=>new PrismaClient());
const [a,b,observer]=clients;
const owner={id:"g2-owner",role:"MANAGER" as const,email:"",name:""};
const settings={isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted,timeout:15000,maxWait:10000};
const asset=(id:string,datasetId:string,modality:"IMAGE"|"AUDIO"="IMAGE")=>({id,datasetId,filename:id,relativePath:id,sourceFingerprint:`g3:${id}`,mimeType:modality==="IMAGE"?"image/png":"audio/wav",modality});
const code=(e:unknown)=>e&&typeof e==="object"&&"code" in e?String(e.code):e instanceof Error?e.message:"unknown";
function signal(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function diagnostic(e:unknown){
  assert.ok(e instanceof Error);
  const fields=Object.fromEntries(Object.getOwnPropertyNames(e).filter(k=>k!=="stack").map(k=>[k,(e as unknown as Record<string,unknown>)[k]]));
  console.log('G3_PRISMA_ERROR '+JSON.stringify({constructor:e.constructor.name,fields,retryable:isModalityTransactionConflict(e)}));
}
const measurements:Array<Record<string,unknown>>=[];
async function dataset(id:string,modality:"IMAGE"|"AUDIO"="IMAGE"){
  return a.dataset.create({data:{id,name:id,ownerId:owner.id,modality,modalityResolverSubject:owner.id},select:{id:true}});
}
const parent=(id:string)=>a.dataset.findUniqueOrThrow({where:{id},select:{modality:true,modalityContentRevision:true,modalityResolvedAt:true,modalityResolverSubject:true,visualizationGeneration:true,updatedAt:true}});
async function invariant(){
  const datasets=await observer.dataset.findMany({select:{id:true,modality:true,modalityResolvedAt:true,modalityResolverSubject:true,modalityContentRevision:true}});
  const assets=await observer.asset.findMany({select:{id:true,datasetId:true,modality:true}});
  for(const d of datasets){
    assert.ok(d.modalityContentRevision>=BigInt(0));
    if(d.modality===null){assert.equal(d.modalityResolvedAt,null);assert.equal(d.modalityResolverSubject,null);}
    else {assert.ok(d.modalityResolvedAt);assert.ok(d.modalityResolverSubject);for(const row of assets.filter(x=>x.datasetId===d.id))assert.equal(row.modality,d.modality,`MISMATCH ${row.id}`);}
  }
}
async function step(name:string,fn:()=>Promise<void>){
 const started=performance.now();
 try {await fn();await invariant();console.log('G3_SCENARIO '+JSON.stringify({name,pass:true,elapsedMs:performance.now()-started}));}
 catch(e){console.log('G3_CORRECTNESS_HALT '+JSON.stringify({name,code:code(e),elapsedMs:performance.now()-started}));throw e;}
}
async function waitBlocked(pid:number){
  const start=performance.now();
  while(performance.now()-start<5000){
    const rows=await observer.$queryRaw<Array<{pid:number;wait_event_type:string|null;blockers:number[]}>>`SELECT pid,wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=${pid}`;
    if(rows[0]?.wait_event_type==='Lock'&&rows[0].blockers.length){measurements.push({kind:'observed-lock',pid,blockers:rows[0].blockers,observedAfterMs:performance.now()-start});return;}
    await delay(10);
  }
  throw new Error('G3_EXPECTED_LOCK_NOT_OBSERVED');
}
// One sequential test intentionally halts the suite at its first correctness defect.
test("G3 real-connection correctness schedules (stop on first defect)", {timeout:180000},async()=>{
 try {
  await step('independent PostgreSQL connections',async()=>{
    const pids=await Promise.all(clients.map(c=>c.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`));
    assert.equal(new Set(pids.map(r=>r[0].pid)).size,3);console.log('G3_BACKENDS '+JSON.stringify(pids));
  });
  await step('new presence / frozen modality / receipt including empty parent',async()=>{
    await dataset('g3-empty');const before=await parent('g3-empty');
    await assert.rejects(a.dataset.create({data:{name:'missing',ownerId:owner.id},select:{id:true}}));
    for(const data of [{modality:'AUDIO' as const},{modality:null},{modalityResolverSubject:'other'},{modalityResolvedAt:new Date(0)}])await assert.rejects(a.dataset.update({where:{id:'g3-empty'},data,select:{id:true}}));
    assert.deepEqual(await parent('g3-empty'),before);
  });
  await step('bulk, nested and upsert equality failures roll back full statements',async()=>{
    const before=await parent('g3-empty');
    await assert.rejects(a.asset.createMany({data:[asset('g3-bulk-ok','g3-empty'),asset('g3-bulk-bad','g3-empty','AUDIO')]}));
    const {datasetId: omittedParent, ...nested}=asset('g3-nested','g3-empty','AUDIO');void omittedParent;
    await assert.rejects(a.dataset.update({where:{id:'g3-empty'},data:{assets:{create:nested}},select:{id:true}}));
    await assert.rejects(a.asset.upsert({where:{id:'g3-upsert'},create:asset('g3-upsert','g3-empty','AUDIO'),update:{width:10},select:{id:true}}));
    assert.equal(await a.asset.count({where:{datasetId:'g3-empty'}}),0);assert.deepEqual(await parent('g3-empty'),before);
    await a.asset.createMany({data:[asset('g3-bulk1','g3-empty'),asset('g3-bulk2','g3-empty')]});
    assert.equal((await parent('g3-empty')).modalityContentRevision,before.modalityContentRevision+BigInt(2));
    const beforeDelete=await parent('g3-empty');await a.asset.delete({where:{id:'g3-bulk1'},select:{id:true}});
    assert.equal((await parent('g3-empty')).modalityContentRevision,beforeDelete.modalityContentRevision+BigInt(1));
    const full=await parent('g3-empty');await assert.rejects(a.asset.updateMany({where:{datasetId:'g3-empty'},data:{modality:'AUDIO'}}));assert.deepEqual(await parent('g3-empty'),full);
    await a.asset.create({data:asset('g3-empty-meta-peer','g3-empty'),select:{id:true}});
  });
  await step('archived/deleted history equality and restoration',async()=>{
    await a.asset.update({where:{id:'g3-empty-meta-peer'},data:{archivedAt:new Date(),deletedAt:new Date()},select:{id:true}});
    await assert.rejects(a.asset.update({where:{id:'g3-empty-meta-peer'},data:{modality:'AUDIO'},select:{id:true}}));
    await a.asset.update({where:{id:'g3-empty-meta-peer'},data:{archivedAt:null,deletedAt:null},select:{id:true}});
  });
  await step('unresolved legacy ingest blocked; unchanged-modality metadata and cleanup allowed',async()=>{
    const before=await parent('g2-mixed');
    await assert.rejects(a.asset.create({data:asset('g3-unresolved','g2-mixed'),select:{id:true}}));
    await assert.rejects(a.asset.update({where:{id:'g3-bulk2'},data:{datasetId:'g2-mixed'},select:{id:true}}));
    assert.deepEqual(await parent('g2-mixed'),before);
    await a.asset.update({where:{id:'g2-asset-mixed-image'},data:{description:'legitimate metadata',width:123},select:{id:true}});
    assert.equal((await parent('g2-mixed')).modality,null);
    const single=await parent('g2-single');assert.equal((await resolveEmptyDataset(owner,'g2-single','IMAGE',a)).ok,false);assert.deepEqual(await parent('g2-single'),single);
  });
  await step('existing source identity constraint and metadata/workflow preserve revision semantics',async()=>{
    const before=await parent('g3-empty');
    await assert.rejects(a.asset.create({data:{...asset('g3-duplicate','g3-empty'),sourceFingerprint:'g3:g3-bulk2'},select:{id:true}}));
    assert.deepEqual(await parent('g3-empty'),before);
    const assetBefore=await a.asset.findUniqueOrThrow({where:{id:'g3-bulk2'},select:{revision:true}});
    await a.asset.update({where:{id:'g3-bulk2'},data:{description:'work',status:'IN_PROGRESS'},select:{id:true}});
    const after=await parent('g3-empty');assert.equal(after.modalityContentRevision,before.modalityContentRevision);assert.equal(after.visualizationGeneration,before.visualizationGeneration);
    const identityBefore=after.modalityContentRevision;
    await a.asset.update({where:{id:'g3-bulk2'},data:{sourceFingerprint:'g3:identity-transition',sourceRevision:'rev-2',sourcePath:'repo/path.png',sourceFileSha:'file-sha-2',checksum:'checksum-2',mimeType:'image/webp',sizeBytes:BigInt(42),width:40,height:30},select:{id:true}});
    assert.equal((await parent('g3-empty')).modalityContentRevision,identityBefore+BigInt(1));
    assert.equal((await a.asset.findUniqueOrThrow({where:{id:'g3-bulk2'},select:{revision:true}})).revision,assetBefore.revision);
  });
  await step('rollback restores parent fence, generation and Asset content',async()=>{
    const before=await parent('g3-empty');const row=await a.asset.findUniqueOrThrow({where:{id:'g3-bulk2'}});
    await assert.rejects(a.$transaction(async tx=>{await tx.asset.update({where:{id:row.id},data:{width:808},select:{id:true}});throw new Error('G3_ROLLBACK');}),/G3_ROLLBACK/);
    assert.deepEqual(await parent('g3-empty'),before);assert.deepEqual(await a.asset.findUniqueOrThrow({where:{id:row.id}}),row);
  });
  await step('dataset hard-delete cascade with Assets and annotations',async()=>{
    await dataset('g3-cascade');await a.asset.create({data:asset('g3-cascade-asset','g3-cascade'),select:{id:true}});
    await a.annotation.create({data:{id:'g3-cascade-annotation',datasetId:'g3-cascade',assetId:'g3-cascade-asset',createdById:owner.id,modality:'IMAGE',type:'BOUNDING_BOX',geometry:{x:0,y:0,width:0.5,height:0.5}},select:{id:true}});
    await a.dataset.delete({where:{id:'g3-cascade'},select:{id:true}});
    assert.equal(await a.asset.count({where:{datasetId:'g3-cascade'}}),0);assert.equal(await a.annotation.count({where:{datasetId:'g3-cascade'}}),0);
  });
  await step('concurrent matching/incompatible insertion against resolved Dataset',async()=>{
    const result=await Promise.allSettled([a.asset.create({data:asset('g3-race-ok','g3-empty'),select:{id:true}}),b.asset.create({data:asset('g3-race-bad','g3-empty','AUDIO'),select:{id:true}})]);
    assert.equal(result[0].status,'fulfilled');assert.equal(result[1].status,'rejected');
  });
  await step('different-Asset metadata writes skip parent fence and do not block each other',async()=>{
    const before=await parent('g3-empty');const updated=signal(),release=signal();
    const first=a.$transaction(async tx=>{await tx.asset.update({where:{id:'g3-bulk2'},data:{description:'held metadata'},select:{id:true}});updated.resolve();await release.promise;},settings);
    await updated.promise;
    const second=b.asset.update({where:{id:'g3-empty-meta-peer'},data:{status:'IN_PROGRESS',description:'parallel metadata'},select:{id:true}}).then(()=>true,()=>false);
    let completed=false;try{completed=await Promise.race([second,delay(700).then(()=>false)]);}finally{release.resolve();}
    await first;assert.equal(completed,true);assert.equal((await parent('g3-empty')).modalityContentRevision,before.modalityContentRevision);
  });
  await step('metadata transaction does not block identity fence; identity transition advances it',async()=>{
    const before=await parent('g3-empty');const updated=signal(),release=signal();
    const metadata=a.$transaction(async tx=>{await tx.asset.update({where:{id:'g3-bulk2'},data:{description:'metadata held across identity'},select:{id:true}});updated.resolve();await release.promise;},settings);
    await updated.promise;
    try{
      await assert.rejects(b.asset.update({where:{id:'g3-empty-meta-peer'},data:{modality:'AUDIO'},select:{id:true}}));
      await b.asset.update({where:{id:'g3-empty-meta-peer'},data:{sourceFingerprint:'g3:peer-identity-v1',sourceRevision:'v1'},select:{id:true}});
    }finally{release.resolve();}
    await metadata;assert.equal((await parent('g3-empty')).modalityContentRevision,before.modalityContentRevision+BigInt(1));
  });
  await step('two identity transitions synchronize through the parent fence',async()=>{
    const before=await parent('g3-empty');const locked=signal(),release=signal(),started=signal();let pid=0;
    const first=a.$transaction(async tx=>{await tx.asset.update({where:{id:'g3-bulk2'},data:{sourceFingerprint:'g3:identity-a'},select:{id:true}});locked.resolve();await release.promise;},settings);
    await locked.promise;
    const second=b.$transaction(async tx=>{pid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0].pid;started.resolve();await tx.asset.update({where:{id:'g3-empty-meta-peer'},data:{sourceFingerprint:'g3:identity-b'},select:{id:true}});},settings);
    try{await started.promise;await waitBlocked(pid);}finally{release.resolve();}
    await Promise.all([first,second]);assert.equal((await parent('g3-empty')).modalityContentRevision,before.modalityContentRevision+BigInt(2));
  });
  await step('same-row concurrent metadata updates serialize and retain both changes',async()=>{
    const locked=signal(),release=signal(),started=signal();let pid=0;
    const first=a.$transaction(async tx=>{await tx.asset.update({where:{id:'g3-bulk2'},data:{width:400},select:{id:true}});locked.resolve();await release.promise;},settings);
    await locked.promise;
    const second=b.$transaction(async tx=>{pid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0].pid;started.resolve();await tx.asset.update({where:{id:'g3-bulk2'},data:{height:300},select:{id:true}});},settings);
    try{await started.promise;await waitBlocked(pid);}finally{release.resolve();}
    await Promise.all([first,second]);const row=await a.asset.findUniqueOrThrow({where:{id:'g3-bulk2'},select:{width:true,height:true}});assert.deepEqual(row,{width:400,height:300});
  });
  await step('opposite-direction concurrent reparent and incompatible reparent',async()=>{
    await dataset('g3-move-a');await dataset('g3-move-b');await dataset('g3-audio','AUDIO');
    await a.asset.create({data:asset('g3-move-1','g3-move-a'),select:{id:true}});await a.asset.create({data:asset('g3-move-2','g3-move-b'),select:{id:true}});
    const beforeA=await parent('g3-move-a'),beforeB=await parent('g3-move-b');
    await Promise.all([retryModalityTransaction(()=>a.asset.update({where:{id:'g3-move-1'},data:{datasetId:'g3-move-b'},select:{id:true}})),retryModalityTransaction(()=>b.asset.update({where:{id:'g3-move-2'},data:{datasetId:'g3-move-a'},select:{id:true}}))]);
    assert.equal((await parent('g3-move-a')).modalityContentRevision,beforeA.modalityContentRevision+BigInt(2));
    assert.equal((await parent('g3-move-b')).modalityContentRevision,beforeB.modalityContentRevision+BigInt(2));
    await assert.rejects(a.asset.update({where:{id:'g3-move-1'},data:{datasetId:'g3-audio'},select:{id:true}}));
  });
  await step('resolution parent fence blocks incompatible insertion until assignment commits',async()=>{
    // g2-former-admin-empty is an untouched historical EMPTY fixture.
    const held=signal(),release=signal(),started=signal();let pid=0;
    const first=a.$transaction(async tx=>{await tx.dataset.update({where:{id:'g2-former-admin-empty'},data:{modalityContentRevision:{increment:1}},select:{id:true}});await tx.dataset.update({where:{id:'g2-former-admin-empty'},data:{modality:'IMAGE',modalityResolverSubject:owner.id},select:{id:true}});held.resolve();await release.promise;},{...settings,isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
    await held.promise;
    const second=b.$transaction(async tx=>{pid=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0].pid;started.resolve();await tx.asset.create({data:asset('g3-resolution-bad','g2-former-admin-empty','AUDIO'),select:{id:true}});},settings);
    const settled=Promise.allSettled([first,second]);try{await started.promise;await waitBlocked(pid);}finally{release.resolve();}
    const result=await settled;assert.equal(result[0].status,'fulfilled');assert.equal(result[1].status,'rejected');assert.equal(await a.asset.count({where:{id:'g3-resolution-bad'}}),0);
  });
  await step('repeatable-read stale assignment rejects after concurrent child source-identity fence',async()=>{
    const read=signal(),go=signal();let old=BigInt(0);
    const stale=a.$transaction(async tx=>{old=(await tx.dataset.findUniqueOrThrow({where:{id:'g2-single'},select:{modalityContentRevision:true}})).modalityContentRevision;read.resolve();await go.promise;await tx.dataset.update({where:{id:'g2-single'},data:{modalityContentRevision:{increment:1}},select:{id:true}});await tx.dataset.update({where:{id:'g2-single'},data:{modality:'IMAGE',modalityResolverSubject:owner.id},select:{id:true}});},{...settings,isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
    const failure=stale.then(()=>null,e=>e);await read.promise;await b.asset.update({where:{id:'g2-asset-single'},data:{sourceFingerprint:'g2:single-source-transition'},select:{id:true}});go.resolve();const error=await failure;assert.equal(code(error),'P2034');
    measurements.push({kind:'serialization-rejection',code:code(error)});const now=await parent('g2-single');assert.equal(now.modality,null);assert.equal(now.modalityContentRevision,old+BigInt(1));
  });
  await step('deliberate two-connection deadlock uses bounded whole-transaction retry',async()=>{
    const gates=[signal(),signal()];const attempts=[0,0];const failures:unknown[]=[];
    const ids=['g3-move-a','g3-move-b'];const before=await Promise.all(ids.map(parent));
    const run=(index:number)=>retryModalityTransaction(async()=>{
      const attempt=++attempts[index];try{return await clients[index].$transaction(async tx=>{
        await tx.label.create({data:{id:`g3-retry-marker-${index}`,datasetId:ids[index],name:`retry ${index}`,normalizedName:`retry ${index}`,color:'#112233'},select:{id:true}});
        await tx.dataset.update({where:{id:ids[index]},data:{modalityContentRevision:{increment:1}},select:{id:true}});
        if(attempt===1){gates[index].resolve();await gates[1-index].promise;}
        await tx.dataset.update({where:{id:ids[1-index]},data:{modalityContentRevision:{increment:1}},select:{id:true}});
      },settings);}catch(e){diagnostic(e);failures.push(e);throw e;}
    });
    await Promise.all([run(0),run(1)]);assert.equal(failures.length,1);assert.equal(isModalityTransactionConflict(failures[0]),true);
    for(let i=0;i<2;i++)assert.equal((await parent(ids[i])).modalityContentRevision,before[i].modalityContentRevision+BigInt(2));
    assert.equal(await a.label.count({where:{id:{startsWith:'g3-retry-marker-'}}}),2);assert.equal(attempts[0]+attempts[1],3);measurements.push({kind:'deadlock-retry',attempts,failures:failures.length,committedMarkers:2,rolledBackFenceIncrements:1});
  });
  await step('bounded retry exhaustion with real serialization failures rolls back every attempt',async()=>{
    let attempts=0;const before=await parent('g3-empty');
    await assert.rejects(retryModalityTransaction(()=>a.$transaction(async tx=>{
      attempts++;await tx.label.create({data:{id:'g3-exhaustion-marker',datasetId:'g3-move-a',name:'exhaustion',normalizedName:'exhaustion',color:'#112233'},select:{id:true}});await tx.dataset.findUniqueOrThrow({where:{id:'g3-empty'},select:{modalityContentRevision:true}});
      await b.dataset.update({where:{id:'g3-empty'},data:{modalityContentRevision:{increment:1}},select:{id:true}});
      await tx.dataset.update({where:{id:'g3-empty'},data:{modalityContentRevision:{increment:1}},select:{id:true}});
    },{...settings,isolationLevel:Prisma.TransactionIsolationLevel.Serializable})),e=>code(e)==='P2034');
    assert.equal(attempts,3);assert.equal(await a.label.count({where:{id:'g3-exhaustion-marker'}}),0);assert.equal((await parent('g3-empty')).modalityContentRevision,before.modalityContentRevision+BigInt(3));measurements.push({kind:'retry-exhaustion',attempts,failures:3});
  });
  await step('raw Prisma serialization metadata is verified, not guessed',async()=>{
    const before=await parent('g3-empty');
    const error=await a.$transaction(async tx=>{
      await tx.dataset.findUniqueOrThrow({where:{id:'g3-empty'},select:{id:true}});
      await b.dataset.update({where:{id:'g3-empty'},data:{modalityContentRevision:{increment:1}},select:{id:true}});
      await tx.$queryRaw`SELECT id FROM "Dataset" WHERE id='g3-empty' FOR UPDATE`;
    },{...settings,isolationLevel:Prisma.TransactionIsolationLevel.Serializable}).then(()=>null,e=>e);
    diagnostic(error);assert.equal(error.code,'P2010');assert.equal(error.meta.code,'40001');assert.equal(isModalityTransactionConflict(error),true);
    assert.equal((await parent('g3-empty')).modalityContentRevision,before.modalityContentRevision+BigInt(1));
  });
  await step('raw Prisma deadlock metadata whole transaction retry',async()=>{
    const gates=[signal(),signal()],attempts=[0,0];const errors:unknown[]=[];const ids=['g3-move-a','g3-move-b'];
    const run=(i:number)=>retryModalityTransaction(async()=>{const attempt=++attempts[i];try{
      await clients[i].$transaction(async tx=>{
        await tx.$queryRaw`SELECT id FROM "Dataset" WHERE id=${ids[i]} FOR UPDATE`;
        if(attempt===1){gates[i].resolve();await gates[1-i].promise;}
        await tx.$queryRaw`SELECT id FROM "Dataset" WHERE id=${ids[1-i]} FOR UPDATE`;
      },settings);
    }catch(e){diagnostic(e);errors.push(e);throw e;}});
    await Promise.all([run(0),run(1)]);assert.equal(errors.length,1);
    const e=errors[0] as {code:string;meta:{code:string}};assert.equal(e.code,'P2010');assert.equal(e.meta.code,'40P01');assert.equal(attempts[0]+attempts[1],3);
    measurements.push({kind:'raw-deadlock-retry',attempts,failures:errors.length});
  });
  console.log('G3_CONCURRENCY_MEASUREMENTS '+JSON.stringify(measurements));
 }finally{await Promise.all([...clients,db].map(c=>c.$disconnect()));}
});
