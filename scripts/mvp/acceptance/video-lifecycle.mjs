#!/usr/bin/env node
// VIDEO annotation lifecycle through the real HTTP runtime on a repository-ingested VIDEO Dataset: track + keyframes, revision-guarded updates,
// stale-revision rejection, interpolation read-back, delete. Prints statuses/revisions only.
//   NODE_EXTRA_CA_CERTS=<tls>/gitea.crt node scripts/mvp/acceptance/video-lifecycle.mjs --media <dir>
import { execFileSync } from 'node:child_process'; import { randomBytes, randomUUID } from 'node:crypto'; import { readFileSync } from 'node:fs'; import path from 'node:path';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const WEB = 'http://127.0.0.1:3300', G = 'https://localhost:3310', out = [];
const rec = (id, pass, observed) => { out.push({ id, pass: Boolean(pass), observed }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(observed)}`); };
let cookie = ''; const j = async (m, u, b) => { const r = await fetch((u.startsWith('http') ? u : WEB + u), { method: m, headers: { ...(cookie ? { cookie } : {}), ...(b ? { 'content-type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let x = null; try { x = JSON.parse(t); } catch { /* */ } return { status: r.status, json: x }; };
const sql = q => execFileSync('docker', ['exec', 'phase029-g1-mvp-postgres', 'psql', '-U', 'postgres', '-d', 'fieldframe', '-tAc', q], { encoding: 'utf8' }).trim();
const email = `vl-${randomBytes(3).toString('hex')}@example.test`, password = randomBytes(10).toString('hex') + 'Aa1!';
await j('POST', '/api/auth/signup', { email, password, role: 'MANAGER', name: 'vl' }); const l = await fetch(WEB + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }); cookie = l.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const gu = 'vl' + randomBytes(3).toString('hex'), gp = randomBytes(10).toString('hex') + 'Aa1!'; execFileSync('docker', ['exec', '-u', 'git', 'annotationplatformmvp-gitea-1', 'gitea', 'admin', 'user', 'create', '--admin', '--username', gu, '--password', gp, '--email', gu + '@example.test', '--must-change-password=false'], { stdio: 'pipe' });
const g = async (m, p, b) => (await fetch(G + '/api/v1' + p, { method: m, headers: { authorization: 'Basic ' + Buffer.from(gu + ':' + gp).toString('base64'), 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).status;
await g('POST', '/user/repos', { name: 'vl', private: false, auto_init: true, default_branch: 'main' }); await g('POST', `/repos/${gu}/vl/contents/data/v.mp4`, { content: readFileSync(path.join(args.media, 'v.mp4')).toString('base64'), message: 'a', branch: 'main' });
const imp = await j('POST', '/api/datasets/from-repository', { modality: 'VIDEO', provider: 'GITEA', credentialMode: 'PUBLIC', serverUrl: 'https://gitea:3000', repository: { owner: gu, name: 'vl', ref: 'main', expectedVisibility: 'PUBLIC', rootPath: 'data' }, datasetName: 'vl', idempotencyKey: 'v-' + randomUUID() });
for (let i = 0; i < 40; i++) { const jb = (await j('GET', '/api/jobs/' + imp.json.data.job.id)).json?.data; if (jb && ['COMPLETED', 'FAILED'].includes(jb.status)) break; await new Promise(r => setTimeout(r, 1500)); }
const asset = sql(`select id from "Asset" where "datasetId"='${imp.json.data.dataset.id}' limit 1`);
await j('POST', `/api/assets/${asset}/media-processing`, { type: 'EXTRACT_VIDEO_METADATA' }); for (let i = 0; i < 30; i++) { const s = (await j('GET', `/api/assets/${asset}/media-processing/status`)).json?.data; if (s?.state === 'COMPLETED') { rec('metadata-probed', s.video?.fps === 10 && s.video?.durationMs === 2000, s.video); break; } await new Promise(r => setTimeout(r, 1500)); }
const box = (x, y) => ({ kind: 'BOUNDING_BOX', x, y, width: 0.3, height: 0.3 });
const tr = await j('POST', `/api/assets/${asset}/video-object-tracks`, { name: 'T1', properties: { objectId: 'o1' } }); console.log('TRACK_SHAPE', JSON.stringify(tr.json).slice(0, 400)); const track = tr.json?.data?.track ?? tr.json?.data; rec('track-created', tr.status === 201 && track?.revision >= 1, { status: tr.status, revision: track?.revision });
let rev = track.revision;
const k1 = await j('POST', `/api/video-object-tracks/${track.id}/keyframes`, { expectedTrackRevision: rev, timestampMs: 0, geometry: box(0.1, 0.1) }); rec('keyframe-0-created', k1.status === 201, { status: k1.status, trackRevision: k1.json?.data?.trackRevision ?? k1.json?.data?.track?.revision });
rev = k1.json?.data?.trackRevision ?? k1.json?.data?.track?.revision ?? rev + 1;
const k2 = await j('POST', `/api/video-object-tracks/${track.id}/keyframes`, { expectedTrackRevision: rev, timestampMs: 1000, geometry: box(0.5, 0.5) }); rec('keyframe-1000-created', k2.status === 201, { status: k2.status });
const afterTwo = (await j('GET', `/api/assets/${asset}/video-annotations`)).json?.data; rev = afterTwo.tracks[0].revision;
rec('read-back-tracks-keyframes-interpolation', afterTwo.tracks.length === 1 && afterTwo.keyframes.length === 2 && Array.isArray(afterTwo.interpolation), { tracks: afterTwo.tracks.length, keyframes: afterTwo.keyframes.length, trackRevision: rev, interpolation: afterTwo.interpolation.length });
const kid = afterTwo.keyframes[0].id;
const upd = await j('PATCH', `/api/video-keyframes/${kid}`, { expectedTrackRevision: rev, geometry: box(0.2, 0.2) }); rec('keyframe-update-with-current-revision', upd.status === 200, { status: upd.status });
const stale = await j('PATCH', `/api/video-keyframes/${kid}`, { expectedTrackRevision: rev, geometry: box(0.3, 0.3) }); rec('stale-revision-rejected', stale.status === 409, { status: stale.status, code: stale.json?.error?.code });
const cur = (await j('GET', `/api/assets/${asset}/video-annotations`)).json?.data; rev = cur.tracks[0].revision;
const tu = await j('PATCH', `/api/video-object-tracks/${track.id}`, { expectedTrackRevision: rev, name: 'T1-renamed', interpolationMode: 'NONE' }); rec('track-update', tu.status === 200, { status: tu.status });
const cur2 = (await j('GET', `/api/assets/${asset}/video-annotations`)).json?.data; rev = cur2.tracks[0].revision;
const dk = await j('DELETE', `/api/video-keyframes/${cur2.keyframes[1].id}`, { expectedTrackRevision: rev }); rec('keyframe-delete', dk.status === 200 || dk.status === 204, { status: dk.status });
const cur3 = (await j('GET', `/api/assets/${asset}/video-annotations`)).json?.data; rev = cur3.tracks[0].revision;
const dt = await j('DELETE', `/api/video-object-tracks/${track.id}`, { expectedTrackRevision: rev }); rec('track-delete', dt.status === 200 || dt.status === 204, { status: dt.status });
rec('empty-after-delete', (await j('GET', `/api/assets/${asset}/video-annotations`)).json?.data?.tracks?.length === 0, {});
console.log(`${out.filter(o => o.pass).length}/${out.length} pass`);
