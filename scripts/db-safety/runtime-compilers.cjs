// Receipt-scoped interception of the exact Next dev static-paths worker transport.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const a = require('./runtime-authority.cjs');
const reject = code => { throw Error(code); };
const stateKeys = ['observed','verified','initialized','moduleLoaded','listenDenied','exited'];
function stateDirectory(r, token) { return path.join(r.ledger, `compiler-${token}.state`); }
// Publication uses an atomic hard link, never an overwrite/rename of shared state.
// Each fact is immutable and has one writer; identical duplicate publication is safe.
function publishOnce(file, value) {
  const bytes = JSON.stringify(value), temporary = `${file}.${process.pid}.${randomUUID()}.pending`;
  fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
  try {
    try { fs.linkSync(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST' || fs.readFileSync(file, 'utf8') !== bytes) reject('RUNTIME_COMPILER_STATE_CONFLICT');
    }
  } finally { fs.unlinkSync(temporary); }
}
function claim(r, token) {
  if (!/^[a-f0-9-]{36}$/.test(token || '')) reject('RUNTIME_COMPILER_CLAIM_REQUIRED');
  const p = path.join(r.ledger, `compiler-${token}.json`);
  const c = a.read(p);
  if (c.runtime !== r.id || c.token !== token || c.entry !== r.compiler.entry || c.entryHash !== r.compiler.entryHash) reject('RUNTIME_COMPILER_CLAIM_MISMATCH');
  if (a.hash(fs.readFileSync(c.entry)) !== c.entryHash || a.hash(fs.readFileSync(r.compiler.module)) !== r.compiler.moduleHash) reject('RUNTIME_COMPILER_SOURCE_CHANGED');
  const merged = { ...c, observed: null, verified: false, initialized: false, moduleLoaded: false, listenDenied: false, exited: null };
  for (const key of stateKeys) {
    const marker = path.join(stateDirectory(r,token),`${key}.json`);
    if (!fs.existsSync(marker)) continue;
    const fact = a.read(marker);
    if (fact.runtime !== r.id || fact.token !== token || fact.key !== key) reject('RUNTIME_COMPILER_STATE_MISMATCH');
    const parentOwned = ['observed','initialized','exited'].includes(key);
    if (parentOwned && (!fact.writer || !a.same(fact.writer,c.parent))) reject('RUNTIME_COMPILER_STATE_OWNER_MISMATCH');
    if (key === 'observed' && (!fact.value || fact.value.parent !== c.parent.pid || !Number.isInteger(fact.value.pid) || !fact.value.start)) reject('RUNTIME_COMPILER_STATE_MISMATCH');
    if (['verified','initialized','moduleLoaded','listenDenied'].includes(key) && fact.value !== true) reject('RUNTIME_COMPILER_STATE_MISMATCH');
    if (key === 'verified' && (!merged.observed || !fact.subject || !a.same(fact.subject,merged.observed) || fact.entryHash!==r.compiler.entryHash || fact.moduleHash!==r.compiler.moduleHash)) reject('RUNTIME_COMPILER_STATE_OWNER_MISMATCH');
    if (['moduleLoaded','listenDenied'].includes(key) && (!merged.observed || !fact.writer || !a.same(fact.writer,merged.observed))) reject('RUNTIME_COMPILER_STATE_OWNER_MISMATCH');
    if (key === 'exited' && (!fact.value || !(fact.value.code === null || Number.isInteger(fact.value.code)) || !(fact.value.signal === null || typeof fact.value.signal === 'string'))) reject('RUNTIME_COMPILER_STATE_MISMATCH');
    merged[key] = fact.value;
  }
  return { p, c: merged };
}
function recordState(r,token,key,value) {
  if (!stateKeys.includes(key)) reject('RUNTIME_COMPILER_STATE_DENIED');
  const {c}=claim(r,token),writer=a.identity(process.pid);
  if (['observed','initialized','exited'].includes(key)) {
    if (!a.same(writer,c.parent)) reject('RUNTIME_COMPILER_STATE_OWNER_MISMATCH');
  } else if (key==='verified') {
    if (!c.observed || writer.parent !== c.observed.pid || !a.same(a.identity(writer.parent),c.observed)) reject('RUNTIME_COMPILER_STATE_OWNER_MISMATCH');
  } else if (!c.observed || !a.same(writer,c.observed)) reject('RUNTIME_COMPILER_STATE_OWNER_MISMATCH');
  // Main-thread and tsx-loader startup checkers can run concurrently. Each must
  // prove its actual parent first; the immutable verification fact identifies the
  // checked child/source, not a transient checker PID, so identical proof coalesces.
  const fact=key==='verified'
    ? {runtime:r.id,token,key,subject:c.observed,entryHash:r.compiler.entryHash,moduleHash:r.compiler.moduleHash,value}
    : {runtime:r.id,token,key,writer,value};
  publishOnce(path.join(stateDirectory(r,token),`${key}.json`),fact);
}
function validateChild(r, child) {
  const { c } = claim(r, process.env.G1_COMPILER_CLAIM);
  if (!c.observed || !a.same(child,c.observed) || child.parent !== c.parent.pid) reject('RUNTIME_COMPILER_IDENTITY_MISMATCH');
  const web = a.read(path.join(r.ledger,'web.json'));
  if (web.runtime !== r.id || !a.same(web,c.parent) || !a.same(a.identity(web.pid),web) || web.parent !== r.owner.pid) reject('RUNTIME_COMPILER_ANCESTRY_MISMATCH');
  return c;
}
const startupSleep=new Int32Array(new SharedArrayBuffer(4));
function waitForVerified(r,token,observed,timeoutMs=15000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>30000) reject('RUNTIME_COMPILER_STARTUP_BOUND_DENIED');
  const deadline=performance.now()+timeoutMs;
  for (;;) {
    let actual;
    try {actual=a.identity(observed.pid);}
    catch(error) {if(error.code==='ENOENT') reject('RUNTIME_COMPILER_STARTUP_EXITED');throw error;}
    if (!a.same(actual,observed) || actual.parent!==observed.parent) reject('RUNTIME_COMPILER_STARTUP_IDENTITY_CHANGED');
    const state=fs.readFileSync(`/proc/${observed.pid}/stat`,'utf8').split(') ').at(-1).split(' ')[0];
    if (state==='Z' || state==='X') reject('RUNTIME_COMPILER_STARTUP_EXITED');
    const {c}=claim(r,token),web=a.read(path.join(r.ledger,'web.json'));
    if (!c.observed || !a.same(c.observed,observed) || actual.parent!==c.parent.pid || web.runtime!==r.id || !a.same(web,c.parent) || !a.same(a.identity(web.pid),web) || web.parent!==r.owner.pid) reject('RUNTIME_COMPILER_STARTUP_IDENTITY_CHANGED');
    if (c.verified) return c;
    if (performance.now()>=deadline) reject('RUNTIME_COMPILER_STARTUP_TIMEOUT');
    // The checker writes verification before the compiler bootstrap consumes IPC.
    // Holding the handle here keeps Next from ending/force-exiting an unverified
    // startup. This waits for actual proof, never for an assumed startup delay.
    Atomics.wait(startupSleep,0,0,Math.min(10,deadline-performance.now()));
  }
}
function routePath(value) {
  return typeof value==='string' && value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && !value.split('/').some(segment=>segment==='..'||segment==='.');
}
function canonicalCacheHandlers(value) {
  if (value == null) return true;
  if (Object.getPrototypeOf(value)!==Object.prototype) return false;
  const keys=Reflect.ownKeys(value);
  if (!keys.length) return true;
  // Pinned Next16's default config contains these three own properties with
  // undefined values. No path/module is authorized by that inert config shape.
  if (keys.length!==3 || !['default','remote','static'].every(key=>keys.includes(key))) return false;
  return keys.every(key=>{
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    return descriptor && Object.hasOwn(descriptor,'value') && descriptor.value===undefined;
  });
}
function staticPathsArguments(r, args) {
  if (!Array.isArray(args) || args.length!==1 || !args[0] || Object.getPrototypeOf(args[0])!==Object.prototype) reject('RUNTIME_COMPILER_CALL_DENIED');
  const input=args[0],project=path.join(r.project,'apps/web');
  // Pinned Next16 config appends /dev to its default .next development output.
  // The receipt records this exact path; no caller-selected build root is allowed.
  if (r.compiler.distDir!==path.join(project,'.next','dev') || input.dir!==project || input.distDir!==r.compiler.distDir) reject('RUNTIME_COMPILER_PATH_DENIED');
  // These values are module loaders in Next. This rehearsal authorizes no custom
  // cache module; a filesystem path received through IPC is not a new capability.
  if (input.cacheHandler!=null || !canonicalCacheHandlers(input.cacheHandlers)) reject('RUNTIME_COMPILER_CACHE_HANDLER_DENIED');
  if (!routePath(input.pathname) || (input.page!=null && !routePath(input.page))) reject('RUNTIME_COMPILER_PATH_DENIED');
  for (const directory of [project,path.join(project,'.next'),input.distDir]) {
    if (fs.existsSync(directory) && fs.realpathSync(directory)!==directory) reject('RUNTIME_COMPILER_PATH_DENIED');
  }
}
function ipc(r, message, initialized) {
  if (!Array.isArray(message)) reject('RUNTIME_COMPILER_IPC_DENIED');
  if (message[0] === 0) {
    if (message.length!==4 || initialized || message[2] !== r.compiler.module || !Array.isArray(message[3]) || message[3].length) reject('RUNTIME_COMPILER_MODULE_DENIED');
    return true;
  }
  if (!initialized || ![1,2].includes(message[0])) reject('RUNTIME_COMPILER_IPC_DENIED');
  if (message[0] === 1) {
    if(message.length!==4 || message[2] !== 'loadStaticPaths') reject('RUNTIME_COMPILER_CALL_DENIED');
    staticPathsArguments(r,message[3]);
  // The pinned jest-worker WorkerPool.end() sends [CHILD_MESSAGE_END,false].
  // The bootstrap also accepts the one-element tuple used by the safety fixture.
  } else if (!(message.length===1 || (message.length===2 && message[1]===false))) reject('RUNTIME_COMPILER_IPC_DENIED');
  return initialized;
}
function install() {
  const fork = cp.fork;
  cp.fork = function(entry, args, options) {
    const r=a.receipt();a.environment(r);
    if (process.env.G1_RUNTIME_ROLE !== 'web' || process.env.G1_COMPILER_CLAIM) reject('RUNTIME_COMPILER_PARENT_DENIED');
    const parent=a.identity(process.pid), web=a.read(path.join(r.ledger,'web.json'));
    if (!a.same(parent,web) || web.runtime!==r.id || parent.parent!==r.owner.pid) reject('RUNTIME_COMPILER_ANCESTRY_MISMATCH');
    if (entry !== r.compiler.entry || !Array.isArray(args) || args.length || options?.execPath && options.execPath!==process.execPath) reject('RUNTIME_COMPILER_ENTRY_DENIED');
    const env=options?.env || process.env;
    for(const [key,value] of Object.entries(a.environment(r))) if(env[key]!==value) reject('RUNTIME_COMPILER_ENVIRONMENT_MISMATCH');
    for(const key of ['DB_SAFETY_RECEIPT','G1_RUNTIME_RECEIPT','G1_RUNTIME_ROLE','NODE_OPTIONS']) if(env[key]!==process.env[key]) reject('RUNTIME_COMPILER_ENVIRONMENT_MISMATCH');
    if(options?.execArgv && JSON.stringify(options.execArgv)!==JSON.stringify(process.execArgv.filter(arg=>!arg.startsWith('--inspect')))) reject('RUNTIME_COMPILER_EXECARGS_DENIED');
    const token=randomUUID(),p=path.join(r.ledger,`compiler-${token}.json`);
    const record={runtime:r.id,token,parent,entry,entryHash:r.compiler.entryHash};
    fs.mkdirSync(stateDirectory(r,token),{mode:0o700});publishOnce(p,record);
    const child=fork.call(this,entry,args,{...options,env:{...env,G1_COMPILER_CLAIM:token}});
    const observed=a.identity(child.pid);recordState(r,token,'observed',observed);
    child.once('exit',(code,signal)=>recordState(r,token,'exited',{code,signal}));
    try {waitForVerified(r,token,observed);}
    catch(error) {
      // Only this independently observed child can be terminated on failed
      // startup. A changed/reused PID is never signaled, and no proof is invented.
      try {if(a.same(a.identity(observed.pid),observed)) child.kill('SIGTERM');}
      catch(cleanupError) {if(cleanupError.code!=='ENOENT') throw cleanupError;}
      throw error;
    }
    const send=child.send.bind(child);let initialized=false;
    child.send=function(message,...rest) {
      const next=ipc(r,message,initialized);
      if(next && !initialized) recordState(r,token,'initialized',true);
      initialized=next;
      return send(message,...rest);
    };
    return child;
  };
  if(process.env.G1_COMPILER_CLAIM) {
    // Do not install a message listener in a preload: that would drain Node's IPC
    // buffer before Next's bootstrap registers its own listener. Validate transport
    // at the owned parent, and independently gate the module when the child loads it.
    const r=a.receipt(),Module=require('node:module'),load=Module._load;
    Module._load=function(id,parent,isMain) {
      if(id===r.compiler.module) {
        const {c}=claim(r,process.env.G1_COMPILER_CLAIM);
        if(!c.verified || !c.initialized) reject('RUNTIME_COMPILER_MODULE_DENIED');
        validateChild(r,a.identity(process.pid));
        if(!c.moduleLoaded) recordState(r,process.env.G1_COMPILER_CLAIM,'moduleLoaded',true);
      }
      return load.call(this,id,parent,isMain);
    };
  }
}
module.exports={claim,validateChild,recordState,publishOnce,waitForVerified,ipc,staticPathsArguments,canonicalCacheHandlers,install};
