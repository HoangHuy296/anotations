#!/usr/bin/env node
// Real MVP aidetect end-to-end proof (no mocks): aidetect -> /api/ai/models -> local registration -> select -> task -> queue -> worker -> canonical provider.
// Prints/records only non-secret evidence (ids, statuses, error codes). Presigned URLs, cookies, passwords and the provider key never appear.
//   node scripts/mvp/acceptance/aidetect-e2e.mjs [--web http://127.0.0.1:3000]
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const WEB = args.web ?? 'http://127.0.0.1:3000';
const CANON = 'http://10.0.0.186:7000', KEY = '68d7f474-6982-446c-8c5a-121d56d12dc9';
const runId = `aidetect-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')}`;
const outDir = path.join(import.meta.dirname, '../../../specs/029-modality-specific-datasets/verification/mvp-aioz', runId);
const ev = { runId, startedAt: new Date().toISOString(), steps: [], boundary: null };
const step = (id, pass, detail) => { ev.steps.push({ id, pass: Boolean(pass), detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}`); return pass; };
const sql = q => execFileSync('docker', ['exec', 'phase029-g1-main-postgres', 'psql', '-U', 'postgres', '-d', 'fieldframe', '-tAc', q], { encoding: 'utf8' }).trim();
const sha256 = b => createHash('sha256').update(b).digest('hex');
function crc32(buf) { let c, crc = ~0; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
function png(w, h) { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; const raw = Buffer.alloc(h * (1 + w * 3)); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (1 + w * 3) + 1 + x * 3; raw[o] = (x * 255 / w) | 0; raw[o + 1] = (y * 255 / h) | 0; raw[o + 2] = 128; } return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }

let cookie = '';
const req = async (method, url, body) => { const res = await fetch(WEB + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }); const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ } return { status: res.status, json }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function finish() {
  ev.finishedAt = new Date().toISOString(); mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const f = path.join(outDir, 'aidetect-e2e.json'); writeFileSync(f, JSON.stringify(ev, null, 2) + '\n', { mode: 0o400 }); try { chmodSync(f, 0o400); } catch { /* */ }
  console.log(JSON.stringify({ out: outDir, boundary: ev.boundary, task: ev.task }, null, 2));
  process.exit(ev.boundary ? 1 : 0);
}
try {
  // --- user + IMAGE dataset with one real PNG through the real local-folder path
  const email = `aidetect-${randomBytes(4).toString('hex')}@example.test`, password = randomBytes(12).toString('hex') + 'Aa1!';
  await req('POST', '/api/auth/signup', { email, password, name: 'aidetect', role: 'MANAGER' });
  const login = await fetch(WEB + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  cookie = (login.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
  const bytes = png(320, 240);
  const manifest = [{ logicalPath: 'd/e2e.png', contentType: 'image/png', sizeBytes: bytes.length, fingerprint: sha256(bytes) }];
  const start = await req('POST', '/api/imports/local-folder', { name: `aidetect-e2e-${randomBytes(2).toString('hex')}`, modality: 'IMAGE', idempotencyKey: `e2e-${randomUUID()}`, items: manifest });
  const prep = start.json?.data?.preparation, datasetId = prep?.datasetId;
  if (!step('image-dataset-created', Boolean(datasetId) && start.json?.data?.dataset?.modality === 'IMAGE', { status: start.status, dataset: start.json?.data?.dataset })) { ev.boundary = 'FIXTURE:dataset'; await finish(); }
  const caps = await req('POST', `/api/imports/${prep.id}/upload-capabilities`, { itemIds: prep.items.map(i => i.id) });
  const cap = caps.json?.data?.capabilities?.[0];
  const form = new FormData(); for (const [k, v] of Object.entries(cap.formFields)) form.append(k, v); form.append('file', new Blob([bytes], { type: 'image/png' }), 'f');
  const up = await fetch(cap.uploadUrl, { method: 'POST', body: form });
  const done = await req('POST', `/api/imports/${prep.id}/items/${prep.items[0].id}/complete`, { fileId: cap.fileId });
  await req('POST', `/api/jobs/${prep.jobId}/commit-import`);
  const assetId = done.json?.data?.assetId;
  if (!step('real-image-asset-published', up.status < 300 && Boolean(assetId), { upload: up.status, complete: done.status })) { ev.boundary = 'FIXTURE:asset'; await finish(); }

  // --- discovery (exactly what aidetect calls)
  const models = await req('GET', '/api/ai/models?modality=IMAGE&task_name=detection');
  const model = models.json?.data?.models?.find(m => m.key === KEY);
  step('discovery-returns-canonical-model', models.status === 200 && Boolean(model), { status: models.status, count: models.json?.data?.models?.length, model: model && { id: model.id, key: model.key, displayName: model.displayName, taskType: model.taskType, availableForTasks: model.availableForTasks } });
  if (!model) { ev.boundary = 'DISCOVERY'; await finish(); }
  if (!step('model-available-via-active-local-registration', model.availableForTasks === true, { availableForTasks: model.availableForTasks })) { ev.boundary = 'AVAILABILITY_FILTER/LOCAL_REGISTRATION'; await finish(); }
  step('local-registration-key-equals-provider-uuid', sql(`select count(*) from "AiModel" where id='${model.id.replace(/[^A-Za-z0-9-]/g, '')}' and key='${KEY}' and provider='aioz-company' and "isActive"`) === '1', { modelId: model.id });

  // --- task creation (quoting the preview first as the UI does is optional; creation is the contract)
  const created = await req('POST', '/api/ai/tasks', { datasetId, modelId: model.id, target: { mode: 'CURRENT_ASSET', assetId } });
  const taskId = created.json?.data?.taskId ?? created.json?.data?.id ?? created.json?.data?.aiTaskId ?? created.json?.data?.task?.id;
  ev.createResponse = { status: created.status, keys: Object.keys(created.json?.data ?? {}), error: created.json?.error?.code };
  if (!step('task-created', created.status >= 200 && created.status < 300 && Boolean(taskId), ev.createResponse)) { ev.boundary = 'TASK_CREATION'; await finish(); }

  // --- queue, worker, provider
  let task = null;
  for (let i = 0; i < 90; i++) { task = (await req('GET', `/api/ai/tasks/${taskId}`)).json?.data; if (task && ['SUCCEEDED', 'COMPLETED', 'FAILED', 'CANCELLED', 'PARTIAL'].includes(task.status)) break; await sleep(2000); }
  const row = JSON.parse(sql(`select coalesce(row_to_json(t)::text,'{}') from "AiTask" t where id='${String(taskId).replace(/[^A-Za-z0-9-]/g, '')}'`) || '{}');
  const safe = Object.fromEntries(Object.entries(row).filter(([k]) => /^(status|externalTaskId|errorCode|provider|attempts|modelId|datasetId|jobId|startedAt|finishedAt|createdAt)$/.test(k)));
  const job = sql(`select status||'|'||coalesce("errorCode",'') from "Job" where id='${String(row.jobId ?? '').replace(/[^A-Za-z0-9-]/g, '')}'`);
  ev.task = { id: taskId, apiStatus: task?.status, db: safe, job };
  step('task-reached-a-terminal-state', Boolean(task && ['SUCCEEDED', 'COMPLETED', 'FAILED', 'CANCELLED', 'PARTIAL'].includes(task.status)), { status: task?.status });
  step('worker-submitted-to-canonical-provider-external-id-persisted', Boolean(row.externalTaskId), { externalTaskIdPresent: Boolean(row.externalTaskId) });
  step('discovery-and-execution-same-provider-uuid', sql(`select count(*) from "AiTask" t join "AiModel" m on m.id=t."modelId" where t.id='${String(taskId).replace(/[^A-Za-z0-9-]/g, '')}' and m.key='${KEY}'`) === '1', { providerUuid: KEY, endpoint: CANON });
  if (!['SUCCEEDED', 'COMPLETED'].includes(task?.status)) ev.boundary = row.externalTaskId ? 'PROVIDER_RESPONSE/RESULT_HANDLING' : (job.startsWith('QUEUED') ? 'QUEUE_TRANSPORT' : 'WORKER_SUBMISSION');
} catch (error) { ev.boundary = ev.boundary ?? `HARNESS:${error.message}`; }
await finish();
