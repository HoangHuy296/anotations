#!/usr/bin/env node
// VIDEO media-processing trigger safety + metadata use + BOUNDING_BOX edit lifecycle, through the real runtime (HTTP + headless Chrome over CDP).
// Prints statuses, counts, revisions and ids only; no cookie, URL query or credential is written.
//   NODE_EXTRA_CA_CERTS=<tls>/gitea.crt node scripts/mvp/acceptance/video-media-lifecycle.mjs --media <dir>
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const WEB = 'http://127.0.0.1:3300', ORIGIN = 'http://localhost:3300', G = 'https://localhost:3310', MEDIA = args.media;
const runId = `video-media-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')}`;
const outDir = path.join(import.meta.dirname, '../../../specs/029-modality-specific-datasets/verification/mvp-engines', runId);
const checks = []; const rec = (id, pass, observed) => { checks.push({ id, pass: Boolean(pass), observed }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(observed).slice(0, 260)}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sql = q => execFileSync('docker', ['exec', 'phase029-g1-mvp-postgres', 'psql', '-U', 'postgres', '-d', 'fieldframe', '-tAc', q], { encoding: 'utf8' }).trim();
const sid = v => String(v).replace(/[^A-Za-z0-9-]/g, '');
const jobCount = assetId => Number(sql(`select count(*) from "Job" where type::text='EXTRACT_VIDEO_METADATA' and "idempotencyKey" like 'media:%' and input::text like '%${sid(assetId)}%'`));

// ---- HTTP session + Gitea fixture
const mk = async tag => { const email = `vm-${tag}-${randomBytes(3).toString('hex')}@example.test`, password = randomBytes(10).toString('hex') + 'Aa1!'; const s = { cookie: '', name: '', value: '' }; const call = (m, u, b) => api(s, m, u, b); await call('POST', '/api/auth/signup', { email, password, role: 'MANAGER', name: tag }); const r = await fetch(WEB + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }); const sc = (r.headers.getSetCookie() || [])[0] ?? ''; s.cookie = sc.split(';')[0]; s.name = sc.split('=')[0]; s.value = s.cookie.split('=').slice(1).join('='); return s; };
async function api(s, m, u, b) { const r = await fetch(u.startsWith('http') ? u : WEB + u, { method: m, headers: { ...(s.cookie ? { cookie: s.cookie } : {}), ...(b ? { 'content-type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { status: r.status, json: j }; }
const gu = 'vm' + randomBytes(3).toString('hex'), gp = randomBytes(10).toString('hex') + 'Aa1!';
const g = async (m, p, b) => (await fetch(G + '/api/v1' + p, { method: m, headers: { authorization: 'Basic ' + Buffer.from(gu + ':' + gp).toString('base64'), 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).status;
async function videoAsset(s, tag) {
  const name = `vm-${tag}`; await g('POST', '/user/repos', { name, private: false, auto_init: true, default_branch: 'main' }); await g('POST', `/repos/${gu}/${name}/contents/data/v.mp4`, { content: readFileSync(path.join(MEDIA, 'v.mp4')).toString('base64'), message: 'a', branch: 'main' });
  const imp = await api(s, 'POST', '/api/datasets/from-repository', { modality: 'VIDEO', provider: 'GITEA', credentialMode: 'PUBLIC', serverUrl: 'https://gitea:3000', repository: { owner: gu, name, ref: 'main', expectedVisibility: 'PUBLIC', rootPath: 'data' }, datasetName: name, idempotencyKey: 'v-' + randomUUID() });
  for (let i = 0; i < 40; i++) { const jb = (await api(s, 'GET', '/api/jobs/' + imp.json.data.job.id)).json?.data; if (jb && ['COMPLETED', 'FAILED'].includes(jb.status)) break; await sleep(1500); }
  return { datasetId: imp.json.data.dataset.id, assetId: sql(`select id from "Asset" where "datasetId"='${sid(imp.json.data.dataset.id)}' limit 1`) };
}
const readiness = async (s, assetId) => (await api(s, 'GET', `/api/assets/${assetId}/media-processing/status`)).json?.data;
const until = async (s, assetId, states, n = 40) => { let r; for (let i = 0; i < n; i++) { r = await readiness(s, assetId); if (states.includes(r?.state)) return r; await sleep(1500); } return r; };

// ---- CDP
async function launchChrome() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cdp-')); const proc = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--window-size=1500,1000', 'about:blank'], { stdio: 'ignore' });
  let port; for (let i = 0; i < 50 && !port; i++) { await sleep(200); try { port = readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* */ } }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let n = 0; const pending = new Map(), listeners = []; ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } else if (m.method) listeners.forEach(l => l(m)); };
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++n; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const posts = []; const methods = new Map();
  listeners.push(m => { if (m.method === 'Network.requestWillBeSent') methods.set(m.params.requestId, m.params.request.method); if (m.method === 'Network.responseReceived') { const u = new URL(m.params.response.url); const mm = methods.get(m.params.requestId); if (u.pathname.startsWith('/api/') && mm && mm !== 'GET') posts.push(`${mm} ${m.params.response.status} ${u.pathname.replace(/[0-9a-f-]{20,}|c[a-z0-9]{24}/g, ':id')}`); } });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1, ...extra });
  await send('Network.enable'); await send('Runtime.enable'); await send('Page.enable');
  return { send, ev, mouse, posts, setCookie: s => send('Network.setCookie', { name: s.name, value: s.value, url: ORIGIN }), goto: async url => { await send('Page.navigate', { url }); await sleep(5500); }, close: () => { try { ws.close(); } catch { /* */ } proc.kill('SIGKILL'); setTimeout(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* */ } }, 1500); } };
}
const click = (c, label) => c.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)}&&!x.disabled);if(!b)return false;b.click();return true})()`);
const mediaPosts = c => c.posts.filter(p => p.includes('/media-processing')).length;

try {
  execFileSync('docker', ['exec', '-u', 'git', 'annotationplatformmvp-gitea-1', 'gitea', 'admin', 'user', 'create', '--admin', '--username', gu, '--password', gp, '--email', gu + '@example.test', '--must-change-password=false'], { stdio: 'pipe' });
  const s = await mk('owner');

  // ===== A. idempotency under concurrency (server boundary the hook relies on)
  const a1 = await videoAsset(s, 'conc');
  rec('A0-fixture-starts-NOT_REQUESTED', (await readiness(s, a1.assetId))?.state === 'NOT_REQUESTED', { jobs: jobCount(a1.assetId) });
  const burst = await Promise.all(Array.from({ length: 6 }, () => api(s, 'POST', `/api/assets/${a1.assetId}/media-processing`, { type: 'EXTRACT_VIDEO_METADATA' })));
  rec('A1-six-parallel-requests-create-exactly-one-job', jobCount(a1.assetId) === 1 && new Set(burst.map(r => r.json?.data?.jobId)).size === 1, { statuses: burst.map(r => r.status), created: burst.filter(r => r.json?.data?.reused === false).length, jobs: jobCount(a1.assetId) });
  const mid = await api(s, 'POST', `/api/assets/${a1.assetId}/media-processing`, { type: 'EXTRACT_VIDEO_METADATA' });
  rec('A2-request-while-queued-or-running-reuses-the-job', mid.json?.data?.reused === true && jobCount(a1.assetId) === 1, { status: mid.status, jobStatus: mid.json?.data?.status, reused: mid.json?.data?.reused });
  const done = await until(s, a1.assetId, ['COMPLETED', 'FAILED']);
  rec('A3-processing-completes-with-authoritative-metadata', done?.state === 'COMPLETED' && done.video?.fps === 10 && done.video?.totalFrames === 20 && done.video?.durationMs === 2000, done?.video);
  const again = await Promise.all([1, 2, 3].map(() => api(s, 'POST', `/api/assets/${a1.assetId}/media-processing`, { type: 'EXTRACT_VIDEO_METADATA' })));
  rec('A4-request-after-completion-reuses-and-creates-no-job', again.every(r => r.json?.data?.reused === true) && jobCount(a1.assetId) === 1, { reused: again.map(r => r.json?.data?.reused), jobs: jobCount(a1.assetId) });

  // ===== B. browser: rerender / navigation away-back / two tabs on a fresh NOT_REQUESTED asset
  const b1 = await videoAsset(s, 'tabs'); const other = (await api(s, 'POST', '/api/datasets', { name: 'vm-other-' + randomBytes(2).toString('hex'), modality: 'TEXT' })).json.data.id;
  const urlB = `${ORIGIN}/workspace/${b1.datasetId}?video=${b1.assetId}`;
  const [t1, t2] = await Promise.all([launchChrome(), launchChrome()]); await t1.setCookie(s); await t2.setCookie(s);
  await Promise.all([t1.goto(urlB), t2.goto(urlB)]);
  const afterTabs = await readiness(s, b1.assetId);
  rec('B1-two-tabs-open-concurrently-create-one-job', jobCount(b1.assetId) === 1, { tab1Posts: mediaPosts(t1), tab2Posts: mediaPosts(t2), jobs: jobCount(b1.assetId), state: afterTabs?.state });
  for (let i = 0; i < 3; i++) { await t1.ev(`window.next.router.push('/workspace/${other}')`); await sleep(2500); await t1.ev(`window.next.router.push(${JSON.stringify(`/workspace/${b1.datasetId}?video=${b1.assetId}`)})`); await sleep(2500); }
  const final = await until(s, b1.assetId, ['COMPLETED', 'FAILED']);
  rec('B2-navigate-away-and-back-3x-creates-no-duplicate', jobCount(b1.assetId) === 1 && final?.state === 'COMPLETED', { tab1MediaPosts: mediaPosts(t1), jobs: jobCount(b1.assetId), state: final?.state });
  const n0 = mediaPosts(t1); await t1.send('Page.reload'); await sleep(5000);
  rec('B3-reload-with-READY-metadata-requests-nothing', mediaPosts(t1) === n0 && jobCount(b1.assetId) === 1, { newMediaPosts: mediaPosts(t1) - n0 });
  rec('B4-engine-stays-VIDEO-regardless-of-readiness', (await t1.ev(`[...document.querySelectorAll('[aria-label$=" annotation tools"]')].map(e=>e.getAttribute('aria-label')).join()`)) === 'Video annotation tools', {});
  t2.close();

  // ===== C. metadata is used: frame step advances by 1/fps (10 fps), not the 1/30 fallback
  await sleep(1500);
  const stepped = await t1.ev(`(async()=>{const v=document.querySelector('video');if(!v)return null;v.pause();v.currentTime=0;await new Promise(r=>setTimeout(r,600));const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Next frame');b&&b.click();await new Promise(r=>setTimeout(r,900));return {t:v.currentTime,duration:v.duration}})()`);
  rec('C1-next-frame-advances-0.1s-at-the-extracted-10fps', stepped && Math.abs(stepped.t - 0.1) < 0.02, stepped);

  // ===== E. BOUNDING_BOX edit lifecycle in the browser: draw -> save -> drag -> autosave -> revision -> reload -> persisted geometry
  await click(t1, 'Bounding box'); await sleep(400);
  const vr = await t1.ev(`(()=>{const r=document.querySelector('video').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
  await t1.mouse('mouseMoved', vr.x + vr.w * 0.2, vr.y + vr.h * 0.2, { buttons: 0 }); await t1.mouse('mousePressed', vr.x + vr.w * 0.2, vr.y + vr.h * 0.2); for (let i = 1; i <= 5; i++) await t1.mouse('mouseMoved', vr.x + vr.w * (0.2 + 0.07 * i), vr.y + vr.h * (0.2 + 0.07 * i)); await t1.mouse('mouseReleased', vr.x + vr.w * 0.55, vr.y + vr.h * 0.55); await sleep(800);
  await t1.ev(`(()=>{const f=(p,t)=>{const i=[...document.querySelectorAll('input')].find(x=>p.test(x.placeholder));i&&i.focus()};f(/person-1/)})()`); await t1.send('Input.insertText', { text: 'obj-e' });
  await t1.ev(`(()=>{const i=[...document.querySelectorAll('input')].find(x=>/Track 1/.test(x.placeholder));i&&i.focus()})()`); await t1.send('Input.insertText', { text: 'Edit track' });
  await t1.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='OK'&&!x.disabled);b&&b.click()})()`); await sleep(3500);
  const v0 = (await api(s, 'GET', `/api/assets/${b1.assetId}/video-annotations`)).json?.data; const k0 = v0?.keyframes?.[0], tr0 = v0?.tracks?.[0];
  rec('E1-draw-and-confirm-persists-track-and-keyframe', Boolean(k0 && tr0), { tracks: v0?.tracks?.length, keyframes: v0?.keyframes?.length, trackRevision: tr0?.revision, x: k0?.geometry?.x });
  await click(t1, 'Select'); await sleep(500);
  const mv = await t1.ev(`(()=>{const e=document.querySelector('[aria-label="Move keyframe"]');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const before = mediaPosts(t1); const mark = t1.posts.length;
  if (mv) { await t1.mouse('mouseMoved', mv.x, mv.y, { buttons: 0 }); await t1.mouse('mousePressed', mv.x, mv.y); for (let i = 1; i <= 6; i++) await t1.mouse('mouseMoved', mv.x + i * 5, mv.y + i * 2); await t1.mouse('mouseReleased', mv.x + 30, mv.y + 12); }
  await sleep(4500);
  const patches = t1.posts.slice(mark).filter(p => /^(PATCH|PUT|POST)/.test(p));
  const v1 = (await api(s, 'GET', `/api/assets/${b1.assetId}/video-annotations`)).json?.data; const k1 = v1?.keyframes?.[0], tr1 = v1?.tracks?.[0];
  rec('E2-drag-autosaves-and-advances-the-track-revision', Boolean(mv) && k1 && k0 && k1.geometry.x > k0.geometry.x && tr1.revision > tr0.revision, { mutations: patches, revisionBefore: tr0?.revision, revisionAfter: tr1?.revision, xBefore: k0?.geometry?.x, xAfter: k1?.geometry?.x });
  await t1.send('Page.reload'); await sleep(6000);
  // the keyframe box is drawn only at its own timestamp: seek to it through the timeline marker, exactly as a user would
  await t1.ev(`(()=>{const m=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'').startsWith('Persisted keyframe at'));m&&m.click()})()`); await sleep(1500); await click(t1, 'Select'); await sleep(500);
  const dom = await t1.ev(`(()=>{const e=document.querySelector('[aria-label="Move keyframe"]');const v=document.querySelector('video');if(!e||!v)return null;const a=e.getBoundingClientRect(),b=v.getBoundingClientRect();const st=e.parentElement.style;return {x:(a.x-b.x)/b.width,styleLeft:st.left,styleTop:st.top,styleWidth:st.width,videoTime:v.currentTime}})()`);
  const v2 = (await api(s, 'GET', `/api/assets/${b1.assetId}/video-annotations`)).json?.data;
  rec('E3-reload-shows-the-persisted-geometry', dom && Math.abs(parseFloat(dom.styleLeft) / 100 - v2.keyframes[0].geometry.x) < 0.005 && Math.abs(v2.keyframes[0].geometry.x - k1.geometry.x) < 1e-9, { dom, persistedX: v2.keyframes[0].geometry.x, persistedTs: v2.keyframes[0].timestampMs });
  const staleRev = tr0.revision;
  const stale = await api(s, 'PATCH', `/api/video-keyframes/${k0.id}`, { expectedTrackRevision: staleRev, geometry: { kind: 'BOUNDING_BOX', x: 0.1, y: 0.1, width: 0.2, height: 0.2 } });
  rec('E4-stale-revision-still-409', stale.status === 409, { status: stale.status, code: stale.json?.error?.code });
  t1.close();

  // ===== D. failure and retry: remove the source object of a fresh asset, then request processing
  const d1 = await videoAsset(s, 'fail');
  const loc = sql(`select "storageBucket"||'|'||"storageKey" from "Asset" where id='${sid(d1.assetId)}'`);
  execFileSync('docker', ['exec', '-e', `LOC=${loc}`, 'annotationplatformmvp-worker-1', 'sh', '-c', `cd /workspace/apps/worker && node -e "const {Client}=require('minio');const u=new URL(process.env.MINIO_ENDPOINT);const c=new Client({endPoint:u.hostname,port:Number(u.port),useSSL:false,accessKey:process.env.MINIO_ACCESS_KEY,secretKey:process.env.MINIO_SECRET_KEY});const [b,k]=process.env.LOC.split('|');c.removeObject(b,k).then(()=>console.log('removed fixture object')).catch(e=>console.log('ERR',e.code))"`], { stdio: 'pipe' });
  const f1 = await api(s, 'POST', `/api/assets/${d1.assetId}/media-processing`, { type: 'EXTRACT_VIDEO_METADATA' });
  const failed = await until(s, d1.assetId, ['FAILED', 'COMPLETED']);
  rec('D1-source-failure-ends-FAILED-safely', failed?.state === 'FAILED', { requestStatus: f1.status, state: failed?.state, outcome: failed?.outcome?.code });
  const f2 = await api(s, 'POST', `/api/assets/${d1.assetId}/media-processing`, { type: 'EXTRACT_VIDEO_METADATA' });
  rec('D2-re-request-after-failure-reuses-the-same-request-no-duplicate-job', jobCount(d1.assetId) === 1 && f2.json?.data?.reused === true, { status: f2.status, reused: f2.json?.data?.reused, jobStatus: f2.json?.data?.status, jobs: jobCount(d1.assetId) });
  const t3 = await launchChrome(); await t3.setCookie(s); await t3.goto(`${ORIGIN}/workspace/${d1.datasetId}?video=${d1.assetId}`); await sleep(3000);
  rec('D3-FAILED-asset-opens-without-a-request-loop-and-engine-stays-VIDEO', mediaPosts(t3) === 0 && jobCount(d1.assetId) === 1 && (await t3.ev(`[...document.querySelectorAll('[aria-label$=" annotation tools"]')].map(e=>e.getAttribute('aria-label')).join()`)) === 'Video annotation tools', { mediaPosts: mediaPosts(t3), jobs: jobCount(d1.assetId) });
  t3.close();
} catch (e) { rec('HARNESS', false, String(e.stack ?? e).split('\n').slice(0, 3).join(' | ')); }
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const f = path.join(outDir, 'video-media-lifecycle.json'); writeFileSync(f, JSON.stringify({ runId, checks }, null, 2) + '\n', { mode: 0o400 }); try { chmodSync(f, 0o400); } catch { /* */ }
console.log(`\n${checks.filter(c => c.pass).length}/${checks.length} pass -> ${outDir}`);
process.exit(0);
