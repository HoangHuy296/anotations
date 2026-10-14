#!/usr/bin/env node
// Phase029 MVP: TEXT / VIDEO (plus IMAGE / AUDIO controls) creation -> ingestion -> persistence -> workspace -> engine -> toolbox audit through the real HTTP runtime.
// Records a per-boundary matrix; prints no secret. Fixtures: scratch media generated with the worker's ffmpeg (see MEDIA_DIR).
//   NODE_EXTRA_CA_CERTS=<tls>/gitea.crt node scripts/mvp/acceptance/modality-engines.mjs --label red|green --media <dir>
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const LABEL = args.label ?? 'run', WEB = args.web ?? 'http://127.0.0.1:3000', MEDIA = args.media;
const GITEA = 'https://localhost:3310', GITEA_INTERNAL = 'https://gitea:3000';
const runId = `${LABEL}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')}`;
const outDir = path.join(import.meta.dirname, '../../../specs/029-modality-specific-datasets/verification/mvp-engines', runId);
const rows = [];
const rec = (modality, path_, boundary, pass, observed) => { rows.push({ modality, path: path_, boundary, pass: Boolean(pass), observed }); console.log(`${pass ? 'PASS' : 'FAIL'} ${modality}/${path_}/${boundary}`); };
const sql = q => execFileSync('docker', ['exec', 'phase029-g1-main-postgres', 'psql', '-U', 'postgres', '-d', 'fieldframe', '-tAc', q], { encoding: 'utf8' }).trim();
const id = v => String(v).replace(/[^A-Za-z0-9-]/g, '');
const sha = b => createHash('sha256').update(b).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function crc32(buf) { let c, crc = ~0; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
const png = () => { const ih = Buffer.alloc(13); ih.writeUInt32BE(8, 0); ih.writeUInt32BE(8, 4); ih[8] = 8; ih[9] = 2; const raw = Buffer.alloc(8 * 25, 7); return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); };
const FILES = {
  IMAGE: [{ name: 'a.png', type: 'image/png', bytes: png() }],
  AUDIO: [{ name: 'a.wav', type: 'audio/wav', bytes: MEDIA ? readFileSync(path.join(MEDIA, 'a.wav')) : Buffer.alloc(0) }],
  VIDEO: MEDIA ? [{ name: 'v.mp4', type: 'video/mp4', bytes: readFileSync(path.join(MEDIA, 'v.mp4')) }, { name: 'v.webm', type: 'video/webm', bytes: readFileSync(path.join(MEDIA, 'v.webm')) }] : [],
  TEXT: [{ name: 'a.txt', type: 'text/plain', bytes: Buffer.from('The quick brown fox jumps over the lazy dog.\nSecond line of text.\n') }, { name: 'b.csv', type: 'text/csv', bytes: Buffer.from('id,text\n1,hello world\n2,second row\n') }, { name: 'c.json', type: 'application/json', bytes: Buffer.from('{"text":"hello json","n":1}\n') }],
};
const TOOLS = { IMAGE: 'Image annotation tools', VIDEO: 'Video annotation tools', AUDIO: 'Audio annotation tools', TEXT: 'Text annotation tools' };

class S {
  constructor(l) { this.l = l; this.cookie = ''; }
  async req(m, u, body) { const res = await fetch(u.startsWith('http') ? u : WEB + u, { method: m, headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }); const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ } return { status: res.status, json, text }; }
  async login() { const email = `eng-${this.l}-${randomBytes(3).toString('hex')}@example.test`, password = randomBytes(10).toString('hex') + 'Aa1!'; await this.req('POST', '/api/auth/signup', { email, password, role: 'MANAGER', name: this.l }); const r = await fetch(WEB + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }); this.cookie = (r.headers.getSetCookie() || []).map(c => c.split(';')[0]).join('; '); return this; }
}
async function putMinio(cap, file) { const f = new FormData(); for (const [k, v] of Object.entries(cap.formFields)) f.append(k, v); f.append('file', new Blob([file.bytes], { type: file.type }), 'f'); return (await fetch(cap.uploadUrl, { method: 'POST', body: f })).status; }
const assetsOf = d => JSON.parse(sql(`select coalesce(json_agg(json_build_object('id',id,'modality',modality::text,'mime',"mimeType") order by "createdAt"),'[]'::json) from "Asset" where "datasetId"='${id(d)}'`));
const dsModality = d => sql(`select modality::text from "Dataset" where id='${id(d)}'`);

