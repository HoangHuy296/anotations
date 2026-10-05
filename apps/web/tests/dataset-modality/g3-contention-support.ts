import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { PrismaClient, Prisma } from "@internal/db";
import { isModalityTransactionConflict, retryModalityTransaction } from "@annotationplatform/domain";

type Client = PrismaClient;
type Row = {workload:string;repetition:number;concurrency:number;index:number;lane:number;latencyMs:number;attemptMs:number[];errors:string[];attempts:Array<Record<string,unknown>>;outcome:string};
const quantile=(xs:number[],p:number)=>[...xs].sort((a,b)=>a-b)[Math.max(0,Math.ceil(xs.length*p)-1)];
const settings={isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted,maxWait:10000,timeout:15000};
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const fields={id:true};
export async function contention(profile:'baseline'|'candidate'){
 const receipt=JSON.parse(readFileSync(process.env.DB_SAFETY_RECEIPT!,'utf8'));
 const Ctor=profile==='candidate'?PrismaClient:(await import(pathToFileURL(join(dirname(receipt.config),'baseline-client/client.ts')).href)).PrismaClient;
 const clients:Client[]=Array.from({length:8},()=>new Ctor());const monitor:Client=new Ctor();const admin=clients[0];
 const raw:Row[]=[];const summary:unknown[]=[];const lockSamples:unknown[]=[];
 const workloads=['metadata-same-parent','metadata-cross-parent','bulk-insert','content-same-parent','serializable-same-parent','serializable-cross-parent','serializable-update-only'];
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
  console.log('G3_BENCH_ENV '+JSON.stringify({profile,config,node:process.version,prisma:Prisma.prismaVersion.client,fixture:{datasets:8,assets:512,lanes:8},repetitions:5,operationsPerRun:64,concurrency:[1,2,4,8],warmupPerLane:2,percentile:'nearest rank',latency:'whole transaction including attempts and backoff',lockSamplingMs:20,workloads}));
  await fixture();
  // Establish independent connections before timings.
  const pids=await Promise.all(clients.map(c=>c.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`));
  assert.equal(new Set(pids.map(x=>x[0].pid)).size,8);
  // Separate diagnostic, excluded from timed measurements: distinct children,
  // same resolved parent, one held transaction. Captures actual blocking path.
  let heldResolve!:()=>void;const held=new Promise<void>(r=>heldResolve=r);
  const first=clients[0].$transaction(async tx=>{
    await tx.asset.update({where:{id:assetId(0,40)},data:{description:'held diagnostic'},select:fields});
    heldResolve();await pause(1300);
  },settings);
  await held;const waitStart=performance.now();
  const second=clients[1].$transaction(async tx=>{
    await tx.asset.update({where:{id:assetId(0,41)},data:{description:'waiting diagnostic'},select:fields});
  },settings);
  await pause(200);
  const heldLocks=await monitor.$queryRaw`SELECT a.pid,a.wait_event,a.query,pg_blocking_pids(a.pid) AS blockers,extract(epoch from (clock_timestamp()-a.xact_start))::float8 AS transaction_seconds,
    (SELECT json_agg(json_build_object('locktype',l.locktype,'mode',l.mode,'granted',l.granted,'relation',CASE WHEN l.relation IS NULL THEN NULL ELSE l.relation::regclass::text END,'page',l.page,'tuple',l.tuple,'transactionid',l.transactionid::text)) FROM pg_locks l WHERE l.pid=a.pid AND (l.relation=(SELECT oid FROM pg_class WHERE relname='Dataset' AND relnamespace='public'::regnamespace) OR l.locktype='transactionid')) AS locks
    FROM pg_stat_activity a WHERE a.datname=current_database() AND a.wait_event_type='Lock'`;
  await second;const waiterMs=performance.now()-waitStart;await first;
  console.log('G3_HELD_PARENT '+JSON.stringify({profile,parent:ids[0],distinctAssets:[assetId(0,40),assetId(0,41)],heldMs:1300,waiterMs,heldLocks}));
  const functions=await monitor.$queryRaw`SELECT funcname,calls,total_time,self_time FROM pg_stat_user_functions ORDER BY funcname`;
  console.log('G3_FUNCTIONS_BEFORE '+JSON.stringify(functions,(_,v)=>typeof v==='bigint'?v.toString():v));
  for(const workload of workloads)for(const concurrency of [1,2,4,8])for(let rep=0;rep<5;rep++){
   let monitoring=true;let observed=0;let polls=0;let observerFailure:unknown;
   const deadlockBefore=(await monitor.$queryRaw<Array<{deadlocks:bigint}>>`SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()`)[0].deadlocks;
   // Warm up each participating connection on its own row, excluded from sample.
   await Promise.all(clients.slice(0,concurrency).map(async(c,lane)=>{for(let k=0;k<2;k++)await c.$transaction(tx=>tx.asset.update({where:{id:assetId(lane,63)},data:{description:`warm-${k}`},select:fields}),settings);}));
   const sample=async()=>{while(monitoring){
    const rows=await monitor.$queryRaw<Array<{pid:number;blockers:number[]}>>`SELECT a.pid,pg_blocking_pids(a.pid) AS blockers,a.wait_event,a.query,extract(epoch from (clock_timestamp()-a.xact_start))::float8 AS transaction_seconds,
      (SELECT json_agg(json_build_object('locktype',l.locktype,'mode',l.mode,'granted',l.granted,'relation',CASE WHEN l.relation IS NULL THEN NULL ELSE l.relation::regclass::text END,'page',l.page,'tuple',l.tuple,'transactionid',l.transactionid::text)) FROM pg_locks l WHERE l.pid=a.pid AND (l.relation=(SELECT oid FROM pg_class WHERE relname='Dataset' AND relnamespace='public'::regnamespace) OR l.locktype='transactionid')) AS locks
      FROM pg_stat_activity a WHERE a.datname=current_database() AND a.wait_event_type='Lock' AND a.pid<>pg_backend_pid()`;
    polls++;if(rows.length){observed+=rows.length;lockSamples.push({workload,rep,concurrency,atMs:performance.now(),rows});}await pause(20);
   }};
   const sampling=sample().catch(e=>{observerFailure=e;});
   const rollbackBefore=workload==='rollback'?await admin.asset.findMany({where:{datasetId:{in:ids}},orderBy:{id:'asc'}}):null;
   const start=performance.now();let wallMs=0;const samples:Row[]=[];
   try{await Promise.all(clients.slice(0,concurrency).map(async(c,lane)=>{
    for(let n=lane;n<64;n+=concurrency){
     const errors:string[]=[],attemptMs:number[]=[],attempts:Array<Record<string,unknown>>=[];const begin=performance.now();let outcome='committed';
     try {await retryModalityTransaction(async()=>{
      const attempt=performance.now();const detail:Record<string,unknown>={attempt:attemptMs.length+1,startedAt:new Date().toISOString(),outcome:"committed"};try{
       await c.$transaction(async tx=>{
        const identity=await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`;
        detail.pid=identity[0].pid;
        const d=workload.endsWith('cross-parent')?lane:0;
        const id=assetId(d,lane);
        if(workload==='bulk-insert')await tx.asset.createMany({data:Array.from({length:8},(_,j)=>({id:`g3-bench-new-${rep}-${concurrency}-${n}-${j}`,datasetId:ids[0],filename:`new${n}-${j}`,sourceFingerprint:`g3-bench-new-${rep}-${concurrency}-${n}-${j}`,relativePath:`new${rep}-${concurrency}-${n}-${j}`,modality:'IMAGE' as const,mimeType:'image/png'}))});
        else if(workload==='reparent'){
          await tx.asset.update({where:{id:assetId(lane,1)},data:{datasetId:ids[(Math.floor(n/concurrency)%2)?lane:(lane+1)%8]},select:fields});
        }else{
          if(workload!=='serializable-update-only')await tx.asset.findUniqueOrThrow({where:{id},select:{id:true}});
          await tx.asset.update({where:{id},data:workload==='content-same-parent'?{width:100+n}:{description:`benchmark-${rep}-${concurrency}-${n}`,status:n%2?'IN_PROGRESS':'NEW'},select:fields});
          if(workload==='rollback')throw new Error('G3_EXPECTED_ROLLBACK');
        }
       },{...settings,isolationLevel:workload.startsWith('serializable')?Prisma.TransactionIsolationLevel.Serializable:settings.isolationLevel});
      }catch(e){
       if(e instanceof Error&&e.message==='G3_EXPECTED_ROLLBACK')throw e;
       if(!isModalityTransactionConflict(e))throw e;
       const state=(e as {code?:string}).code==='P2034'?'P2034':(e as {meta?:{code:string}}).meta?.code??'40P01-connector';errors.push(state);detail.prismaCode=state;detail.outcome='conflict';throw e;
      }finally{const ms=performance.now()-attempt;attemptMs.push(ms);detail.elapsedMs=ms;detail.endedAt=new Date().toISOString();attempts.push(detail);}
     });}catch(e){
      if(e instanceof Error&&e.message==='G3_EXPECTED_ROLLBACK')outcome='rolled-back';
      else if(isModalityTransactionConflict(e)){assert.equal(attemptMs.length,3);outcome='retry-exhausted';}
      else throw e;
     }
     samples.push({workload,repetition:rep,concurrency,index:n,lane,latencyMs:performance.now()-begin,attemptMs,errors,attempts,outcome});
    }
   }));}finally{wallMs=performance.now()-start;monitoring=false;await sampling;}
   if(observerFailure)throw observerFailure;
   raw.push(...samples);const lat=samples.map(r=>r.latencyMs);
   const deadlockAfter=(await monitor.$queryRaw<Array<{deadlocks:bigint}>>`SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()`)[0].deadlocks;
   const result={profile,workload,repetition:rep,concurrency,operations:samples.length,wallMs,throughput:samples.length/(wallMs/1000),successfulThroughput:samples.filter(r=>r.outcome==='committed').length/(wallMs/1000),attemptSuccess:[1,2,3].map(k=>samples.filter(r=>r.outcome==='committed'&&r.attempts.length===k).length),p50:quantile(lat,.5),p95:quantile(lat,.95),p99:quantile(lat,.99),retries:samples.reduce((n,r)=>n+r.attemptMs.length-1,0),conflicts:samples.reduce((n,r)=>n+r.errors.length,0),exhausted:samples.filter(r=>r.outcome==='retry-exhausted').length,lockSamples:observed,polls,postgresDeadlockDelta:Number(deadlockAfter-deadlockBefore)};
   summary.push(result);console.log('G3_BENCH_RUN '+JSON.stringify(result));
   console.log('G3_BENCH_BATCH '+JSON.stringify({profile,workload,concurrency,repetition:rep,transactions:samples}));
   console.log('G3_BENCH_LOCK_BATCH '+JSON.stringify({profile,workload,concurrency,repetition:rep,samples:lockSamples.splice(0)}));
   if(rollbackBefore)assert.deepEqual(await admin.asset.findMany({where:{datasetId:{in:ids}},orderBy:{id:'asc'}}),rollbackBefore);
   if(workload==='bulk-insert')assert.equal(await admin.asset.count({where:{datasetId:{in:ids}}}),512+samples.filter(r=>r.outcome==='committed').length*8);
   const parents=await monitor.dataset.findMany({where:{id:{in:ids}},select:{id:true,...(profile==='candidate'?{modality:true}: {})}});
   const assets=await monitor.asset.findMany({where:{datasetId:{in:ids}},select:{id:true,modality:true,datasetId:true}});
   assert.equal(parents.length,8);assert.ok(assets.every(a=>a.modality==='IMAGE'));
   if(profile==='candidate')assert.ok(parents.every(d=>d.modality==='IMAGE'));
   // Restore identical fixture size/composition between runs using normal Prisma writes.
   await admin.asset.deleteMany({where:{id:{startsWith:'g3-bench-new-'}}});
   for(let d=0;d<8;d++)await admin.asset.updateMany({where:{id:{in:Array.from({length:64},(_,i)=>assetId(d,i))}},data:{datasetId:ids[d],width:null,description:null,status:'NEW'}});
   assert.equal(await admin.asset.count({where:{datasetId:{in:ids}}}),512);
  }
  console.log('G3_BENCH_SUMMARY '+JSON.stringify(summary));
  await pause(1100);
  const functionsAfter=await monitor.$queryRaw`SELECT funcname,calls,total_time,self_time FROM pg_stat_user_functions ORDER BY funcname`;
  console.log('G3_FUNCTIONS_AFTER '+JSON.stringify(functionsAfter,(_,v)=>typeof v==='bigint'?v.toString():v));
  await cleanup();
 }finally{await Promise.all([...clients,monitor].map(c=>c.$disconnect()));}
}
