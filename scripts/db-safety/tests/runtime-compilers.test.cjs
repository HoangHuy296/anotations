// Pure filesystem/identity regressions: no database, provider or application process.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const { Worker }=require('node:worker_threads');
const a=require('../runtime-authority.cjs'),compiler=require('../runtime-compilers.cjs');
function fixture() {
  const dir=fs.mkdtempSync('/tmp/g1-compiler-claim-unit-');
  const entry=path.join(dir,'bootstrap'),module=path.join(dir,'module');fs.writeFileSync(entry,'fixture');fs.writeFileSync(module,'fixture');
  const child=a.identity(process.pid),parent=a.identity(child.parent),owner=a.identity(parent.parent),token=crypto.randomUUID();
  const r={id:crypto.randomUUID(),ledger:dir,owner,project:dir,compiler:{entry,entryHash:a.hash(fs.readFileSync(entry)),module,moduleHash:a.hash(fs.readFileSync(module)),distDir:path.join(dir,'apps/web/.next/dev')}};
  const original={runtime:r.id,token,parent,entry,entryHash:r.compiler.entryHash};
  const claimPath=path.join(dir,`compiler-${token}.json`),stateDir=path.join(dir,`compiler-${token}.state`);
  fs.mkdirSync(stateDir,{mode:0o700});fs.writeFileSync(claimPath,JSON.stringify(original));
  fs.writeFileSync(path.join(dir,'web.json'),JSON.stringify({...parent,runtime:r.id}));
  const fact=(key,value,writer)=>key==='verified'
    ? {runtime:r.id,token,key,value,subject:child,entryHash:r.compiler.entryHash,moduleHash:r.compiler.moduleHash}
    : {runtime:r.id,token,key,value,writer};
  const write=(key,value,writer)=>fs.writeFileSync(path.join(stateDir,`${key}.json`),JSON.stringify(fact(key,value,writer)));
  write('observed',child,parent);
  return {dir,r,original,child,parent,token,claimPath,stateDir,fact,write};
}
test('compiler claims reject unrelated, stale, ambiguous and reused process identities',()=>{
  const f=fixture(),previous=process.env.G1_COMPILER_CLAIM;
  try {
    process.env.G1_COMPILER_CLAIM=f.token;
    assert.equal(compiler.validateChild(f.r,f.child).token,f.token);
    fs.writeFileSync(f.claimPath,JSON.stringify({...f.original,runtime:crypto.randomUUID()}));assert.throws(()=>compiler.validateChild(f.r,f.child),/RUNTIME_COMPILER_CLAIM_MISMATCH/);
    fs.writeFileSync(f.claimPath,JSON.stringify(f.original));fs.unlinkSync(path.join(f.stateDir,'observed.json'));assert.throws(()=>compiler.validateChild(f.r,f.child),/RUNTIME_COMPILER_IDENTITY_MISMATCH/);
    f.write('observed',{...f.child,start:'reused'},f.parent);assert.throws(()=>compiler.validateChild(f.r,f.child),/RUNTIME_COMPILER_IDENTITY_MISMATCH/);
    f.write('observed',f.child,f.parent);fs.writeFileSync(f.claimPath,JSON.stringify({...f.original,parent:{...f.parent,pid:f.r.owner.pid}}));assert.throws(()=>compiler.validateChild(f.r,f.child),/RUNTIME_COMPILER_STATE_OWNER_MISMATCH/);
    fs.writeFileSync(f.claimPath,JSON.stringify(f.original));fs.writeFileSync(path.join(f.dir,'web.json'),JSON.stringify({...f.parent,start:'other-run',runtime:f.r.id}));assert.throws(()=>compiler.validateChild(f.r,f.child),/RUNTIME_COMPILER_ANCESTRY_MISMATCH/);
    fs.unlinkSync(f.claimPath);assert.throws(()=>compiler.validateChild(f.r,f.child),/ENOENT/);
    process.env.G1_COMPILER_CLAIM='ambiguous';assert.throws(()=>compiler.validateChild(f.r,f.child),/RUNTIME_COMPILER_CLAIM_REQUIRED/);
  } finally {if(previous===undefined)delete process.env.G1_COMPILER_CLAIM;else process.env.G1_COMPILER_CLAIM=previous;fs.rmSync(f.dir,{recursive:true});}
});
test('atomic immutable state facts preserve concurrent parent/checker/compiler updates',async()=>{
  const f=fixture();
  try {
    const definitions=[['verified',true,{pid:123,parent:f.child.pid,start:'checker',uid:f.child.uid}],['initialized',true,f.parent],['moduleLoaded',true,f.child],['exited',{code:0,signal:null},f.parent]];
    // Two distinct checker invocations race on exactly the same stable proof.
    const publications=[...definitions,definitions[0]];
    const workers=publications.map(([key,value,writer])=>new Worker(`const {workerData}=require('node:worker_threads');require(workerData.module).publishOnce(workerData.file,workerData.fact);`,{eval:true,workerData:{module:require.resolve('../runtime-compilers.cjs'),file:path.join(f.stateDir,`${key}.json`),fact:f.fact(key,value,writer)}}));
    let running=true,reads=0;
    const reader=(async()=>{while(running){compiler.claim(f.r,f.token);reads++;await new Promise(resolve=>setTimeout(resolve,1));}})();
    await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('exit',code=>code===0?resolve():reject(Error(`worker exit ${code}`)));})));
    running=false;await reader;
    const c=compiler.claim(f.r,f.token).c;
    assert.equal(c.verified,true);assert.equal(c.initialized,true);assert.equal(c.moduleLoaded,true);assert.deepEqual(c.exited,{code:0,signal:null});assert.ok(reads>0);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.claimPath,'utf8')),f.original,'immutable claim is never rewritten');
    for(const [key,value,writer] of definitions)compiler.publishOnce(path.join(f.stateDir,`${key}.json`),f.fact(key,value,writer));
    assert.throws(()=>compiler.publishOnce(path.join(f.stateDir,'initialized.json'),f.fact('initialized',false,f.parent)),/RUNTIME_COMPILER_STATE_CONFLICT/);
    assert.equal(fs.readdirSync(f.stateDir).filter(name=>name.endsWith('.pending')).length,0);
    f.write('moduleLoaded',true,f.parent);assert.throws(()=>compiler.claim(f.r,f.token),/RUNTIME_COMPILER_STATE_OWNER_MISMATCH/);
  } finally {fs.rmSync(f.dir,{recursive:true});}
});
test('static-paths IPC constrains build directory, route paths and cache module loading',()=>{
  const f=fixture();
  try {
    const project=path.join(f.r.project,'apps/web');fs.mkdirSync(project,{recursive:true});
    const input={dir:project,distDir:f.r.compiler.distDir,pathname:'/datasets/[datasetId]',page:'/datasets/[datasetId]/page',cacheHandler:undefined,cacheHandlers:undefined};
    const call=(value)=>[1,0,'loadStaticPaths',[value]];
    assert.equal(compiler.ipc(f.r,[0,0,f.r.compiler.module,[]],false),true);
    assert.equal(compiler.ipc(f.r,call(input),true),true);
    assert.equal(compiler.ipc(f.r,call({...input,cacheHandlers:{}}),true),true);
    assert.equal(compiler.ipc(f.r,call({...input,cacheHandlers:{default:undefined,remote:undefined,static:undefined}}),true),true);
    assert.equal(compiler.ipc(f.r,[2],true),true);
    assert.equal(compiler.ipc(f.r,[2,false],true),true);
    for(const value of [{...input,dir:f.dir},{...input,distDir:'/tmp/ambient-next'},{...input,distDir:path.join(project,'../.next')},{...input,distDir:path.join(project,'.next')},{...input,pathname:'/../../ambient'},{...input,page:'/api/../ambient'}])assert.throws(()=>compiler.ipc(f.r,call(value),true),/RUNTIME_COMPILER_PATH_DENIED/);
    for(const value of [{...input,cacheHandler:'/tmp/ambient.cjs'},{...input,cacheHandlers:{remote:'/tmp/ambient.cjs'}},{...input,cacheHandlers:{default:undefined,remote:'/tmp/ambient.cjs',static:undefined}},{...input,cacheHandlers:{default:undefined,remote:undefined,static:undefined,custom:undefined}},{...input,cacheHandlers:{default:undefined,remote:undefined}},{...input,cacheHandlers:{default:undefined,remote:null,static:undefined}},{...input,cacheHandlers:Object.assign(Object.create(null),{default:undefined,remote:undefined,static:undefined})}])assert.throws(()=>compiler.ipc(f.r,call(value),true),/RUNTIME_COMPILER_CACHE_HANDLER_DENIED/);
    assert.throws(()=>compiler.ipc(f.r,[1,0,'anything',[input]],true),/RUNTIME_COMPILER_CALL_DENIED/);
    assert.throws(()=>compiler.ipc(f.r,[1,0,'loadStaticPaths',[input,input]],true),/RUNTIME_COMPILER_CALL_DENIED/);
    let getterCalled=false;const getterHandlers={remote:undefined,static:undefined};Object.defineProperty(getterHandlers,'default',{enumerable:true,get(){getterCalled=true;return undefined;}});
    assert.throws(()=>compiler.ipc(f.r,call({...input,cacheHandlers:getterHandlers}),true),/RUNTIME_COMPILER_CACHE_HANDLER_DENIED/);assert.equal(getterCalled,false);
    const symbolHandlers={default:undefined,remote:undefined,static:undefined,[Symbol('extra')]:undefined};assert.throws(()=>compiler.ipc(f.r,call({...input,cacheHandlers:symbolHandlers}),true),/RUNTIME_COMPILER_CACHE_HANDLER_DENIED/);
    for(const message of [[2,'extra'],[2,true],[2,false,'extra']])assert.throws(()=>compiler.ipc(f.r,message,true),/RUNTIME_COMPILER_IPC_DENIED/);
    assert.throws(()=>compiler.ipc(f.r,call(input),false),/RUNTIME_COMPILER_IPC_DENIED/);
    fs.mkdirSync(path.dirname(input.distDir),{recursive:true});fs.symlinkSync(f.dir,input.distDir,'dir');assert.throws(()=>compiler.ipc(f.r,call(input),true),/RUNTIME_COMPILER_PATH_DENIED/);
  } finally {fs.rmSync(f.dir,{recursive:true});}
});

test('compiler startup handoff requires live verified identity and bounded proof',()=>{
  const f=fixture();
  try {
    assert.throws(()=>compiler.waitForVerified(f.r,f.token,f.child,20),/RUNTIME_COMPILER_STARTUP_TIMEOUT/);
    assert.equal(compiler.claim(f.r,f.token).c.verified,false,'timeout never manufactures verification');
    assert.throws(()=>compiler.waitForVerified(f.r,f.token,{...f.child,start:'reused'},20),/RUNTIME_COMPILER_STARTUP_IDENTITY_CHANGED/);
    assert.throws(()=>compiler.waitForVerified(f.r,f.token,{...f.child,pid:2147483647},20),/RUNTIME_COMPILER_STARTUP_EXITED/);
    assert.throws(()=>compiler.waitForVerified(f.r,f.token,f.child,30001),/RUNTIME_COMPILER_STARTUP_BOUND_DENIED/);
    f.write('verified',true);assert.equal(compiler.waitForVerified(f.r,f.token,f.child,20).verified,true);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.claimPath,'utf8')),f.original);
  } finally {fs.rmSync(f.dir,{recursive:true});}
});
