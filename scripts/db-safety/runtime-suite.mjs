// Test supervisor. It can issue only child receipts descended from its G1 receipt.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { verify, root, cleanEnv, registry, sha, walk, redact } from './guard.mjs';
const require = createRequire(import.meta.url);
const authority = require('./runtime-authority.cjs');
const compilerAuthority = require('./runtime-compilers.cjs');
const mode = process.argv[2];
assert.ok(['safety','e2e'].includes(mode));
const baseReceipt = process.env.DB_SAFETY_RECEIPT;
const checked = await verify(baseReceipt, 'test');
process.env.DATABASE_URL = checked.target.url.toString();
assert.ok(checked.r.command === `g4:runtime:${mode}` || (mode === 'e2e' && checked.r.command === 'g5:runtime:e2e'),'runtime command must be exact G4/G5 approved scope');
const privateRoot = mkdtempSync('/tmp/phase029-g1-runtime-');
const id = randomUUID();
const ledger = join(privateRoot,'processes'); mkdirSync(ledger,{mode:0o700});
const project = join(privateRoot,'project'); mkdirSync(project,{mode:0o700});
const children = [];
const rejectedCompilers = new Map();
let isolationFixture;
let browser;
const evidence = { mode, owner: authority.identity(process.pid), scenarios: [], processes: [], cleanup: null };
const artifact = process.env.G1_RUNTIME_EVIDENCE;
// This path is emitted by the parent capture, not accepted from application config.
assert.equal(artifact, undefined);
const roles = Object.fromEntries([['probe',null],['provider',55472],['web',55470],['worker',null],['legacy',null]].map(([role,port]) => [role,{port,entryHash:sha(readFileSync(join(root,'scripts/db-safety/runtime-child.mjs')))}]));
const config = join(privateRoot,'environment.json');
const environment = {
  ...checked.env, DATABASE_URL: checked.target.url.toString(), NODE_ENV:'development',
  MINIO_PUBLIC_ENDPOINT:checked.env.MINIO_ENDPOINT, MINIO_CORS_ALLOWED_ORIGIN:'http://127.0.0.1:55470',
  UPLOAD_CAPABILITY_SECRET:randomBytes(32).toString('hex'), SOURCE_CONNECTION_ENCRYPTION_KEY:randomBytes(32).toString('base64'),
  COOKIE_SECURE:'false', NEXT_TELEMETRY_DISABLED:'1',
  TSX_TSCONFIG_PATH:join(root,'apps/web/tsconfig.json'),
  REPOSITORY_PREFLIGHT_INTEGRATION_TESTS:'1', SOURCE_CONNECTION_TEST_MODE:'1', SOURCE_TRUSTED_TEST_HOSTS:'127.0.0.1',
  SOURCE_ALLOWED_IP_CIDRS:'127.0.0.1/32',
  GITEA_PUBLIC_URL:`http://127.0.0.1:${roles.provider.port}`,
};
writeFileSync(config,JSON.stringify(environment),{mode:0o600});
const runtimePath=join(privateRoot,'runtime.json');
let runtime;
let successful=false;
const registration=join(registry,`runtime-${id}.json`);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function emit() { console.log('G4_RUNTIME_RECEIPT',JSON.stringify(evidence)); }
async function launch(role, overrides={}) {
  // Recheck container/PG identity and the entire migration set before each child.
  await verify(baseReceipt,'test');
  Object.assign(process.env,environment);
  const childEnv={...cleanEnv(),...environment,DB_SAFETY_RECEIPT:baseReceipt,G1_RUNTIME_RECEIPT:runtimePath,G1_RUNTIME_ROLE:role,
    NODE_OPTIONS:`--require=${join(root,'scripts/db-safety/network-fence.cjs')}`, ...overrides};
  const child=spawn(process.execPath,['--import','tsx',join(root,'scripts/db-safety/runtime-child.mjs'),role],{cwd:root,env:childEnv,stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout.on('data',b=>{output+=b});child.stderr.on('data',b=>{output+=b});
  const done=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  // PID identity is captured immediately by the supervisor, independently of the child.
  const identity=authority.identity(child.pid); children.push({child,identity,role,done,output:()=>output});
  evidence.processes.push({...identity,role});
  return children.at(-1);
}
async function launchCompilerNegative(name, overrides={}, receiptVariant, earlyExit=false) {
  await verify(baseReceipt,'test');
  const token=randomUUID(),claimPath=join(ledger,`compiler-${token}.json`);
  const parent=authority.identity(process.pid);
  const usesClaim=!['missing-claim','unregistered-claim'].includes(name);
  if(usesClaim) {
    // Actual ancestry is recorded truthfully: this child belongs to the supervisor,
    // never to web. Startup must reject it rather than granting compiler allowance.
    const state=join(ledger,`compiler-${token}.state`);mkdirSync(state,{mode:0o700});
    compilerAuthority.publishOnce(claimPath,{runtime:id,token,parent,entry:runtime.compiler.entry,entryHash:runtime.compiler.entryHash});
  }
  const env={...cleanEnv(),...environment,DB_SAFETY_RECEIPT:baseReceipt,G1_RUNTIME_RECEIPT:receiptVariant||runtimePath,G1_RUNTIME_ROLE:'web',NODE_OPTIONS:`--require=${join(root,'scripts/db-safety/network-fence.cjs')}`,...(name==='missing-claim'?{}:{G1_COMPILER_CLAIM:token}),...overrides};
  const child=spawn(process.execPath,[runtime.compiler.entry],{cwd:root,env,stdio:['ignore','pipe','pipe','ipc']});
  let output='';child.stdout.on('data',b=>{output+=b});child.stderr.on('data',b=>{output+=b});
  const done=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  const identity=authority.identity(child.pid);
  const owned={child,identity,role:`compiler-negative-${name}`,done,output:()=>output};
  children.push(owned);evidence.processes.push({...identity,role:owned.role});
  if(usesClaim) {
    // A real supervisor-observed process identity, using the same immutable
    // fact publisher. The verifier decides rejection; verified remains false.
    compilerAuthority.recordState(runtime,token,'observed',identity);
    rejectedCompilers.set(token,{name,identity,parent,claimPath});
  }
  if(earlyExit) {
    assert.ok(authority.same(authority.identity(identity.pid),identity));
    child.kill('SIGTERM');
  }
  const result=await Promise.race([done,delay(20000).then(()=>null)]);
  assert.ok(result,`startup negative ${name} did not terminate`);
  assert.ok(!existsSync(`/proc/${identity.pid}`),'rejected compiler process survived');
  assert.ok(!output.includes('RUNTIME_COMPILER_VERIFIED'),'negative startup cannot verify');
  if(usesClaim) {
    assert.equal(compilerAuthority.claim(runtime,token).c.verified,false);
    compilerAuthority.recordState(runtime,token,'exited',result);
  }
  return {result,output,identity};
}
async function ready(child, marker) {
  for(let n=0;n<240;n++) {
    if(child.output().includes(marker))return;
    if(child.child.exitCode!==null || child.child.signalCode)throw Error(`RUNTIME_${child.role.toUpperCase()}_START_FAILED`);
    await delay(250);
  }
  throw Error('RUNTIME_READINESS_TIMEOUT');
}
function safeOutput(s) {
  s=redact(s);
  for(const value of Object.entries(environment).filter(([k])=>/SECRET|PASSWORD|KEY/.test(k)).map(([,v])=>v))s=s.split(value).join('[REDACTED]');
  return s;
}
try {
  // Private source snapshot has no .env or package scripts that source it.
  for(const part of ['apps/web/src','apps/web/public','apps/web/tsconfig.json','apps/web/next-env.d.ts','apps/web/package.json','apps/web/postcss.config.mjs','apps/web/next.config.ts','lib/generated/prisma','database-url.ts','packages/domain','packages/queue']) {
    const from=join(root,part); if(!existsSync(from))continue;
    cpSync(from,join(project,part),{recursive:true,filter:p=>!p.split('/').includes('node_modules') && !p.split('/').at(-1).startsWith('.env')});
  }
  symlinkSync(join(root,'node_modules'),join(project,'node_modules'),'dir');
  symlinkSync(join(root,'apps/web/node_modules'),join(project,'apps/web/node_modules'),'dir');
  const projectHashes=Object.fromEntries([...walk(project),...walk(join(root,'apps/worker/src')),...walk(join(root,'packages/domain/src')),...walk(join(root,'packages/queue/src'))].filter(p=>!p.split('/').includes('node_modules') && !p.endsWith('/next-env.d.ts')).map(p=>[p,sha(readFileSync(p))]));
  const nextRequire=createRequire(join(root,'apps/web/package.json'));
  const compilerEntry=realpathSync(nextRequire.resolve('next/dist/compiled/jest-worker/processChild.js'));
  const compilerModule=realpathSync(nextRequire.resolve('next/dist/server/dev/static-paths-worker.js'));
  runtime={id,mode,checkpoint:checked.r.command==='g5:runtime:e2e'?'G5':'G4',owner:authority.identity(process.pid),baseReceipt,expiresAt:checked.r.expiresAt,config,configHash:sha(readFileSync(config)),ledger,roles,project,projectHashes,compiler:{distDir:join(project,'apps/web/.next/dev'),entry:compilerEntry,entryHash:sha(readFileSync(compilerEntry)),module:compilerModule,moduleHash:sha(readFileSync(compilerModule))}};
  if(runtime.checkpoint==='G5') {
    const {prepareBrowser}=await import('./runtime-browser.mjs');
    runtime.browser=await prepareBrowser({runtime});
    evidence.browserOwnership=runtime.browser;
  }
  writeFileSync(runtimePath,JSON.stringify(runtime),{mode:0o400,flag:'wx'});
  writeFileSync(registration,JSON.stringify({path:runtimePath,hash:sha(readFileSync(runtimePath))}),{mode:0o400,flag:'wx'});
  Object.assign(process.env,environment,{G1_RUNTIME_RECEIPT:runtimePath});
  if(runtime.checkpoint==='G5') {
    const {browserContextNegatives}=await import('./runtime-browser.mjs');
    const since=new Date().toISOString();
    evidence.browserContextNegatives=await browserContextNegatives(runtime,environment);
    const diagnostics=spawnSync('docker',['logs','--since',since,checked.r.postgres.id],{env:cleanEnv(),encoding:'utf8',maxBuffer:4*1024*1024});
    assert.equal(diagnostics.status,0,'disposable PostgreSQL diagnostics must be available');
    const text=diagnostics.stdout+diagnostics.stderr;
    const connections=(text.match(/connection received:/g)||[]).length;
    const statements=(text.match(/(?:statement:|execute [^:]+:)/g)||[]).length;
    assert.equal(connections,0,'rejected browser contexts must not probe PostgreSQL');
    assert.equal(statements,0,'rejected browser contexts must not execute SQL');
    evidence.browserContextDiagnostics={since,connections,statements,sha256:sha(text)};
  }
  if(mode==='safety') {
    for(const [name,overrides,expected] of [
      ['missing-runtime',{G1_RUNTIME_RECEIPT:''},'RUNTIME_IDENTITY_REQUIRED'],
      ['conflicting-database',{DATABASE_URL:'postgresql://untrusted:fixture@127.0.0.1:5433/fieldframe'},'RUNTIME_ENVIRONMENT_MISMATCH'],
      ['ambient-minio',{MINIO_ENDPOINT:'http://127.0.0.1:9000'},'RUNTIME_ENVIRONMENT_MISMATCH'],
      ['wrong-redis',{REDIS_PORT:'6379'},'RUNTIME_ENVIRONMENT_MISMATCH'],
      ['ambient-provider',{GITEA_PUBLIC_URL:'http://127.0.0.1:3000'},'RUNTIME_ENVIRONMENT_MISMATCH'],
      ['missing-role',{G1_RUNTIME_ROLE:'unregistered'},'RUNTIME_ROLE_UNAPPROVED'],
    ]) {
      const child=await launch('probe',overrides); const exit=await child.done;
      assert.notEqual(exit.code,0);assert.ok(child.output().includes(expected),safeOutput(child.output()));
      assert.ok(!existsSync(join(ledger,'probe.json')));
      evidence.scenarios.push({name,pass:true,error:expected,processRegistered:false});
    }
    for(const [name,field,value,expected] of [
      ['stale-runtime','expiresAt','2000-01-01T00:00:00Z','RUNTIME_RECEIPT_STALE'],
      ['missing-owner','owner',null,'SAFETY_CONFIGURATION_OR_IO_FAILURE'],
    ]) {
      const altered=join(privateRoot,name+'.json');const fake={...runtime,id:randomUUID(),[field]:value};
      writeFileSync(altered,JSON.stringify(fake),{mode:0o400});
      const reg=join(registry,`runtime-${fake.id}.json`);writeFileSync(reg,JSON.stringify({path:altered,hash:sha(readFileSync(altered))}),{mode:0o400});
      try { const child=await launch('probe',{G1_RUNTIME_RECEIPT:altered});const exit=await child.done;assert.notEqual(exit.code,0);assert.ok(child.output().includes(expected),safeOutput(child.output()));evidence.scenarios.push({name,pass:true,error:expected}); }
      finally { rmSync(reg); }
    }
    const mismatched=join(privateRoot,'mismatched.json');
    writeFileSync(mismatched,JSON.stringify({...runtime,id:randomUUID()}),{mode:0o400});
    const mismatch=await launch('probe',{G1_RUNTIME_RECEIPT:mismatched});
    assert.notEqual((await mismatch.done).code,0);
    assert.ok(!existsSync(join(ledger,'probe.json')));
    evidence.scenarios.push({name:'unregistered-runtime-receipt',pass:true,processRegistered:false});
    const valid=await launch('probe');const exit=await valid.done;assert.equal(exit.code,0,safeOutput(valid.output()));assert.ok(valid.output().includes('RUNTIME_PROBE_READY'));
    evidence.scenarios.push({name:'verified-child',pass:true});
    const http=await launch('web');await ready(http,'RUNTIME_COMPILER_SAFETY_PASS');
    evidence.scenarios.push({name:'receipt-owned-short-lived-compiler-and-negative-ownership-config-ipc',pass:true});
    for(const [name,expected] of [['missing-claim','RUNTIME_ENTRY_UNAPPROVED'],['unregistered-claim','SAFETY_CONFIGURATION_OR_IO_FAILURE'],['mismatched-ancestry','RUNTIME_COMPILER_ANCESTRY_MISMATCH']]) {
      const negative=await launchCompilerNegative(name);
      assert.notEqual(negative.result.code,0);assert.ok(negative.output.includes(expected),safeOutput(negative.output));
      evidence.scenarios.push({name:`compiler-real-startup-${name}`,pass:true,error:expected,verified:false,process:negative.identity});
    }
    const stalePath=join(privateRoot,'stale-compiler-runtime.json'),stale={...runtime,id:randomUUID(),expiresAt:'2000-01-01T00:00:00Z'};
    writeFileSync(stalePath,JSON.stringify(stale),{mode:0o400});
    const staleRegistration=join(registry,`runtime-${stale.id}.json`);writeFileSync(staleRegistration,JSON.stringify({path:stalePath,hash:sha(readFileSync(stalePath))}),{mode:0o400});
    try {
      const negative=await launchCompilerNegative('stale-receipt',{},stalePath);
      assert.notEqual(negative.result.code,0);assert.ok(negative.output.includes('RUNTIME_RECEIPT_STALE'),safeOutput(negative.output));
      evidence.scenarios.push({name:'compiler-real-startup-stale-receipt',pass:true,error:'RUNTIME_RECEIPT_STALE',verified:false,process:negative.identity});
    } finally {rmSync(staleRegistration);}
    const early=await launchCompilerNegative('observed-unverified-early-exit',{},undefined,true);
    assert.equal(early.result.signal,'SIGTERM');
    evidence.scenarios.push({name:'compiler-observed-unverified-early-exit',pass:true,verified:false,process:early.identity});
    const unrelated=spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{cwd:privateRoot,env:cleanEnv(),stdio:'ignore'});
    const unrelatedDone=new Promise(resolve=>unrelated.once('exit',(code,signal)=>resolve({code,signal})));
    isolationFixture={child:unrelated,identity:authority.identity(unrelated.pid),done:unrelatedDone};
    evidence.isolationFixture={...isolationFixture.identity,purpose:'unrelated-no-network-node-cleanup-isolation'};
    const orphan=authority.read(join(ledger,'orphan-fixture.json'));
    assert.equal(orphan.runtime,id);assert.ok(authority.same(authority.identity(orphan.pid),orphan));
    const oldClaim=process.env.G1_COMPILER_CLAIM;process.env.G1_COMPILER_CLAIM=orphan.claim.slice('compiler-'.length,-'.json'.length);
    try {assert.throws(()=>compilerAuthority.validateChild(runtime,isolationFixture.identity),error=>error.message==='RUNTIME_COMPILER_IDENTITY_MISMATCH');}
    finally {if(oldClaim===undefined)delete process.env.G1_COMPILER_CLAIM;else process.env.G1_COMPILER_CLAIM=oldClaim;}
    evidence.scenarios.push({name:'unrelated-node-rejected-as-owned-compiler',pass:true,process:isolationFixture.identity});
  } else {
    const provider=await launch('provider');await ready(provider,'RUNTIME_PROVIDER_READY');
    const worker=await launch('worker');await ready(worker,'Annotation Platform worker ready.');
    const web=await launch('web');await ready(web,'RUNTIME_WEB_READY');
    if(runtime.checkpoint==='G5') {
      const {connectBrowser,browserSafetyNegatives,rehearseBrowserIsolation}=await import('./runtime-browser.mjs');
      const inspected=spawnSync('docker',['inspect',runtime.browser.id],{env:cleanEnv(),encoding:'utf8'});
      assert.equal(inspected.status,0,'browser container must be independently inspectable');
      evidence.browserSafety=browserSafetyNegatives(runtime,environment,JSON.parse(inspected.stdout)[0]);
      try { browser=await connectBrowser({runtime,environment}); }
      catch(error) {
        evidence.browserStartup=error.browserStartup;
        evidence.browserCleanup=error.browserCleanup;
        evidence.browserCleanupError=error.browserCleanupError;
        throw error;
      }
      evidence.browserVersion=browser.version;
      try { evidence.browserIsolation=await rehearseBrowserIsolation(browser,runtime,environment); }
      catch(error) { evidence.browserIsolationDiagnostics=error.browserProbeDiagnostics; throw error; }
      Object.assign(process.env,environment);
    }
    const {runE2E}=await import('./runtime-e2e.mjs');
    await runE2E({runtime,environment,root,browser,results:evidence.scenarios});
    const legacy=await launch('legacy');const exit=await legacy.done;
    console.log('LEGACY_METADATA_RESULTS',safeOutput(legacy.output()));
    assert.equal(exit.code,0,'legacy metadata tests failed');
    evidence.scenarios.push({name:'legacy-dataset-metadata-suite',pass:true});
  }
  await verify(baseReceipt,'test');successful=true;
} finally {
  let browserCleanupFailure;
  try {
    if(browser) evidence.browserCleanup=await browser.close();
    else if(runtime?.browser && !evidence.browserCleanup?.containerAbsent) {
      const {cleanupPreparedBrowser}=await import('./runtime-browser.mjs');
      evidence.browserCleanup=await cleanupPreparedBrowser({runtime});
    }
  } catch(error) {
    evidence.browserCleanupError=/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'BROWSER_CLEANUP_FAILED';
    successful=false;browserCleanupFailure=error;
  }
  const stopped=[];
  for(const owned of children.toReversed()) {
    if(owned.child.exitCode===null && !owned.child.signalCode) {
      const actual=authority.identity(owned.identity.pid);
      assert.ok(authority.same(actual,owned.identity),'cleanup PID identity changed');
      owned.child.kill('SIGTERM');
      const result=await Promise.race([owned.done,delay(30000).then(()=>null)]);
      assert.ok(result,'owned runtime did not drain; no unverified kill permitted');
    }
    assert.ok(!existsSync(`/proc/${owned.identity.pid}`),'owned child still exists');
    stopped.push({...owned.identity,role:owned.role,absent:true});
    const logs=safeOutput(owned.output()); if(!successful && logs)console.log('RUNTIME_DIAGNOSTIC',owned.role,logs);
  }
  const compilerProcesses=[];
  for(const file of readdirSync(ledger).filter(name=>/^compiler-[a-f0-9-]{36}\.json$/.test(name))) {
    const token=file.slice('compiler-'.length,-'.json'.length),c=compilerAuthority.claim(runtime,token).c;
    const rejection=rejectedCompilers.get(token);
    if(rejection) {
      assert.ok(authority.same(c.observed,rejection.identity));assert.equal(c.verified,false);
      assert.ok(!existsSync(`/proc/${c.observed.pid}`));
      compilerProcesses.push({...c,absent:true,expectedStartupRejection:rejection.name});continue;
    }
    assert.equal(c.runtime,runtime.id);assert.ok(c.observed,'compiler was never independently observed');
    const web=evidence.processes.find(p=>p.role==='web');assert.ok(web&&authority.same(c.parent,web));
    if(existsSync(`/proc/${c.observed.pid}`)) {
      assert.ok(authority.same(authority.identity(c.observed.pid),c.observed),'compiler PID was reused; cannot signal');
      const orphanPath=join(ledger,'orphan-fixture.json');
      if(existsSync(orphanPath)) {
        const orphan=authority.read(orphanPath);
        if(authority.same(c.observed,orphan)) {
          assert.equal(orphan.runtime,runtime.id);assert.ok(!existsSync(`/proc/${orphan.parent.pid}`),'orphan fixture parent must be stopped before compiler cleanup');
          assert.notEqual(authority.identity(orphan.pid).parent,orphan.parent.pid,'compiler must actually survive its parent');
          // SIGSTOP was applied only after independently verified startup. Resume
          // this exact receipt-owned PID so its normal SIGTERM can be delivered.
          process.kill(c.observed.pid,'SIGCONT');
          evidence.scenarios.push({name:'verified-compiler-survives-parent-and-receipt-owned-cleanup',pass:true,parentAbsent:true,identity:c.observed});
        }
      }
      process.kill(c.observed.pid,'SIGTERM');
      for(let n=0;n<100&&existsSync(`/proc/${c.observed.pid}`);n++)await delay(50);
    }
    assert.ok(!existsSync(`/proc/${c.observed.pid}`),'owned compiler remains after cleanup');
    compilerProcesses.push({...c,absent:true});
    if (!c.verified) console.log('G4_RUNTIME_DIAGNOSTIC_RECEIPT',JSON.stringify({
      ...evidence,pass:false,cleanup:{processes:stopped,compilerProcesses,complete:false},
      error:'RUNTIME_COMPILER_STARTUP_UNVERIFIED',
    }));
    assert.ok(c.verified,'compiler exited without verified startup; never claim unobserved child as verified');
  }
  if(isolationFixture) {
    assert.ok(authority.same(authority.identity(isolationFixture.identity.pid),isolationFixture.identity),'compiler cleanup must not terminate unrelated Node fixture');
    evidence.scenarios.push({name:'compiler-cleanup-preserves-unrelated-node-process',pass:true,process:isolationFixture.identity});
    isolationFixture.child.kill('SIGTERM');
    const isolatedExit=await Promise.race([isolationFixture.done,delay(10000).then(()=>null)]);
    assert.ok(isolatedExit,'exact fixture cleanup did not terminate');assert.ok(!existsSync(`/proc/${isolationFixture.identity.pid}`));
    stopped.push({...isolationFixture.identity,role:'unrelated-node-isolation-fixture',absent:true});
  }
  rmSync(registration,{force:true});rmSync(privateRoot,{recursive:true,force:true});
  delete process.env.G1_RUNTIME_RECEIPT;
  evidence.cleanup={processes:stopped,compilerProcesses,registrationAbsent:!existsSync(registration),privateStageAbsent:!existsSync(privateRoot)};
  evidence.pass=successful;emit();
  if(browserCleanupFailure)throw browserCleanupFailure;
}
