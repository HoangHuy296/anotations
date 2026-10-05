import assert from 'node:assert/strict';
import { randomUUID, randomBytes, scryptSync, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { verify } from './guard.mjs';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const authority = require('./runtime-authority.cjs');
export async function runE2E({runtime,environment,root,browser,results=[]}) {
  const {PrismaClient}=await import('../../lib/generated/prisma/client.ts');
  const db=new PrismaClient({datasources:{db:{url:environment.DATABASE_URL}},log:[]});
  const base=`http://127.0.0.1:${runtime.roles.web.port}`;
  const provider=`http://127.0.0.1:${runtime.roles.provider.port}`;
  const password=randomBytes(16).toString('hex');const salt=randomBytes(16).toString('hex');
  let owner=await db.user.create({data:{email:`g4-http-${randomUUID()}@fixture.test`,role:'MANAGER',passwordHash:`scrypt$${salt}$${scryptSync(password,salt,64).toString('hex')}`}});
  let cookie;
  async function request(path,body,status=200,method='POST') {
    const checked=await verify(runtime.baseReceipt,'test');
    Object.assign(process.env,environment);assert.equal(checked.target.url.toString(),environment.DATABASE_URL);
    authority.ports();
    const response=await fetch(base+path,{method,signal:AbortSignal.timeout(60000),headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const json=await response.json();
    assert.ok((Array.isArray(status)?status:[status]).includes(response.status),`${path}: expected ${JSON.stringify(status)}, got ${response.status}, code=${json.error?.code || 'none'}`);
    return {response,json,data:json.data};
  }
  async function until(fn,description) {
    for(let n=0;n<100;n++) { const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,200)); }
    throw Error(`E2E_TIMEOUT:${description}`);
  }
  async function jobEvidence(jobId,expectedStatus) {
    const value=await until(async()=>{
      const j=await db.job.findUniqueOrThrow({where:{id:jobId},select:{id:true,status:true,stage:true,errorCode:true,summary:true,totalItems:true,processedItems:true,successItems:true,failedItems:true,skippedItems:true,lockToken:true,lockedUntil:true,finishedAt:true,
        events:{where:{message:{in:['JOB_PROGRESS','IMPORT_BATCH_COMPLETED','JOB_COMPLETED','JOB_FAILED']}},orderBy:{createdAt:'asc'},select:{id:true,message:true,data:true}}}});
      return j.status===expectedStatus&&j.events.some(e=>e.message===(expectedStatus==='COMPLETED'?'JOB_COMPLETED':'JOB_FAILED'))?j:null;
    },'persisted terminal state and event');
    assert.equal(value.lockToken,null);assert.equal(value.lockedUntil,null);assert.ok(value.finishedAt);
    assert.equal(value.events.filter(e=>['JOB_COMPLETED','JOB_FAILED'].includes(e.message)).length,1);
    return value;
  }
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  const text=Buffer.from('verified fixture text\n');
  const manifest=(bytes,path,type)=>({logicalPath:path,contentType:type,sizeBytes:bytes.length,fingerprint:createHash('sha256').update(bytes).digest('hex')});
  async function upload(cap,bytes,type) {
    assert.equal(new URL(cap.uploadUrl).origin,environment.MINIO_ENDPOINT,'upload is bound to receipted MinIO');
    const form=new FormData();for(const [key,value]of Object.entries(cap.formFields))form.append(key,value);
    form.append('file',new Blob([bytes],{type}),'fixture');
    const response=await fetch(cap.uploadUrl,{method:'POST',body:form});assert.ok(response.ok,`MinIO POST ${response.status}`);
  }
  async function preparation(items) {
    const body={name:'G4 HTTP images',modality:'IMAGE',idempotencyKey:randomUUID(),items};
    const first=await request('/api/imports/local-folder',body,201);
    const prep=first.data.preparation;
    const counts=async()=>({datasets:await db.dataset.count({where:{ownerId:owner.id}}),jobs:await db.job.count({where:{createdById:owner.id}}),assets:await db.asset.count({where:{dataset:{ownerId:owner.id}}}),imports:await db.preparedImport.count({where:{createdById:owner.id}}),items:await db.preparedImportItem.count({where:{preparedImport:{createdById:owner.id}}})});
    const beforeReplay=await counts();
    const replay=await request('/api/imports/local-folder',body,200);
    assert.deepEqual(Object.keys(prep).sort(),['id','datasetId','jobId','expectedItemCount','deadlineAt','items'].sort());
    assert.ok(prep.items.every(item=>Object.keys(item).length===1&&typeof item.id==='string'));
    assert.equal(typeof prep.deadlineAt,'string');assert.equal(new Date(prep.deadlineAt).toISOString(),prep.deadlineAt);
    assert.deepEqual(JSON.parse(JSON.stringify(prep)),prep);
    assert.deepEqual(replay.data.preparation,prep);
    assert.equal(first.data.replayed,false);assert.equal(replay.data.replayed,true);
    assert.deepEqual(await counts(),beforeReplay);
    for(const conflicting of [{...body,modality:'TEXT'},{...body,items:items.map((item,index)=>index===0?{...item,fingerprint:'0'.repeat(64)}:item)}]) {
      const conflict=await request('/api/imports/local-folder',conflicting,409);
      assert.equal(conflict.json.error.code,'IDEMPOTENCY_KEY_CONFLICT');
      assert.deepEqual(await counts(),beforeReplay);
    }
    results.push({name:'local-folder-preparation-json-safe-identical-replay-conflict-no-duplicates',pass:true});
    await until(async()=>{const j=await db.job.findUnique({where:{id:prep.jobId}});return j.status==='RUNNING'&&j.lockToken?j:null;},'local import claimed by private worker');
    const capabilities=(await request(`/api/imports/${prep.id}/upload-capabilities`,{itemIds:prep.items.map(i=>i.id)})).data.capabilities;
    return {prep,capabilities: prep.items.map(item => capabilities.find(cap => cap.itemId === item.id))};
  }
  try {
    const login=await request('/api/auth/login',{email:owner.email,password});
    cookie=login.response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
    const successful=await preparation([manifest(png,'success/a.png','image/png')]);
    const cap=successful.capabilities[0];const completePath=`/api/imports/${successful.prep.id}/items/${cap.itemId}/complete`;
    await request(completePath,{fileId:cap.fileId},409); // no object: explicit retryable outcome
    const retryJob=await db.job.findUniqueOrThrow({where:{id:successful.prep.jobId}});assert.equal(retryJob.summary.retryable,1);
    await upload(cap,png,'image/png');
    const completed=await request(completePath,{fileId:cap.fileId},201);assert.equal(completed.data.accepted,1);assert.equal(completed.data.retryable,0);
    const replay=await request(completePath,{fileId:cap.fileId});assert.equal(replay.data.assetId,completed.data.assetId);assert.equal(replay.data.replayed,true);
    await request(`/api/jobs/${successful.prep.jobId}/commit-import`,{});
    await request(`/api/jobs/${successful.prep.jobId}/commit-import`,{});
    assert.equal(await db.asset.count({where:{datasetId:successful.prep.datasetId}}),1);
    assert.equal((await db.job.findUniqueOrThrow({where:{id:successful.prep.jobId}})).status,'COMPLETED');
    results.push({name:'local-folder-success-retry-replay-worker',pass:true});

    const partial=await preparation([manifest(png,'partial/a.png','image/png'),manifest(text,'partial/b.txt','text/plain')]);
    for(const [index,bytes,type,expected]of [[0,png,'image/png',201],[1,text,'text/plain',409]]) {
      const item=partial.capabilities[index];await upload(item,bytes,type);
      const result=await request(`/api/imports/${partial.prep.id}/items/${item.itemId}/complete`,{fileId:item.fileId},expected);
      if(expected===409)assert.equal(result.json.error.code,'ASSET_MODALITY_MISMATCH');
    }
    await request(`/api/jobs/${partial.prep.jobId}/commit-import`,{},409);
    const partialJob=await db.job.findUniqueOrThrow({where:{id:partial.prep.jobId}});
    assert.equal(partialJob.status,'FAILED');assert.equal(partialJob.errorCode,'IMPORT_INCOMPLETE');
    assert.equal(partialJob.summary.accepted,1);assert.equal(partialJob.summary.rejected,1);assert.equal(partialJob.summary.unprocessed,0);
    assert.equal(await db.asset.count({where:{datasetId:partial.prep.datasetId,modality:'IMAGE'}}),1);
    assert.equal(await db.asset.count({where:{datasetId:partial.prep.datasetId,modality:{not:'IMAGE'}}}),0);
    results.push({name:'local-folder-partial-incompatible-accounting',pass:true});

    const dataset=(await request('/api/datasets',{name:'G4 direct images',modality:'IMAGE'},201)).data;
    const direct=(await request('/api/assets/presigned-upload',{datasetId:dataset.id,filename:'direct.png',contentType:'image/png',sizeBytes:png.length},201)).data;
    await upload(direct,png,'image/png');
    const outcomes=await Promise.all([request('/api/assets/complete-upload',{fileId:direct.fileId},[200,201,409]),request('/api/assets/complete-upload',{fileId:direct.fileId},[200,201,409])]);
    const successes=outcomes.filter(outcome=>outcome.response.status!==409);
    assert.ok(successes.length>=1,'one concurrent completion must publish successfully');
    const published=successes[0];
    for(const outcome of outcomes) {
      if(outcome.response.status===409)assert.equal(outcome.json.error.code,'UPLOAD_CONFLICT');
      else assert.equal(outcome.data.asset.id,published.data.asset.id);
    }
    const directReplay=await request('/api/assets/complete-upload',{fileId:direct.fileId});assert.equal(directReplay.data.asset.id,published.data.asset.id);
    const directAsset=await db.asset.findUniqueOrThrow({where:{id:published.data.asset.id}});
    assert.equal(directAsset.modality,'IMAGE');assert.equal(await db.asset.count({where:{datasetId:dataset.id}}),1);
    const {Client:StorageClient}=createRequire(root+'/apps/worker/package.json')('minio');const endpoint=new URL(environment.MINIO_ENDPOINT);
    const directStorage=new StorageClient({endPoint:endpoint.hostname,port:Number(endpoint.port),useSSL:false,accessKey:environment.MINIO_ACCESS_KEY,secretKey:environment.MINIO_SECRET_KEY});
    assert.equal((await directStorage.statObject(environment.MINIO_BUCKET,directAsset.storageKey)).size,png.length,'conflict cleanup must preserve published media');
    const wrong=(await request('/api/assets/presigned-upload',{datasetId:dataset.id,filename:'wrong.txt',contentType:'text/plain',sizeBytes:text.length},201)).data;
    await upload(wrong,text,'text/plain');
    const rejected=await request('/api/assets/complete-upload',{fileId:wrong.fileId},409);assert.equal(rejected.json.error.code,'ASSET_MODALITY_MISMATCH');
    assert.equal(await db.asset.count({where:{datasetId:dataset.id}}),1);
    results.push({name:'direct-upload-storage-publication-replay-mismatch',pass:true});

    for(const name of ['success','partial','zero','downloadfail']) {
      // Separate synthetic import scenarios without changing production rate limits.
      owner=await db.user.create({data:{email:`g4-repository-${randomUUID()}@fixture.test`,role:'MANAGER',passwordHash:owner.passwordHash}});
      const repositoryLogin=await request('/api/auth/login',{email:owner.email,password});
      cookie=repositoryLogin.response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
      const body={provider:'GITEA',modality:'IMAGE',repository:{owner:'fixture',name,ref:'main',expectedVisibility:'PUBLIC'},credentialMode:'PUBLIC',serverUrl:provider,datasetName:`G4 repository ${name}`,idempotencyKey:randomUUID()};
      const [accepted,repeated]=await Promise.all([request('/api/datasets/from-repository',body,[200,202]),request('/api/datasets/from-repository',body,[200,202])]);
      assert.equal(accepted.data.dataset.id,repeated.data.dataset.id);
      const jobId=accepted.data.job.id;
      const job=await until(async()=>{const j=await db.job.findUniqueOrThrow({where:{id:jobId}});return ['COMPLETED','FAILED'].includes(j.status)?j:null;},'repository worker completion');
      const status=name==='success'?'COMPLETED':'FAILED';assert.equal(job.status,status);
      const noPublication=['zero','downloadfail'].includes(name);
      const expected={outcome:name==='success'?'completed':'incomplete',accepted:noPublication?0:1,unchanged:0,rejected:['partial','zero'].includes(name)?1:0,retryable:name==='downloadfail'?1:0,unprocessed:0,skipped:0,...(name==='success'?{resultCount:1}:{})};
      const firstTerminal=await jobEvidence(jobId,status);assert.equal(firstTerminal.stage,'FINISHED');assert.deepEqual(firstTerminal.summary,expected);
      assert.deepEqual([firstTerminal.totalItems,firstTerminal.processedItems,firstTerminal.successItems,firstTerminal.failedItems,firstTerminal.skippedItems],[name==='partial'?2:1,name==='partial'?2:1,noPublication?0:1,name==='success'?0:1,0]);
      assert.equal(firstTerminal.errorCode,name==='success'?null:'IMPORT_INCOMPLETE');
      const assets=await db.asset.findMany({where:{datasetId:accepted.data.dataset.id}});assert.equal(assets.length,noPublication?0:1);
      const {Client}=createRequire(root+'/apps/worker/package.json')('minio');
      const storage=new URL(environment.MINIO_ENDPOINT);
      const minio=new Client({endPoint:storage.hostname,port:Number(storage.port),useSSL:false,accessKey:environment.MINIO_ACCESS_KEY,secretKey:environment.MINIO_SECRET_KEY});
      if(assets.length){assert.equal(assets[0].modality,'IMAGE');assert.ok(assets[0].storageKey);assert.equal((await minio.statObject(environment.MINIO_BUCKET,assets[0].storageKey)).size,png.length);}
      // The durable worker sees duplicate transport delivery, not another Dataset.
      const {Queue}=createRequire(root+'/apps/worker/package.json')('bullmq');const queue=new Queue('fieldframe-jobs',{connection:{host:environment.REDIS_HOST,port:Number(environment.REDIS_PORT),password:environment.REDIS_PASSWORD},prefix:environment.BULLMQ_PREFIX});
      const skippedBefore=await db.jobEvent.count({where:{jobId,message:'QUEUE_SKIPPED'}});
      try {await queue.add('duplicate',{jobId},{jobId:'duplicate-'+randomUUID()});}finally{await queue.close();}
      await until(async()=>await db.jobEvent.count({where:{jobId,message:'QUEUE_SKIPPED'}})>skippedBefore,'duplicate transport observed by worker');
      assert.equal(await db.asset.count({where:{datasetId:accepted.data.dataset.id}}),assets.length);
      const afterReplay=await jobEvidence(jobId,status);assert.deepEqual(afterReplay,firstTerminal,'duplicate delivery cannot add progress or terminal events');
      results.push({name:`repository-${name}-provider-storage-worker-replay`,pass:true,terminal:firstTerminal,replay:{duplicateTerminalEvents:0,duplicateProgressEvents:0,assetCount:assets.length,queueSkippedObserved:true}});
      if(name==='partial') {
        const controlled=await fetch(provider+'/_control/partial',{method:'POST',headers:{'Content-Type':'application/json','x-runtime-owner':runtime.id},body:JSON.stringify({onlyImage:true})});assert.ok(controlled.ok);
        const successor=(await request(`/api/jobs/${jobId}/retry`,{},201)).data;
        const retryReplay=(await request(`/api/jobs/${jobId}/retry`,{},200)).data;assert.equal(successor.id,retryReplay.id);
        const retry=await until(async()=>{const j=await db.job.findUniqueOrThrow({where:{id:successor.id}});return ['FAILED','COMPLETED'].includes(j.status)?j:null;},'repository retry');
        assert.equal(retry.status,'COMPLETED');assert.equal(retry.summary.unchanged,1);
        const retryTerminal=await jobEvidence(successor.id,'COMPLETED');
        assert.deepEqual(retryTerminal.summary,{outcome:'completed',resultCount:1,accepted:0,unchanged:1,rejected:0,retryable:0,unprocessed:0,skipped:0});
        assert.equal((await db.asset.findFirstOrThrow({where:{datasetId:accepted.data.dataset.id}})).id,assets[0].id);
        results.push({name:'repository-retry-successor-stable-existing-publication',pass:true,terminal:retryTerminal,predecessorUnchanged:await jobEvidence(jobId,'FAILED')});
        const changed=await fetch(provider+'/_control/partial',{method:'POST',headers:{'Content-Type':'application/json','x-runtime-owner':runtime.id},body:JSON.stringify({onlyImage:true,conflict:true})});assert.ok(changed.ok);
        // A synthetic failed predecessor drives the real authorized retry/API/worker path
        // against the same fixture Dataset and immutable previously published Asset.
        const failed=await db.job.create({data:{datasetId:retry.datasetId,createdById:owner.id,type:'IMPORT_DATASET',status:'FAILED',input:retry.input,sourceConnectionId:retry.sourceConnectionId}});
        const conflict=(await request(`/api/jobs/${failed.id}/retry`,{},201)).data;
        const terminal=await until(async()=>{const j=await db.job.findUniqueOrThrow({where:{id:conflict.id}});return ['FAILED','COMPLETED'].includes(j.status)?j:null;},'repository identity conflict');
        assert.equal(terminal.status,'FAILED');
        assert.equal((await db.asset.findFirstOrThrow({where:{datasetId:retry.datasetId}})).id,assets[0].id);
        assert.equal(await db.asset.count({where:{datasetId:retry.datasetId}}),1);
        results.push({name:'repository-identity-conflict-preserves-published-asset',pass:true,terminal:await jobEvidence(conflict.id,'FAILED')});
      }
    }
    if(runtime.checkpoint==='G5') {
      const {g5History}=await import('../../apps/web/tests/workspace/g5-fixtures.ts');
      const g5Owner=await db.user.update({where:{id:g5History.owner},data:{passwordHash:owner.passwordHash}});
      const ownerLogin=await request('/api/auth/login',{email:g5Owner.email,password});
      cookie=ownerLogin.response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
      const ownerCookie=cookie;
      async function html(path,status=200) {
        await verify(runtime.baseReceipt,'test');Object.assign(process.env,environment);authority.ports();
        const response=await fetch(base+path,{redirect:'manual',signal:AbortSignal.timeout(60000),headers:{Accept:'text/html',...(cookie?{Cookie:cookie}:{})}});
        const text=await response.text();assert.ok((Array.isArray(status)?status:[status]).includes(response.status),`${path}: HTTP ${response.status}`);
        return {response,text};
      }
      function engine(htmlValue,modality) {
        assert.ok(htmlValue.includes(`data-workspace-engine="${modality}"`),`authorized ${modality} engine absent`);
        for(const other of ['IMAGE','VIDEO','AUDIO','TEXT'].filter(value=>value!==modality))assert.ok(!htmlValue.includes(`data-workspace-engine="${other}"`),'alternate engine cannot mount');
        assert.ok(!htmlValue.includes('data-workspace-unresolved='));
      }
      const resolved=[];
      for(const modality of ['IMAGE','VIDEO','AUDIO','TEXT']) {
        const dataset=(await request('/api/datasets',{name:`G5 empty ${modality}`,modality},201)).data;
        const beforeLabels=await db.label.count({where:{datasetId:dataset.id}});
        const page=await html(`/workspace/${dataset.id}?filterModality=TEXT`);
        engine(page.text,modality);
        assert.equal(await db.asset.count({where:{datasetId:dataset.id}}),0);
        assert.equal(await db.label.count({where:{datasetId:dataset.id}}),beforeLabels,'workspace GET must not seed a default image taxonomy');
        const state=(await request(`/api/datasets/${dataset.id}/workspace-state`,undefined,200,'GET')).data;
        assert.deepEqual(state,{id:dataset.id,name:dataset.name,modality,modalityResolution:'RESOLVED',canResolve:false});
        resolved.push(dataset);
        results.push({name:`g5-empty-resolved-${modality.toLowerCase()}-http-dataset-engine`,pass:true,datasetId:dataset.id,state});
      }
      const ownImage=await db.asset.create({data:{datasetId:resolved[0].id,modality:'IMAGE',filename:'g5-selected-image.png',mimeType:'image/png',sourceFingerprint:'g5-http:'+randomUUID(),width:1,height:1,imageAsset:{create:{}}}});
      const misleading=await html(`/workspace/${resolved[0].id}?video=${ownImage.id}`);engine(misleading.text,'IMAGE');
      const foreign=await db.asset.create({data:{datasetId:resolved[3].id,modality:'TEXT',filename:'g5-foreign-text.txt',mimeType:'text/plain',sourceFingerprint:'g5-http:'+randomUUID(),textAsset:{create:{}}}});
      const wrongDataset=await html(`/workspace/${resolved[0].id}?text=${foreign.id}`,404);assert.ok(!wrongDataset.text.includes('data-workspace-engine='));
      const wrongSelection=await html(`/workspace/${resolved[0].id}?image=${randomUUID()}`,404);assert.ok(!wrongSelection.text.includes('data-workspace-engine='));
      results.push({name:'g5-query-selection-cannot-override-dataset-engine-or-cross-dataset',pass:true,datasetId:resolved[0].id});
      for(const [datasetId,state,assetId]of [[g5History.empty,'EMPTY_UNRESOLVED',randomUUID()],[g5History.mixed,'MIXED_UNRESOLVED',g5History.mixedImage],[g5History.single,'SINGLE_UNRESOLVED',g5History.singleImage]]) {
        const before=await db.dataset.findUniqueOrThrow({where:{id:datasetId},select:{modality:true,modalityContentRevision:true,modalityResolvedAt:true,modalityResolverSubject:true}});
        const page=await html(`/workspace/${datasetId}?image=${assetId}`);
        assert.ok(page.text.includes(`data-workspace-unresolved="${state}"`));assert.ok(!page.text.includes('data-workspace-engine='));
        assert.equal(page.text.includes('aria-label="Resolve empty dataset modality"'),state==='EMPTY_UNRESOLVED');
        const api=await request(`/api/datasets/${datasetId}/workspace-state`,undefined,409,'GET');
        assert.equal(api.json.error.code,'DATASET_MODALITY_UNRESOLVED');
        const projection=api.json.error.details.dataset;assert.equal(projection.modality,null);assert.equal(projection.modalityResolution,state);assert.equal(projection.canResolve,state==='EMPTY_UNRESOLVED');
        assert.deepEqual(Object.keys(projection).sort(),['id','name','modality','modalityResolution','canResolve'].sort());
        assert.deepEqual(await db.dataset.findUniqueOrThrow({where:{id:datasetId},select:{modality:true,modalityContentRevision:true,modalityResolvedAt:true,modalityResolverSubject:true}}),before,'unresolved workspace reads must not resolve or change historical receipt/fence');
        results.push({name:`g5-${state.toLowerCase()}-http-ui-api-no-engine`,pass:true,datasetId,state:projection});
      }
      const manager=await db.user.update({where:{id:g5History.manager},data:{passwordHash:g5Owner.passwordHash}});
      const managerLogin=await request('/api/auth/login',{email:manager.email,password});cookie=managerLogin.response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
      const managerCookie=cookie;
      const managerPage=await html(`/workspace/${g5History.ownerResolution}`);assert.ok(!managerPage.text.includes('aria-label="Resolve empty dataset modality"'));
      const denied=await request(`/api/datasets/${g5History.ownerResolution}/modality-resolution`,{modality:'IMAGE'},403);assert.equal(denied.json.error.code,'FORBIDDEN');
      assert.equal((await db.dataset.findUniqueOrThrow({where:{id:g5History.ownerResolution}})).modality,null);
      cookie=ownerCookie;
      for(const datasetId of [g5History.mixed,g5History.single]) {
        const before=await db.dataset.findUniqueOrThrow({where:{id:datasetId}});
        const nonEmpty=await request(`/api/datasets/${datasetId}/modality-resolution`,{modality:'IMAGE'},409);assert.equal(nonEmpty.json.error.code,'DATASET_NOT_EMPTY');
        assert.deepEqual(await db.dataset.findUniqueOrThrow({where:{id:datasetId}}),before,'rejected non-EMPTY resolution must roll back fence');
      }
      const beforeResolve=await html(`/workspace/${g5History.ownerResolution}`);assert.ok(beforeResolve.text.includes('data-workspace-unresolved="EMPTY_UNRESOLVED"'));
      const resolution=await request(`/api/datasets/${g5History.ownerResolution}/modality-resolution`,{modality:'VIDEO'});
      assert.deepEqual(Object.keys(resolution.data).sort(),['id','modality','modalityResolution','resolvedAt'].sort());
      const receipt=await db.dataset.findUniqueOrThrow({where:{id:g5History.ownerResolution},select:{modality:true,modalityResolverSubject:true,modalityResolvedAt:true,modalityContentRevision:true}});
      assert.equal(receipt.modality,'VIDEO');assert.equal(receipt.modalityResolverSubject,g5Owner.id);
      const repeatedResolution=await request(`/api/datasets/${g5History.ownerResolution}/modality-resolution`,{modality:'VIDEO'});assert.deepEqual(repeatedResolution.data,resolution.data);
      assert.deepEqual(await db.dataset.findUniqueOrThrow({where:{id:g5History.ownerResolution},select:{modality:true,modalityResolverSubject:true,modalityResolvedAt:true,modalityContentRevision:true}}),receipt,'same-value resolution replay keeps original receipt/fence');
      const immutable=await request(`/api/datasets/${g5History.ownerResolution}/modality-resolution`,{modality:'TEXT'},409);assert.equal(immutable.json.error.code,'DATASET_MODALITY_IMMUTABLE');
      const refreshed=await html(`/workspace/${g5History.ownerResolution}`);engine(refreshed.text,'VIDEO');
      const refreshedState=(await request(`/api/datasets/${g5History.ownerResolution}/workspace-state`,undefined,200,'GET')).data;assert.equal(refreshedState.modality,'VIDEO');assert.equal(refreshedState.modalityResolution,'RESOLVED');
      results.push({name:'g5-explicit-owner-empty-resolution-server-refresh-immutable-replay',pass:true,receipt:{id:g5History.ownerResolution,modality:receipt.modality,resolvedAt:receipt.modalityResolvedAt.toISOString()},managerDenied:true});
      const admin=await db.user.create({data:{email:`g5-admin-${randomUUID()}@fixture.test`,role:'ADMIN',passwordHash:g5Owner.passwordHash}});
      const adminLogin=await request('/api/auth/login',{email:admin.email,password});cookie=adminLogin.response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
      const adminResolution=await request(`/api/datasets/${g5History.adminResolution}/modality-resolution`,{modality:'AUDIO'});assert.equal(adminResolution.data.modality,'AUDIO');
      assert.equal((await db.dataset.findUniqueOrThrow({where:{id:g5History.adminResolution}})).modalityResolverSubject,admin.id);
      engine((await html(`/workspace/${g5History.adminResolution}`)).text,'AUDIO');
      const outsider=await db.user.create({data:{email:`g5-outsider-${randomUUID()}@fixture.test`,role:'LABELER',passwordHash:g5Owner.passwordHash}});
      const outsiderLogin=await request('/api/auth/login',{email:outsider.email,password});cookie=outsiderLogin.response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
      await request(`/api/datasets/${resolved[0].id}/workspace-state`,undefined,404,'GET');
      assert.ok(!(await html(`/workspace/${resolved[0].id}`,404)).text.includes('data-workspace-engine='));
      cookie=undefined;await request(`/api/datasets/${resolved[0].id}/workspace-state`,undefined,401,'GET');
      const noAuth=await html(`/workspace/${resolved[0].id}`,[302,307,401,404]);assert.ok(!noAuth.text.includes('data-workspace-engine='));
      cookie=ownerCookie;
      assert.ok(browser,'G5 requires the receipt-owned native browser');
      // The browser exercises real source-backed IMAGE and TEXT content. These
      // fixtures are confined to the already verified disposable allocation.
      const emptyResolved=[];
      for(const modality of ['IMAGE','VIDEO','AUDIO','TEXT']) emptyResolved.push((await request('/api/datasets',{name:`G5 browser empty ${modality}`,modality},201)).data);
      const browserImageBytes=readFileSync(root+'/apps/web/tests/fixtures/visualization.png');
      const imageIds=[];
      for(const suffix of ['a','b']) {
        const capability=(await request('/api/assets/presigned-upload',{datasetId:resolved[0].id,filename:`browser-${suffix}.png`,contentType:'image/png',sizeBytes:browserImageBytes.length},201)).data;
        await upload(capability,browserImageBytes,'image/png');
        const asset=(await request('/api/assets/complete-upload',{fileId:capability.fileId},201)).data.asset;
        imageIds.push(asset.id);
      }
      const browserLabel=(await request(`/api/datasets/${resolved[0].id}/labels`,{name:'Browser fixture class',color:'#0EA5E9',description:'',hotkey:''},201)).data;
      const annotationId=randomUUID();
      await request(`/api/assets/${imageIds[0]}/annotations`,{creates:[{id:annotationId,labelId:browserLabel.id,type:'BOUNDING_BOX',geometry:{x:0.1,y:0.1,width:0.3,height:0.3}}]},200,'PUT');
      resolved[0].assets=imageIds;resolved[0].imageLabelId=browserLabel.id;resolved[0].annotationId=annotationId;resolved[0].width=200;resolved[0].height=100;
      for(const modality of ['VIDEO','AUDIO']) {
        const target=resolved.find(value=>value.modality===modality);
        const asset=await db.asset.create({data:{datasetId:target.id,modality,filename:`browser-${modality.toLowerCase()}.${modality==='VIDEO'?'mp4':'wav'}`,mimeType:modality==='VIDEO'?'video/mp4':'audio/wav',sourceFingerprint:'g5-browser:'+randomUUID(),...(modality==='VIDEO'?{videoAsset:{create:{}}}:{audioAsset:{create:{}}})}});
        target.assets=[asset.id];
      }
      const browserText='OpenAI builds AI.';
      const browserTextBytes=Buffer.from(browserText,'utf8');
      const textKey=`g5-browser/${runtime.id}/source.txt`,boundaryKey=`g5-browser/${runtime.id}/boundaries.json`;
      const sourceIdentity='sha256:'+createHash('sha256').update(browserTextBytes).digest('hex');
      const boundaryProfile={schemaVersion:1,algorithm:'EXTENDED_GRAPHEME_CLUSTER',nodeVersion:process.versions.node,icuVersion:process.versions.icu??'unknown',unicodeVersion:process.versions.unicode??'unknown'};
      const boundaryBytes=Buffer.from(JSON.stringify({schemaVersion:1,profile:boundaryProfile,sourceIdentity,offsetUnit:'UTF16_CODE_UNIT',sourceCodeUnitLength:browserText.length,boundaryOffsets:Array.from({length:browserText.length+1},(_,index)=>index)}));
      await directStorage.putObject(environment.MINIO_BUCKET,textKey,browserTextBytes,browserTextBytes.length,{'Content-Type':'text/plain'});
      await directStorage.putObject(environment.MINIO_BUCKET,boundaryKey,boundaryBytes,boundaryBytes.length,{'Content-Type':'application/json'});
      const textFingerprint='g5-browser:'+randomUUID();
      const browserTextAsset=await db.asset.create({data:{datasetId:resolved[3].id,modality:'TEXT',filename:'browser-source.txt',mimeType:'text/plain',storageProvider:'MINIO',storageBucket:environment.MINIO_BUCKET,storageKey:textKey,sourceFingerprint:textFingerprint,textAsset:{create:{sourceIdentity,sourceEncoding:'UTF8',offsetUnit:'UTF16_CODE_UNIT',sourceByteLength:browserTextBytes.length,sourceCodeUnitLength:browserText.length,boundaryArtifactKey:boundaryKey,boundaryArtifactDigest:'sha256:'+createHash('sha256').update(boundaryBytes).digest('hex'),boundaryProfile,preparedSourceFingerprint:textFingerprint,preparedAt:new Date()}}}});
      resolved[3].assets=[browserTextAsset.id];
      await request(`/api/datasets/${resolved[3].id}/labels`,{name:'Browser entity',color:'#0EA5E9',description:'',hotkey:'',textEligibility:'ENTITY'},201);
      const {runBrowserChecks}=await import('./g5-browser-tests.mjs');
      await runBrowserChecks({browser,base,cookie:ownerCookie,fixtures:{resolved,emptyResolved,history:g5History,managerCookie,managerDeniedDataset:g5History.empty},results,request,db,upload});
      await db.dataset.update({where:{id:resolved[3].id},data:{archivedAt:new Date()}});
      await request(`/api/datasets/${resolved[3].id}/workspace-state`,undefined,404,'GET');
      assert.ok(!(await html(`/workspace/${resolved[3].id}`,404)).text.includes('data-workspace-engine='));
      results.push({name:'g5-admin-resolution-authorization-unavailable-page-no-engine',pass:true,adminDatasetId:g5History.adminResolution});
    }
    return results;
  } finally {
    // Only fixtures owned by the current synthetic actor; container teardown is authoritative.
    await db.$disconnect();
  }
}
