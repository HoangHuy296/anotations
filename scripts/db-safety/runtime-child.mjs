// Entry is authorized by the G1 preload before importing any application code.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const authority = require('./runtime-authority.cjs');
const receipt = authority.receipt();
const role = process.argv[2];
const spec = receipt.roles[role];
if (role === 'probe') {
  // Prove that loopback alone never grants access to ambient application services.
  const net = require('node:net');
  for (const port of [3000,5433,6379,9000]) {
    let denied = false;
    try { net.connect({ host: '127.0.0.1', port }); } catch (error) { denied = error.message === 'DB_SAFETY_NETWORK_TARGET_DENIED'; }
    if (!denied) throw Error('RUNTIME_AMBIENT_TARGET_NOT_DENIED');
  }
  console.log('RUNTIME_AMBIENT_TARGETS_DENIED');
  console.log('RUNTIME_PROBE_READY');
} else if (role === 'web') {
  if (receipt.mode==='safety') {
    const assert=require('node:assert/strict'),cp=require('node:child_process'),fs=require('node:fs');
    const compilers=require('./runtime-compilers.cjs');
    const compilerRecord=file=>compilers.claim(receipt,file.slice('compiler-'.length,-'.json'.length)).c;
    const assertVerifiedHandoff=child=>{
      const file=fs.readdirSync(receipt.ledger).find(f=>/^compiler-[a-f0-9-]{36}\.json$/.test(f)&&compilerRecord(f).observed?.pid===child.pid);
      assert.ok(file,'allowed compiler must have an independently observed claim before fork returns');
      const record=compilerRecord(file);
      assert.equal(record.verified,true,'fork must wait for the child checker proof before handing its handle to Next');
      assert.ok(authority.same(authority.identity(child.pid),record.observed),'handoff must bind the actual child PID/start/UID');
      assert.equal(record.observed.parent,process.pid,'handoff must remain descended from this owned HTTP runtime');
    };
    const settings={env:{...process.env},execArgv:process.execArgv,stdio:['ignore','pipe','pipe','ipc']};
    for(const [entry,args,opts,error] of [
      [process.argv[1],[],settings,'RUNTIME_COMPILER_ENTRY_DENIED'],
      [receipt.compiler.entry,['unregistered'],settings,'RUNTIME_COMPILER_ENTRY_DENIED'],
      [receipt.compiler.entry,[],{...settings,env:{...process.env,MINIO_ENDPOINT:'http://127.0.0.1:9000'}},'RUNTIME_COMPILER_ENVIRONMENT_MISMATCH'],
    ]) assert.throws(()=>cp.fork(entry,args,opts),e=>e.message===error);
    for(let repetition=0;repetition<2;repetition++) {
      const child=cp.fork(receipt.compiler.entry,[],settings);assertVerifiedHandoff(child);let output='';child.stderr.on('data',b=>output+=b);child.stdout.resume();
      const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
      // Send initialization before the guarded preload finishes. Node must retain
      // this queued message until the real bootstrap installs its IPC listener.
      if(repetition===1)child.send([0,0,receipt.compiler.module,[]]);
      let file,record;
      for(let n=0;n<200;n++) {
        file=fs.readdirSync(receipt.ledger).find(f=>/^compiler-[a-f0-9-]{36}\.json$/.test(f)&&compilerRecord(f).observed?.pid===child.pid);
        record=file&&compilerRecord(file);if(record?.verified&&record?.listenDenied)break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.ok(record?.verified&&record?.listenDenied,'compiler startup must complete both verification and listen restriction proof: '+output);
      assert.throws(()=>child.send([0,0,process.argv[1],[]]),e=>e.message==='RUNTIME_COMPILER_MODULE_DENIED');
      if(repetition===0)child.send([0,0,receipt.compiler.module,[]]);
      assert.throws(()=>child.send([1,0,'anything',[]]),e=>e.message==='RUNTIME_COMPILER_CALL_DENIED');
      const allowedPaths={dir:join(receipt.project,'apps/web'),distDir:receipt.compiler.distDir,pathname:'/fixture'};
      for(const [change,error] of [[{dir:'/tmp'},'RUNTIME_COMPILER_PATH_DENIED'],[{distDir:'/tmp'},'RUNTIME_COMPILER_PATH_DENIED'],[{distDir:join(receipt.project,'apps/web/.next')},'RUNTIME_COMPILER_PATH_DENIED'],[{pathname:'/../escape'},'RUNTIME_COMPILER_PATH_DENIED'],[{cacheHandler:process.argv[1]},'RUNTIME_COMPILER_CACHE_HANDLER_DENIED'],[{cacheHandlers:{default:process.argv[1]}},'RUNTIME_COMPILER_CACHE_HANDLER_DENIED']]) {
        assert.throws(()=>child.send([1,0,'loadStaticPaths',[{...allowedPaths,...change}]]),e=>e.message===error);
      }
      assert.equal(compilerRecord(file).listenDenied,true,'actual compiler process must deny even the receipted HTTP listen target');
      child.send([2]);
      // Disconnecting immediately could terminate a still-booting child before
      // its bootstrap consumes the queued messages. Require the bootstrap's exit.
      await Promise.race([exit,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('COMPILER_BOOTSTRAP_EXIT_TIMEOUT')),10000);timer.unref();})]);
      assert.equal(compilerRecord(file).moduleLoaded,true,'bootstrap must consume queued initialization and load approved module');
      assert.ok(!fs.existsSync(`/proc/${child.pid}`));
      assert.ok(authority.same(authority.identity(process.pid),authority.read(join(receipt.ledger,'web.json'))),'compiler exit must not kill HTTP owner');
    }
    // Leave one fully verified compiler stopped across the HTTP parent's exit.
    // This deterministically exercises receipt-owned orphan cleanup rather than
    // assuming that a normally exiting compiler covers surviving descendants.
    const orphan=cp.fork(receipt.compiler.entry,[],settings);assertVerifiedHandoff(orphan);orphan.stdout.resume();orphan.stderr.resume();
    let orphanFile,orphanRecord;
    for(let n=0;n<200;n++) {
      orphanFile=fs.readdirSync(receipt.ledger).find(f=>/^compiler-[a-f0-9-]{36}\.json$/.test(f)&&compilerRecord(f).observed?.pid===orphan.pid);
      orphanRecord=orphanFile&&compilerRecord(orphanFile);if(orphanRecord?.verified&&orphanRecord?.listenDenied)break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(orphanRecord?.verified&&orphanRecord?.listenDenied,'orphan fixture must pass real startup ownership and listen restriction checks');
    assert.ok(authority.same(authority.identity(orphan.pid),orphanRecord.observed));
    process.kill(orphan.pid,'SIGSTOP');
    for(let n=0;n<200;n++) {
      const stat=fs.readFileSync(`/proc/${orphan.pid}/stat`,'utf8');
      if(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]==='T')break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(fs.readFileSync(`/proc/${orphan.pid}/stat`,'utf8').split(') ').at(-1).split(' ')[0],'T');
    fs.writeFileSync(join(receipt.ledger,'orphan-fixture.json'),JSON.stringify({runtime:receipt.id,claim:orphanFile,...orphanRecord.observed,parent:orphanRecord.parent}),{mode:0o600,flag:'wx'});
    console.log('RUNTIME_COMPILER_SAFETY_PASS');
  }
  const next = createRequire(join(receipt.project, 'apps/web/package.json'))('next');
  const app = next({ dev: true, dir: join(receipt.project, 'apps/web'), hostname: '127.0.0.1', port: spec.port, webpack: true });
  await app.prepare();
  const handler = app.getRequestHandler();
  const server = createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(spec.port, '127.0.0.1', resolve));
  process.once('SIGTERM', () => server.close(async () => { await app.close(); process.exit(0); }));
  console.log('RUNTIME_WEB_READY');
} else if (role === 'worker') {
  await import('../../apps/worker/src/index.ts');
} else if (role === 'legacy') {
  // Match the existing guarded metadata test command's server-only marker setup.
  // The runtime/target preload has already verified this receipt-owned process.
  require('../../apps/web/tests/auth-ownership/register-server-only.cjs');
  for (const file of ['assets','datasets','labels','http-routes']) {
    await import(`../../apps/web/tests/dataset-metadata/${file}.test.ts`);
  }
} else if (role === 'provider') {
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const text = Buffer.from('verified fixture text\n');
  const origin = `http://127.0.0.1:${spec.port}`;
  const controls = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url, origin);
    const name = url.pathname.split('/')[5] || 'success';
    const control = controls.get(name) || {};
    const files = name === 'zero' ? [{ path: 'b.txt', bytes: text }] : name === 'partial' && !control.onlyImage ? [{ path: 'a.png', bytes: image }, { path: 'b.txt', bytes: text }] : [{ path: 'a.png', bytes: image }];
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/ready') return json({ ready: true, runtime: receipt.id });
    if (url.pathname.startsWith('/_control/') && req.method === 'POST') {
      if (req.headers['x-runtime-owner'] !== receipt.id) { res.statusCode=403; return res.end(); }
      let body='';req.on('data',b=>{body+=b});req.on('end',()=>{controls.set(url.pathname.split('/').at(-1),JSON.parse(body));json({ok:true});});return;
    }
    if (url.pathname.endsWith('/branches')) return json([{ name: 'main' }]);
    if (url.pathname.includes('/git/commits/')) return json({ sha: 'fixture-r1' });
    if (url.pathname.endsWith('/commits')) return json([{ sha: 'fixture-r1', commit: { message: 'fixture' } }]);
    if (url.pathname.includes('/git/trees/')) return json({ tree: files.map((f, i) => ({ path: f.path, type: 'blob', size: f.bytes.length, sha: `fixture-blob-${i}${control.conflict?'-changed':''}` })), truncated: false });
    if (url.pathname.includes('/contents')) return json([]);
    if (url.pathname.includes('/raw/')) {
      if (name === 'downloadfail') { res.statusCode = 503; return res.end(); }
      const file = files.find(f => url.pathname.endsWith('/'+f.path));
      if (!file) { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Length', file.bytes.length); return res.end(file.bytes);
    }
    if (/\/api\/v1\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) return json({ default_branch: 'main', private: false });
    res.statusCode = 404; res.end();
  });
  await new Promise(resolve => server.listen(spec.port, '127.0.0.1', resolve));
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
  console.log('RUNTIME_PROVIDER_READY');
} else throw Error('RUNTIME_ROLE_UNAPPROVED');
