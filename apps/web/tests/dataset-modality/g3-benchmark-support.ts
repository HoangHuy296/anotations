import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { PrismaClient, Prisma } from "@internal/db";
import { isModalityTransactionConflict, retryModalityTransaction } from "@annotationplatform/domain";

type Client = PrismaClient;
type Row = {workload:string;repetition:number;concurrency:number;index:number;lane:number;latencyMs:number;attemptMs:number[];errors:string[];outcome:string};
const quantile=(xs:number[],p:number)=>[...xs].sort((a,b)=>a-b)[Math.max(0,Math.ceil(xs.length*p)-1)];
const settings={isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted,maxWait:10000,timeout:15000};
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const fields={id:true};
export async function benchmark(profile:'baseline'|'candidate'){
 const receipt=JSON.parse(readFileSync(process.env.DB_SAFETY_RECEIPT!,'utf8'));
 const Ctor=profile==='candidate'?PrismaClient:(await import(pathToFileURL(join(dirname(receipt.config),'baseline-client/client.ts')).href)).PrismaClient;
 const clients:Client[]=Array.from({length:8},()=>new Ctor());const monitor:Client=new Ctor();const admin=clients[0];
 const raw:Row[]=[];const summary:unknown[]=[];const lockSamples:unknown[]=[];
 const workloads=['metadata-same-parent','metadata-cross-parent','bulk-insert','reparent','rollback','serializable-same-parent'];
 const owner='g3-bench-owner';const ids=Array.from({length:8},(_,i)=>`g3-bench-d${i}`);
 const assetId=(d:number,i:number)=>`g3-bench-a${d}-${i}`;
 async function fixture(){
   await admin.user.create({data:{id:owner,email:'g3-benchmark@test.invalid',role:'MANAGER'},select:fields});
   for(const id of ids)await admin.dataset.create({data:{id,name:id,ownerId:owner,...(profile==='candidate'?{modality:'IMAGE' as const,modalityResolverSubject:owner}:{})},select:fields});
   for(let d=0;d<8;d++)await admin.asset.createMany({data:Array.from({length:64},(_,i)=>({id:assetId(d,i),datasetId:ids[d],filename:`${i}.png`,sourceFingerprint:`g3-bench-${d}-${i}`,relativePath:`${i}.png`,modality:'IMAGE' as const,mimeType:'image/png'}))});
 }
 async function cleanup(){await admin.dataset.deleteMany({where:{id:{in:ids}}});await admin.user.delete({where:{id:owner},select:fields});}
 try {
  const config=await monitor.$queryRaw<Array<Record<string,unknown>>>`SELECT version(), current_setting('max_connections') AS max_connections,current_setting('shared_buffers') AS shared_buffers,current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit,current_setting('deadlock_timeout') AS deadlock_timeout,current_setting('log_statement') AS log_statement`;
  console.log('G3_BENCH_ENV '+JSON.stringify({profile,config,node:process.version,prisma:Prisma.prismaVersion.client,fixture:{datasets:8,assets:512,lanes:8},repetitions:3,operationsPerRun:64,concurrency:[1,4,8],warmupPerLane:2,percentile:'nearest rank',latency:'whole transaction including attempts and backoff',lockSamplingMs:10,workloads}));
  await fixture();
  // Establish independent connections before timings.
  const pids=await Promise.all(clients.map(c=>c.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`));
  assert.equal(new Set(pids.map(x=>x[0].pid)).size,8);
  for(const workload of workloads)for(const concurrency of [1,4,8])for(let rep=0;rep<3;rep++){
   let monitoring=true;let observed=0;let polls=0;let observerFailure:unknown;
   const deadlockBefore=(await monitor.$queryRaw<Array<{deadlocks:bigint}>>`SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()`)[0].deadlocks;
   // Warm up each participating connection on its own row, excluded from sample.
   await Promise.all(clients.slice(0,concurrency).map(async(c,lane)=>{for(let k=0;k<2;k++)await c.$transaction(tx=>tx.asset.update({where:{id:assetId(lane,63)},data:{description:`warm-${k}`},select:fields}),settings);}));
   const sample=async()=>{while(monitoring){
    const rows=await monitor.$queryRaw<Array<{pid:number;blockers:number[]}>>`SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`;
    polls++;if(rows.length){observed+=rows.length;lockSamples.push({workload,rep,concurrency,atMs:performance.now(),rows});}await pause(10);
   }};
   const sampling=sample().catch(e=>{observerFailure=e;});
   const rollbackBefore=workload==='rollback'?await admin.asset.findMany({where:{datasetId:{in:ids}},orderBy:{id:'asc'}}):null;
   const start=performance.now();let wallMs=0;const samples:Row[]=[];
   try{await Promise.all(clients.slice(0,concurrency).map(async(c,lane)=>{
    for(let n=lane;n<64;n+=concurrency){
     const errors:string[]=[],attemptMs:number[]=[];const begin=performance.now();let outcome='committed';
     try {await retryModalityTransaction(async()=>{
      const attempt=performance.now();try{
       await c.$transaction(async tx=>{
        const d=workload==='metadata-cross-parent'?lane:0;
        const id=assetId(d,lane);
        if(workload==='bulk-insert')await tx.asset.createMany({data:Array.from({length:8},(_,j)=>({id:`g3-bench-new-${rep}-${concurrency}-${n}-${j}`,datasetId:ids[0],filename:`new${n}-${j}`,sourceFingerprint:`g3-bench-new-${rep}-${concurrency}-${n}-${j}`,relativePath:`new${rep}-${concurrency}-${n}-${j}`,modality:'IMAGE' as const,mimeType:'image/png'}))});
        else if(workload==='reparent'){
          await tx.asset.update({where:{id:assetId(lane,1)},data:{datasetId:ids[(Math.floor(n/concurrency)%2)?lane:(lane+1)%8]},select:fields});
        }else{
          await tx.asset.findUniqueOrThrow({where:{id},select:{id:true}});
          await tx.asset.update({where:{id},data:{description:`benchmark-${rep}-${concurrency}-${n}`,status:n%2?'IN_PROGRESS':'NEW'},select:fields});
          if(workload==='rollback')throw new Error('G3_EXPECTED_ROLLBACK');
        }
       },{...settings,isolationLevel:workload==='serializable-same-parent'?Prisma.TransactionIsolationLevel.Serializable:settings.isolationLevel});
      }catch(e){
       if(e instanceof Error&&e.message==='G3_EXPECTED_ROLLBACK')throw e;
       if(!isModalityTransactionConflict(e))throw e;
       const state=(e as {code?:string}).code==='P2034'?'P2034':(e as {meta?:{code:string}}).meta?.code??'40P01-connector';errors.push(state);throw e;
      }finally{attemptMs.push(performance.now()-attempt);}
     });}catch(e){
      if(e instanceof Error&&e.message==='G3_EXPECTED_ROLLBACK')outcome='rolled-back';
      else if(isModalityTransactionConflict(e)){assert.equal(attemptMs.length,3);outcome='retry-exhausted';}
      else throw e;
     }
     samples.push({workload,repetition:rep,concurrency,index:n,lane,latencyMs:performance.now()-begin,attemptMs,errors,outcome});
    }
   }));}finally{wallMs=performance.now()-start;monitoring=false;await sampling;}
   if(observerFailure)throw observerFailure;
   raw.push(...samples);const lat=samples.map(r=>r.latencyMs);
   const deadlockAfter=(await monitor.$queryRaw<Array<{deadlocks:bigint}>>`SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()`)[0].deadlocks;
   const result={profile,workload,repetition:rep,concurrency,operations:samples.length,wallMs,throughput:samples.length/(wallMs/1000),p50:quantile(lat,.5),p95:quantile(lat,.95),p99:quantile(lat,.99),retries:samples.reduce((n,r)=>n+r.attemptMs.length-1,0),conflicts:samples.reduce((n,r)=>n+r.errors.length,0),exhausted:samples.filter(r=>r.outcome==='retry-exhausted').length,lockSamples:observed,polls,postgresDeadlockDelta:Number(deadlockAfter-deadlockBefore)};
   summary.push(result);console.log('G3_BENCH_RUN '+JSON.stringify(result));
   if(rollbackBefore)assert.deepEqual(await admin.asset.findMany({where:{datasetId:{in:ids}},orderBy:{id:'asc'}}),rollbackBefore);
   if(workload==='bulk-insert')assert.equal(await admin.asset.count({where:{datasetId:{in:ids}}}),512+samples.filter(r=>r.outcome==='committed').length*8);
   const parents=await monitor.dataset.findMany({where:{id:{in:ids}},select:{id:true,...(profile==='candidate'?{modality:true}: {})}});
   const assets=await monitor.asset.findMany({where:{datasetId:{in:ids}},select:{id:true,modality:true,datasetId:true}});
   assert.equal(parents.length,8);assert.ok(assets.every(a=>a.modality==='IMAGE'));
   if(profile==='candidate')assert.ok(parents.every(d=>d.modality==='IMAGE'));
   // Restore identical fixture size/composition between runs using normal Prisma writes.
   await admin.asset.deleteMany({where:{id:{startsWith:'g3-bench-new-'}}});
   for(let d=0;d<8;d++)await admin.asset.updateMany({where:{id:{in:Array.from({length:64},(_,i)=>assetId(d,i))}},data:{datasetId:ids[d],description:null,status:'NEW'}});
   assert.equal(await admin.asset.count({where:{datasetId:{in:ids}}}),512);
  }
  console.log('G3_BENCH_RAW '+JSON.stringify(raw));console.log('G3_BENCH_LOCKS '+JSON.stringify(lockSamples));console.log('G3_BENCH_SUMMARY '+JSON.stringify(summary));
  await cleanup();
 }finally{await Promise.all([...clients,monitor].map(c=>c.$disconnect()));}
}