async function workspaceChecks(s, modality, path_, datasetId) {
  const assets = assetsOf(datasetId);
  rec(modality, path_, 'persisted-dataset-modality', dsModality(datasetId) === modality, { dataset: dsModality(datasetId) });
  rec(modality, path_, 'persisted-asset-modality-equals-dataset', assets.length > 0 && assets.every(a => a.modality === modality), { assets: assets.map(a => `${a.modality}:${a.mime}`) });
  const st = await s.req('GET', `/api/datasets/${datasetId}/workspace-state`);
  rec(modality, path_, 'workspace-state-api', st.status === 200 && st.json?.data?.modality === modality, { status: st.status, modality: st.json?.data?.modality });
  const asset = assets[0]; if (!asset) return;
  const key = modality.toLowerCase();
  const page = await s.req('GET', `/workspace/${datasetId}?${key}=${asset.id}`);
  rec(modality, path_, 'workspace-page-selected-asset-200', page.status === 200, { status: page.status });
  rec(modality, path_, 'engine-and-toolbox-from-dataset-modality', page.text.includes(TOOLS[modality]) && !Object.entries(TOOLS).some(([m, t]) => m !== modality && page.text.includes(t)), { has: Object.entries(TOOLS).filter(([, t]) => page.text.includes(t)).map(([m]) => m) });
  const other = modality === 'IMAGE' ? 'VIDEO' : 'IMAGE';
  const forged = await s.req('GET', `/workspace/${datasetId}?${key}=${asset.id}&modality=${other}&engine=${other}&filterModality=${other}`);
  rec(modality, path_, 'forged-query-hints-cannot-switch-engine', forged.status === 200 && forged.text.includes(TOOLS[modality]) && !forged.text.includes(TOOLS[other]), { status: forged.status });
  const crossKey = await s.req('GET', `/workspace/${datasetId}?${other.toLowerCase()}=${asset.id}`);
  rec(modality, path_, 'asset-hint-under-another-modality-key-cannot-switch-engine', crossKey.status !== 200 || (crossKey.text.includes(TOOLS[modality]) && !crossKey.text.includes(TOOLS[other])), { status: crossKey.status });
  return { asset };
}

async function pathLocalFolder(modality) {
  const s = await new S('lf-' + modality).login(), files = FILES[modality];
  if (!files.length) { rec(modality, 'local-folder', 'fixture', false, 'no fixture'); return; }
  const items = files.map(f => ({ logicalPath: `d/${f.name}`, contentType: f.type, sizeBytes: f.bytes.length, fingerprint: sha(f.bytes) }));
  const start = await s.req('POST', '/api/imports/local-folder', { name: `eng-lf-${modality}-${randomBytes(2).toString('hex')}`, modality, idempotencyKey: `e-${randomUUID()}`, items });
  rec(modality, 'local-folder', 'dataset-creation', [200, 201, 202].includes(start.status), { status: start.status, code: start.json?.error?.code });
  const prep = start.json?.data?.preparation; if (!prep) return;
  const caps = await s.req('POST', `/api/imports/${prep.id}/upload-capabilities`, { itemIds: prep.items.map(i => i.id) });
  const results = [];
  for (let i = 0; i < prep.items.length; i++) {
    const cap = caps.json?.data?.capabilities?.find(c => c.itemId === prep.items[i].id);
    const up = await putMinio(cap, files[i]);
    const done = await s.req('POST', `/api/imports/${prep.id}/items/${prep.items[i].id}/complete`, { fileId: cap.fileId });
    results.push({ file: files[i].name, upload: up, status: done.status, code: done.json?.error?.code ?? null });
  }
  rec(modality, 'local-folder', 'upload-verification-all-fixtures-accepted', results.every(r => r.status >= 200 && r.status < 300), results);
  const commit = await s.req('POST', `/api/jobs/${prep.jobId}/commit-import`);
  rec(modality, 'local-folder', 'ingestion-commit', commit.status === 200, { status: commit.status, code: commit.json?.error?.code });
  await workspaceChecks(s, modality, 'local-folder', prep.datasetId);
}

async function pathDirectUpload(modality) {
  const s = await new S('du-' + modality).login(), files = FILES[modality];
  if (!files.length) return;
  const created = await s.req('POST', '/api/datasets', { name: `eng-du-${modality}-${randomBytes(2).toString('hex')}`, modality });
  const datasetId = created.json?.data?.id;
  rec(modality, 'direct-upload', 'dataset-creation', created.status === 201 && created.json?.data?.modality === modality, { status: created.status, modality: created.json?.data?.modality });
  const results = [];
  for (const f of files) {
    const pre = await s.req('POST', '/api/assets/presigned-upload', { datasetId, filename: f.name, contentType: f.type, sizeBytes: f.bytes.length });
    const d = pre.json?.data;
    if (!d?.uploadUrl && !d?.upload?.uploadUrl) { results.push({ file: f.name, stage: 'presign', status: pre.status, code: pre.json?.error?.code, keys: Object.keys(d ?? {}) }); continue; }
    const cap = d.upload ?? d;
    const up = await putMinio({ uploadUrl: cap.uploadUrl, formFields: cap.formFields }, f);
    const done = await s.req('POST', '/api/assets/complete-upload', { fileId: cap.fileId ?? d.fileId });
    results.push({ file: f.name, upload: up, status: done.status, code: done.json?.error?.code ?? null });
  }
  rec(modality, 'direct-upload', 'upload-verification-all-fixtures-accepted', results.every(r => r.status >= 200 && r.status < 300), results);
  await workspaceChecks(s, modality, 'direct-upload', datasetId);
}

