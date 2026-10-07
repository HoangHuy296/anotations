#!/usr/bin/env node
// Real-browser (headless Chrome over CDP, no extra dependency) audit of the modality workspaces on the MVP origin http://localhost:3300.
// Seeds one dataset per modality through the real HTTP flows, opens each workspace with that user's session and records console errors, failed network
// requests (incl. CORS), the rendered toolbox and the engine's own loaded/empty state. No cookie, URL query or credential is written to the report.
//   NODE_EXTRA_CA_CERTS=<tls>/gitea.crt node scripts/mvp/acceptance/browser-audit.mjs --label red --media <dir> [--only TEXT,VIDEO]
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const ORIGIN = 'http://localhost:3300', WEB = 'http://127.0.0.1:3300', MEDIA = args.media, LABEL = args.label ?? 'run';
const ONLY = (args.only ?? 'IMAGE,VIDEO,AUDIO,TEXT').split(',');
const GITEA = 'https://localhost:3310', GITEA_INTERNAL = 'https://gitea:3000';
const runId = `${LABEL}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')}`;
const outDir = path.join(import.meta.dirname, '../../../specs/029-modality-specific-datasets/verification/mvp-engines', `browser-${runId}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => createHash('sha256').update(b).digest('hex');
const sql = q => execFileSync('docker', ['exec', 'phase029-g1-mvp-postgres', 'psql', '-U', 'postgres', '-d', 'fieldframe', '-tAc', q], { encoding: 'utf8' }).trim();
const sid = v => String(v).replace(/[^A-Za-z0-9-]/g, '');

// ---------- minimal CDP client over the built-in WebSocket ----------
async function launchChrome() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cdp-'));
  const proc = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--window-size=1500,1000', 'about:blank'], { stdio: 'ignore' });
  let port; for (let i = 0; i < 50 && !port; i++) { await sleep(200); try { port = readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* wait */ } }
  if (!port) throw new Error('CHROME_NOT_STARTED');
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let n = 0; const pending = new Map(), listeners = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } else if (m.method) listeners.forEach(l => l(m)); };
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++n; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  return { send, on: l => listeners.push(l), close: () => { try { ws.close(); } catch { /* */ } proc.kill('SIGKILL'); setTimeout(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* best effort temp cleanup */ } }, 1500); } };
}

// ---------- seeding through the real HTTP flows ----------
async function api(cookie, m, u, body) { const r = await fetch((u.startsWith('http') ? u : WEB + u), { method: m, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ } return { status: r.status, json: j }; }
async function newUser(tag) { const email = `br-${tag}-${randomBytes(3).toString('hex')}@example.test`, password = randomBytes(10).toString('hex') + 'Aa1!'; await api(null, 'POST', '/api/auth/signup', { email, password, role: 'MANAGER', name: tag }); const r = await fetch(WEB + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }); const set = (r.headers.getSetCookie() || [])[0] ?? ''; return { cookie: set.split(';')[0], name: set.split('=')[0], value: set.split(';')[0].split('=').slice(1).join('=') }; }
async function putMinio(cap, bytes, type) { const f = new FormData(); for (const [k, v] of Object.entries(cap.formFields)) f.append(k, v); f.append('file', new Blob([bytes], { type }), 'f'); return (await fetch(cap.uploadUrl, { method: 'POST', body: f })).status; }
const TEXTS = [{ name: 'a.txt', type: 'text/plain', bytes: Buffer.from('The quick brown fox jumps over the lazy dog.\nSecond line of text.\n') }];
async function seedTextLocal(u, classes = []) {
  const items = TEXTS.map(f => ({ logicalPath: `d/${f.name}`, contentType: f.type, sizeBytes: f.bytes.length, fingerprint: sha(f.bytes) }));
  const s = await api(u.cookie, 'POST', '/api/imports/local-folder', { name: `br-text-${randomBytes(2).toString('hex')}`, modality: 'TEXT', idempotencyKey: `b-${randomUUID()}`, items, ...(classes.length ? { confirmedClasses: classes } : {}) });
  const prep = s.json.data.preparation; const caps = await api(u.cookie, 'POST', `/api/imports/${prep.id}/upload-capabilities`, { itemIds: prep.items.map(i => i.id) });
  const cap = caps.json.data.capabilities[0]; await putMinio(cap, TEXTS[0].bytes, TEXTS[0].type);
  await api(u.cookie, 'POST', `/api/imports/${prep.id}/items/${prep.items[0].id}/complete`, { fileId: cap.fileId }); await api(u.cookie, 'POST', `/api/jobs/${prep.jobId}/commit-import`);
  return prep.datasetId;
}
async function seedRepo(u, modality, files) {
  const gtUser = `br${randomBytes(3).toString('hex')}`, gtPass = randomBytes(10).toString('hex') + 'Aa1!';
  execFileSync('docker', ['exec', '-u', 'git', 'annotationplatformmvp-gitea-1', 'gitea', 'admin', 'user', 'create', '--admin', '--username', gtUser, '--password', gtPass, '--email', `${gtUser}@example.test`, '--must-change-password=false'], { stdio: 'pipe' });
  const g = async (m, p, b) => (await fetch(GITEA + '/api/v1' + p, { method: m, headers: { authorization: 'Basic ' + Buffer.from(`${gtUser}:${gtPass}`).toString('base64'), 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).status;
  const name = `br-${modality.toLowerCase()}`; await g('POST', '/user/repos', { name, private: false, auto_init: true, default_branch: 'main' });
  for (const f of files) await g('POST', `/repos/${gtUser}/${name}/contents/data/${f.name}`, { content: f.bytes.toString('base64'), message: 'add', branch: 'main' });
  const r = await api(u.cookie, 'POST', '/api/datasets/from-repository', { modality, provider: 'GITEA', credentialMode: 'PUBLIC', serverUrl: GITEA_INTERNAL, repository: { owner: gtUser, name, ref: 'main', expectedVisibility: 'PUBLIC', rootPath: 'data' }, datasetName: `br-${modality}`, idempotencyKey: `r-${randomUUID()}` });
  for (let i = 0; i < 60; i++) { const j = (await api(u.cookie, 'GET', `/api/jobs/${r.json.data.job.id}`)).json?.data; if (j && ['COMPLETED', 'FAILED'].includes(j.status)) break; await sleep(2000); }
  return r.json.data.dataset.id;
}
const mediaFile = (n, type) => ({ name: n, type, bytes: readFileSync(path.join(MEDIA, n)) });

// ---------- page inspection ----------
async function inspect(chrome, user, url, label, actions) {
  const events = { console: [], failed: [], http: [], api: [] }; const methods = new Map();
  chrome.on(m => {
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) events.console.push(`${m.params.type}: ${m.params.args.map(a => String(a.value ?? a.description ?? '').slice(0, 160)).join(' ')}`.slice(0, 300));
    if (m.method === 'Runtime.exceptionThrown') events.console.push('exception: ' + String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).slice(0, 300));
    if (m.method === 'Network.loadingFailed') events.failed.push(`${m.params.errorText}${m.params.blockedReason ? ' (' + m.params.blockedReason + ')' : ''}${m.params.corsErrorStatus ? ' CORS:' + m.params.corsErrorStatus.corsError : ''}`);
    if (m.method === 'Network.requestWillBeSent') methods.set(m.params.requestId, m.params.request.method);
    if (m.method === 'Network.responseReceived' && new URL(m.params.response.url).pathname.startsWith('/api/') && methods.get(m.params.requestId) !== 'GET') events.api.push(`${methods.get(m.params.requestId)} ${m.params.response.status} ${new URL(m.params.response.url).pathname.replace(/[0-9a-f-]{20,}|c[a-z0-9]{24}/g, ':id')}`);
    if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) events.http.push(`${m.params.response.status} ${new URL(m.params.response.url).origin}${new URL(m.params.response.url).pathname.replace(/[0-9a-f-]{20,}|c[a-z0-9]{24}/g, ':id')}`);
  });
  await chrome.send('Network.enable'); await chrome.send('Runtime.enable'); await chrome.send('Page.enable');
  await chrome.send('Network.setCookie', { name: user.name, value: user.value, url: ORIGIN });
  await chrome.send('Page.navigate', { url }); await sleep(6000);
  const ev = async expr => (await chrome.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  const snap = async () => ev(`(()=>{const t=document.body.innerText;return {tools:[...document.querySelectorAll('[aria-label$=" annotation tools"]')].map(e=>e.getAttribute('aria-label')),buttons:[...document.querySelectorAll('button')].map(b=>(b.innerText||b.getAttribute('aria-label')||'').trim()).filter(Boolean).slice(0,60),canvas:document.querySelectorAll('canvas').length,video:document.querySelectorAll('video').length,audio:document.querySelectorAll('audio').length,text:t.slice(0,400).replace(/\\s+/g,' '),tabs:[...document.querySelectorAll('[role=tab]')].map(e=>e.innerText.trim()),toolbox:[...document.querySelectorAll('[aria-label$=\" annotation tools\"] button, [aria-label$=\" annotation tools\"] ~ * button')].slice(0,30).map(b=>({label:b.getAttribute('aria-label')||b.innerText.trim(),disabled:b.disabled,title:(b.title||'').slice(0,120)})).filter(x=>x.label)}})()`);
  const first = await snap(); const extra = actions ? await actions({ ev, send: chrome.send, sleep, snap }) : null;
  return { label, url: url.replace(/(\?|&).*/, ''), first, extra, console: [...new Set(events.console)].slice(0, 12), failedRequests: [...new Set(events.failed)].slice(0, 12), http4xx: [...new Set(events.http)].slice(0, 12), mutations: events.api.slice(0, 30) };
}

const clickLabel = (ev, label) => ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)}&&!x.disabled);if(!b)return false;b.click();return true})()`);
const mouse = (send, type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1, ...extra });
const ACTIONS = {
  'TEXT+class': async ({ ev, send, sleep }) => {
    const out = {};
    out.toolClicked = await clickLabel(ev, 'Highlight Span'); await sleep(500);
    const rect = await ev(`(()=>{const p=[...document.querySelectorAll('pre')].find(x=>x.innerText.includes('quick'));if(!p)return null;const r=document.createRange();const tn=[...p.querySelectorAll('*'),p].flatMap(n=>[...n.childNodes]).find(n=>n.nodeType===3&&n.textContent.includes('quick'));const i=tn.textContent.indexOf('quick');r.setStart(tn,i);r.setEnd(tn,i+5);const b=r.getBoundingClientRect();return {x:b.x,y:b.y+b.height/2,w:b.width}})()`);
    out.rect = rect;
    if (rect) { await mouse(send, 'mouseMoved', rect.x + 1, rect.y, { buttons: 0 }); await mouse(send, 'mousePressed', rect.x + 1, rect.y); await mouse(send, 'mouseMoved', rect.x + rect.w - 1, rect.y); await mouse(send, 'mouseReleased', rect.x + rect.w - 1, rect.y); await sleep(2500); }
    out.spanElements = await ev(`document.querySelectorAll('[data-annotation-id]').length`);
    out.panelText = await ev(`(()=>{const t=document.body.innerText;const i=t.indexOf('No spans yet');return {noSpansYet:i>=0}})()`);
    out.annotationsViaApi = await ev(`fetch(location.pathname.replace('/workspace/','/api/datasets/')+'/workspace-state').then(r=>r.status)`);
    return out;
  },
};
ACTIONS.VIDEO = async ({ ev, send, sleep, snap }) => {
  const out = {};
  out.video = await ev(`(()=>{const v=document.querySelector('video');if(!v)return null;return {readyState:v.readyState,duration:v.duration,error:v.error&&v.error.code,srcOrigin:v.currentSrc?new URL(v.currentSrc).origin:null,w:v.videoWidth,h:v.videoHeight,networkState:v.networkState}})()`);
  out.toolClicked = await clickLabel(ev, 'Bounding box'); await sleep(500);
  const frame = await ev(`(()=>{const f=document.querySelector('[data-video-frame]');const v=document.querySelector('video');if(!f||!v)return null;const r=v.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
  out.frame = frame;
  if (frame && frame.w > 0) { const x0 = frame.x + frame.w * 0.25, y0 = frame.y + frame.h * 0.25, x1 = frame.x + frame.w * 0.6, y1 = frame.y + frame.h * 0.6; await mouse(send, 'mouseMoved', x0, y0, { buttons: 0 }); await mouse(send, 'mousePressed', x0, y0); for (let i = 1; i <= 5; i++) await mouse(send, 'mouseMoved', x0 + (x1 - x0) * i / 5, y0 + (y1 - y0) * i / 5); await mouse(send, 'mouseReleased', x1, y1); await sleep(3000); }
  out.dialog = await ev(`(()=>{const d=document.querySelector('[role=dialog]')||[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='OK')?.closest('div[class*=fixed],div[class*=absolute],form,section');return d?{text:d.innerText.slice(0,300),inputs:[...d.querySelectorAll('input,select,textarea')].map(i=>({type:i.type,name:i.name||i.getAttribute('aria-label')||i.placeholder,options:i.tagName==='SELECT'?[...i.options].map(o=>o.text):undefined}))}:null})()`);
  const fill = async (idx, text) => { await ev(`(()=>{const d=[...document.querySelectorAll('input')];d[${idx}].focus();})()`); await send('Input.insertText', { text }); };
  const inputsBefore = await ev(`[...document.querySelectorAll('input')].filter(i=>/person-1|Track 1/.test(i.placeholder)).length`); out.inputsBefore = inputsBefore; out.okState = await ev(`(()=>{const b=[...document.querySelectorAll('button')].filter(x=>x.innerText.trim()==='OK');return b.map(x=>({disabled:x.disabled}))})()`);
  if (inputsBefore >= 2) { await ev(`(()=>{const d=[...document.querySelectorAll('input')].filter(i=>/person-1/.test(i.placeholder));d[0]&&d[0].focus()})()`); await send('Input.insertText', { text: 'obj-1' }); await ev(`(()=>{const d=[...document.querySelectorAll('input')].filter(i=>/Track 1/.test(i.placeholder));d[0]&&d[0].focus()})()`); await send('Input.insertText', { text: 'Track one' }); await sleep(300); out.okClicked = await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='OK'&&!x.disabled);if(!b)return false;b.click();return true})()`); await sleep(3500); }
  void fill;
  out.apiAfter = await ev(`fetch('/api/assets/'+new URLSearchParams(location.search).get('video')+'/video-annotations').then(async r=>({status:r.status,body:(await r.text()).slice(0,500)}))`);
  const after = await snap();
  out.afterButtons = after.toolbox.map(t => `${t.label}${t.disabled ? ':disabled' : ''}`);
  out.trackRows = await ev(`document.querySelectorAll('[aria-label*="track" i], [data-track-id]').length`);
  out.overlayBoxes = await ev(`document.querySelectorAll('[aria-label="Move keyframe"]').length`);
  return out;
};
const mediaState = async ({ ev, sleep }) => {
  const q = `fetch('/api/assets/'+new URLSearchParams(location.search).get('MOD')+'/media-processing/status').then(async r=>{const j=await r.json();return {status:r.status,state:j.data&&j.data.state,video:j.data&&j.data.video,audio:j.data&&j.data.audio}})`;
  return { q };
};
void mediaState;
const withMedia = (key, inner) => async (ctx) => {
  const out = inner ? await inner(ctx) : {};
  const states = [];
  for (let i = 0; i < 12; i++) { await ctx.sleep(2500); const st = await ctx.ev(`fetch('/api/assets/'+new URLSearchParams(location.search).get('${key}')+'/media-processing/status').then(async r=>{const j=await r.json();return {state:j.data&&j.data.state,fps:j.data&&j.data.video&&j.data.video.fps,durationMs:j.data&&(j.data.video||j.data.audio||{}).durationMs,waveformReady:j.data&&j.data.audio&&j.data.audio.waveformReady}})`); states.push(st); if (st.state === 'COMPLETED' || st.state === 'FAILED') break; }
  out.mediaProcessing = { final: states.at(-1), observedStates: [...new Set(states.map(x => x.state))] };
  return out;
};
ACTIONS.VIDEO = withMedia('video', ACTIONS.VIDEO);
ACTIONS.AUDIO = withMedia('audio', null);
const report = { runId, label: LABEL, results: [] };
const chrome = await launchChrome();
try {
  const user = await newUser('browser');
  const seeds = {};
  if (ONLY.includes('TEXT')) { seeds.TEXT = await seedTextLocal(user); seeds['TEXT+class'] = await seedTextLocal(user, ['Animal']); }
  if (ONLY.includes('VIDEO')) seeds.VIDEO = await seedRepo(user, 'VIDEO', [mediaFile('v.mp4', 'video/mp4'), mediaFile('v.webm', 'video/webm')]);
  if (ONLY.includes('IMAGE')) { const c = await api(user.cookie, 'POST', '/api/datasets', { name: `br-img-${randomBytes(2).toString('hex')}`, modality: 'IMAGE' }); seeds.IMAGE = c.json.data.id; }
  if (ONLY.includes('AUDIO')) seeds.AUDIO = await seedRepo(user, 'AUDIO', [mediaFile('a.wav', 'audio/wav')]);
  for (const [m, datasetId] of Object.entries(seeds)) {
    const asset = sql(`select id from "Asset" where "datasetId"='${sid(datasetId)}' order by "createdAt" limit 1`);
    const url = `${ORIGIN}/workspace/${datasetId}${asset ? `?${m.split('+')[0].toLowerCase()}=${asset}` : ''}`;
    report.results.push({ modality: m, datasetId: sid(datasetId).slice(0, 8), assetPersisted: Boolean(asset), ...await inspect(chrome, user, url, m, ACTIONS[m]) });
    console.log(`${m}: disabled=${JSON.stringify(report.results.at(-1).first.toolbox.filter(t=>t.disabled).map(t=>t.label))} tools=${JSON.stringify(report.results.at(-1).first.tools)} console=${report.results.at(-1).console.length} failed=${report.results.at(-1).failedRequests.length} http4xx=${report.results.at(-1).http4xx.length}`);
  }
  // Dataset A -> Dataset B client-side navigation: no engine/toolbox state may leak from the previous Dataset.
  const order = ['IMAGE', 'VIDEO', 'TEXT', 'AUDIO', 'TEXT'].filter(m => seeds[m]); report.navigation = [];
  if (order.length >= 3) {
    const nav = async (m) => { const asset = sql(`select id from "Asset" where "datasetId"='${sid(seeds[m])}' order by "createdAt" limit 1`); const target = `/workspace/${seeds[m]}${asset ? `?${m.toLowerCase()}=${asset}` : ''}`; return target; };
    const first = await nav(order[0]);
    const r0 = await inspect(chrome, user, `${ORIGIN}${first}`, 'nav-start', async ({ ev, sleep }) => {
      const steps = [];
      for (const m of order.slice(1)) {
        const target = await nav(m);
        const pushed = await ev(`(()=>{try{window.next.router.push(${JSON.stringify(target)});return true}catch(e){return String(e)}})()`);
        await sleep(5000);
        steps.push({ to: m, pushed, tools: await ev(`[...document.querySelectorAll('[aria-label$=" annotation tools"]')].map(e=>e.getAttribute('aria-label'))`), path: await ev(`location.pathname`), branch: await ev(`(document.body.innerText.match(/(\\w+) workspace/)||[])[1]`) });
      }
      return { steps };
    });
    report.navigation = { from: order[0], order, steps: r0.extra?.steps };
  }
} catch (e) { report.fatal = String(e.stack ?? e).split('\n').slice(0, 3).join(' | '); console.error(report.fatal); }
chrome.close();
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const f = path.join(outDir, 'browser-audit.json'); writeFileSync(f, JSON.stringify(report, null, 2) + '\n', { mode: 0o400 }); try { chmodSync(f, 0o400); } catch { /* */ }
console.log('report:', outDir);