// ---- repository import (Gitea fixture)
const gt = { user: `eng${randomBytes(3).toString('hex')}`, pass: randomBytes(10).toString('hex') + 'Aa1!' };
async function gitea(m, p, body) { const r = await fetch(GITEA + '/api/v1' + p, { method: m, headers: { authorization: 'Basic ' + Buffer.from(`${gt.user}:${gt.pass}`).toString('base64'), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null }; }
async function pathRepository(modality) {
  const files = FILES[modality]; if (!files.length) return;
  const name = `eng-${modality.toLowerCase()}`;
  await gitea('POST', '/user/repos', { name, private: false, auto_init: true, default_branch: 'main' });
  for (const f of files) await gitea('POST', `/repos/${gt.user}/${name}/contents/data/${f.name}`, { content: f.bytes.toString('base64'), message: 'add', branch: 'main' });
  const s = await new S('repo-' + modality).login();
  const body = { modality, provider: 'GITEA', credentialMode: 'PUBLIC', serverUrl: GITEA_INTERNAL, repository: { owner: gt.user, name, ref: 'main', expectedVisibility: 'PUBLIC', rootPath: 'data' }, datasetName: `eng-repo-${modality}`, idempotencyKey: `r-${randomUUID()}` };
  const pre = await s.req('POST', '/api/source-import-preflight', { provider: 'GITEA', modality, datasetName: body.datasetName, credentialMode: 'PUBLIC', serverUrl: GITEA_INTERNAL, repository: { owner: gt.user, repo: name, ref: 'main', rootPath: 'data', expectedVisibility: 'PUBLIC' } });
  rec(modality, 'repository', 'preflight', pre.status === 200 && pre.json?.data?.assetPreview?.detectedAssetCount === files.length, { status: pre.status, code: pre.json?.error?.code, detected: pre.json?.data?.assetPreview?.detectedAssetCount, expected: files.length });
  const r = await s.req('POST', '/api/datasets/from-repository', body);
  rec(modality, 'repository', 'dataset-creation', r.status === 202 && r.json?.data?.dataset?.modality === modality, { status: r.status, code: r.json?.error?.code, modality: r.json?.data?.dataset?.modality });
  const datasetId = r.json?.data?.dataset?.id, jobId = r.json?.data?.job?.id; if (!jobId) return;
  let job = null; for (let i = 0; i < 90; i++) { job = (await s.req('GET', `/api/jobs/${jobId}`)).json?.data; if (job && ['COMPLETED', 'FAILED', 'CANCELLED', 'PARTIAL'].includes(job.status)) break; await sleep(2000); }
  rec(modality, 'repository', 'ingestion-job-completes', job?.status === 'COMPLETED', { status: job?.status, code: job?.errorCode, summary: job?.summary });
  await workspaceChecks(s, modality, 'repository', datasetId);
}

try {
  // empty-dataset engine/toolbox matrix first (no ingestion involved)
  const s = await new S('empty').login();
  for (const m of ['IMAGE', 'VIDEO', 'AUDIO', 'TEXT']) {
    const c = await s.req('POST', '/api/datasets', { name: `eng-empty-${m}-${randomBytes(2).toString('hex')}`, modality: m });
    const p = await s.req('GET', `/workspace/${c.json.data.id}`);
    rec(m, 'empty-dataset', 'engine-and-toolbox', p.status === 200 && p.text.includes(TOOLS[m]) && !Object.entries(TOOLS).some(([k, t]) => k !== m && p.text.includes(t)), { status: p.status });
  }
  for (const m of ['TEXT', 'VIDEO', 'IMAGE', 'AUDIO']) { await pathLocalFolder(m); await pathDirectUpload(m); }
} catch (e) { rec('HARNESS', 'fatal', 'error', false, String(e.message).slice(0, 200)); }
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const f = path.join(outDir, 'engines.json'); writeFileSync(f, JSON.stringify({ runId, rows }, null, 2) + '\n', { mode: 0o400 }); try { chmodSync(f, 0o400); } catch { /* */ }
console.log(`\n${rows.filter(r => r.pass).length}/${rows.length} pass -> ${outDir}`);
