import "../../../scripts/db-safety/deny-entry.cjs"; // G1: this writer has no approved operation scope.
/* eslint-disable @typescript-eslint/no-explicit-any -- Local CDP protocol harness; never application DTOs. */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { db } from '@/lib/db';
import { getWebProviders } from '@/lib/providers';
import assert from 'node:assert/strict';
import { requestVisualizationProcessing } from '@/lib/visualization/processing-service';
import { readSnapshotContent, artifactBytes } from '@/lib/visualization/snapshot-read';
import { createFoundationWorker } from '../../worker/src/queue/bullmq-worker';
import { createWorkerJobRedeliverer } from '../../worker/src/queue/redeliver-job';
import { createQueueTransport } from '@annotationplatform/queue';
async function main() {
  const { minio, config } = getWebProviders();
  const marker = randomUUID();
  const isolatedConfig = { ...config, BULLMQ_PREFIX: `visualization-smoke-${marker}` };
  const transport = createQueueTransport({ host: config.REDIS_HOST, port: config.REDIS_PORT, password: config.REDIS_PASSWORD, db: config.REDIS_DB, prefix: isolatedConfig.BULLMQ_PREFIX });
  const runtime = createFoundationWorker({ config: isolatedConfig, db, workerId: 'visualization-browser-smoke' });
  const options = { createQueue: () => ({ queue: transport, close: async () => {} }) };
  const awaitJob = async (id: string) => {
    for (let i = 0; i < 120; i++) {
      const job = await db.job.findUniqueOrThrow({ where: { id }, select: { status: true } });
      if (job.status === 'COMPLETED') return;
      if (job.status === 'FAILED') throw new Error('Processing failed');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('Processing timed out');
  };
  const captureAndDerive = async (actor: any, id: string) => {
    const result = await requestVisualizationProcessing(actor, id, undefined, options); assert.ok(result.ok);
    const delivery = await transport.getJob(result.job.id); assert.deepEqual(delivery?.data, { jobId: result.job.id });
    await awaitJob(result.job.id);
    const current = await db.dataset.findUniqueOrThrow({ where: { id } });
    const derive = await db.job.findFirstOrThrow({ where: { datasetId: id, type: 'VISUALIZATION_DERIVE', input: { path: ['snapshotId'], equals: current.visualizationCurrentSnapshotId! } } });
    await createWorkerJobRedeliverer(db, transport)(derive.id); await awaitJob(derive.id);
    return current.visualizationCurrentSnapshotId!;
  };
  const key = `visualization-test/${marker}.png`;
  let userId: string | undefined, datasetId: string | undefined;
  let ws: WebSocket | undefined;
  let step = 'prepare fixture';
  try {
    const png = await readFile(new URL('../tests/fixtures/visualization.png', import.meta.url));
    await minio.putObject(config.MINIO_BUCKET, key, png, png.length, { 'Content-Type': 'image/png' });
    const user = await db.user.create({ data: { email: `vis4-browser-${marker}@test.invalid`, name: 'Visualization smoke', role: 'MANAGER' } }); userId = user.id;
    const dataset = await db.dataset.create({ data: { ownerId: user.id, name: 'Visualization image smoke', metadata: { workflowStatus: 'COMPLETED' } } }); datasetId = dataset.id;
    const asset = await db.asset.create({ data: { datasetId, modality: 'IMAGE', filename: 'smoke.png', mimeType: 'image/png', width: 200, height: 100, storageProvider: 'MINIO', storageBucket: config.MINIO_BUCKET, storageKey: key, sourceFingerprint: marker } });
    const label = await db.label.create({ data: { datasetId, name: 'Object', normalizedName: 'object', color: '#e11d48' } });
    const annotation = await db.annotation.create({ data: { datasetId, assetId: asset.id, createdById: user.id, modality: 'IMAGE', type: 'BOUNDING_BOX', labelId: label.id, geometry: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } } });
    step = 'first snapshot and derived artifacts through real BullMQ';
    const firstSnapshotId = await captureAndDerive({ ...user, name: user.name! }, datasetId);
    const frozen = await readSnapshotContent(datasetId, firstSnapshotId, 1, 20);
    const sourceCopy = await db.visualizationArtifact.findFirstOrThrow({ where: { datasetId, snapshotId: firstSnapshotId, kind: 'SOURCE_IMAGE' } });
    const frozenBytes = await artifactBytes(sourceCopy);
    const token = randomBytes(32).toString('hex');
    await db.authSession.create({ data: { userId, refreshTokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 600000) } });
    const targets = await (await fetch('http://localhost:9227/json/list')).json();
    ws = new WebSocket(targets.find((x: { type: string }) => x.type === 'page').webSocketDebuggerUrl);
    await new Promise<void>(resolve => ws!.addEventListener('open', () => resolve(), { once: true }));
    let n = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const requests: string[] = [];
    ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) { const request = pending.get(message.id); pending.delete(message.id); if (message.error) request?.reject(new Error('Browser protocol error')); else request?.resolve(message.result); }
      if (message.method === 'Network.requestWillBeSent' && message.params.request.url.startsWith('http://localhost:3107/api/')) requests.push(message.params.request.method);
    });
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression: string) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
    const waitFor = async (expression: string) => { for (let i = 0; i < 80; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 250)); } throw new Error('Browser assertion timeout'); };
    await send('Page.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Network.setCookie', { name: 'fieldframe_session', value: token, url: 'http://localhost:3107', httpOnly: true, sameSite: 'Lax' });
    step = 'catalog navigation';
    await send('Page.navigate', { url: 'http://localhost:3107/datasets' });
    await waitFor(`!!document.querySelector('a[href="/datasets/visualize/${datasetId}"]')`);
    await evaluate(`document.querySelector('a[href="/datasets/visualize/${datasetId}"]').click()`);
    await waitFor(`location.pathname === '/datasets/visualize/${datasetId}' && !!document.querySelector('button[aria-label="Inspect smoke.png"]')`);
    step = 'image inspector and overlay';
    await evaluate(`document.querySelector('button[aria-label="Inspect smoke.png"]').click()`);
    await waitFor(`!!document.querySelector('dialog[open] img') && document.querySelector('dialog[open] img').naturalWidth === 200 && !!document.querySelector('dialog[open] rect')`);
    const box = await evaluate(`(()=>{const r=document.querySelector('dialog[open] rect');return [r.getAttribute('x'),r.getAttribute('y'),r.getAttribute('width'),r.getAttribute('height'),r.getAttribute('stroke')]})()`);
    if (JSON.stringify(box) !== JSON.stringify(['20','20','60','40','#e11d48'])) throw new Error('Incorrect rendered box');
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile('/tmp/vis4-browser-smoke.png', Buffer.from(screenshot.data, 'base64'));
    await evaluate(`document.querySelector('dialog input[type=checkbox]').click()`);
    await waitFor(`!document.querySelector('dialog rect')`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(`!document.querySelector('dialog[open]')`);
    step = 'insights and history navigation';
    await evaluate(`document.querySelector('a[href$="tab=insights"]').click()`);
    await waitFor(`location.search === '?tab=insights' && document.body.innerText.includes('Annotation label distribution')`);
    await evaluate('history.back()');
    await waitFor(`!!document.querySelector('button[aria-label="Inspect smoke.png"]')`);
    if (requests.some(method => method !== 'GET')) throw new Error('Viewer mutation request detected');
    console.log('PASS: catalog → viewer → real image/box, color, overlay toggle, Escape, Insights, browser back; application requests GET only.');
    step = 'Versions and immutable capture inspector';
    await evaluate(`document.querySelector('a[href$="tab=versions"]').click()`);
    await waitFor(`document.body.innerText.includes('Version 1')`);
    if (await evaluate(`document.body.innerText.includes('Version 2')`)) throw new Error('Invented version');
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Inspect capture').click()`);
    await waitFor(`!!document.querySelector('img') && !!document.querySelector('svg rect')`);
    step = 'mutate source and preserve old capture';
    await db.annotation.update({ where: { id: annotation.id }, data: { revision: { increment: 1 }, geometry: { x: 0.2, y: 0.1, width: 0.4, height: 0.3 } } });
    await db.label.update({ where: { id: label.id }, data: { color: '#2563eb' } });
    assert.deepEqual(await readSnapshotContent(datasetId, firstSnapshotId, 1, 20), frozen);
    assert.deepEqual(await artifactBytes(sourceCopy), frozenBytes);
    step = 'second snapshot and derived profile';
    const secondSnapshotId = await captureAndDerive({ ...user, name: user.name! }, datasetId);
    assert.notEqual(secondSnapshotId, firstSnapshotId);
    await send('Page.reload');
    await waitFor(`document.body.innerText.includes('Version 1') && document.body.innerText.includes('Version 2')`);
    if (await evaluate(`document.body.innerText.includes('Version 3')`)) throw new Error('Invented version');
    const versionsShot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile('/tmp/vis4-browser-versions.png', Buffer.from(versionsShot.data, 'base64'));
    await evaluate(`document.querySelector('a[href$="tab=insights"]').click()`);
    await waitFor(`document.body.innerText.includes('Derived processing: ready') && document.body.innerText.includes('valid normalized image bounding boxes')`);
    await evaluate(`document.querySelector('a[href$="tab=data"]').click()`);
    await waitFor(`!!document.querySelector('button[aria-label="Inspect smoke.png"]')`);
    await evaluate(`document.querySelector('button[aria-label="Inspect smoke.png"]').click()`);
    await waitFor(`document.querySelector('dialog rect')?.getAttribute('stroke') === '#2563eb'`);
    assert.deepEqual(await readSnapshotContent(datasetId, firstSnapshotId, 1, 20), frozen);
    assert.deepEqual(await artifactBytes(sourceCopy), frozenBytes);
    if (requests.some(method => method !== 'GET')) throw new Error('Viewer mutation request detected');
    console.log('PASS: real BullMQ jobId-only capture/derive; Versions 1 → source edits → immutable Version 1 → Version 2; derived Insights, preview Data, historical inspector; viewer GET only.');
    step = 'reopen redirect';
    await db.dataset.update({ where: { id: datasetId }, data: { metadata: { workflowStatus: 'IN_PROGRESS' } } });
    await evaluate(`window.dispatchEvent(new Event('focus'))`);
    await waitFor(`location.pathname === '/workspace/${datasetId}'`);
    console.log('PASS: reopening clears viewer and replaces navigation with workspace.');
  } catch { console.error(`FAIL: browser smoke at ${step}`); process.exitCode = 1; }
  finally {
    ws?.close();
    await runtime.close();
    await transport.obliterate({ force: true }); await transport.close();
    if (datasetId) {
      const keys: string[] = [];
      for await (const entry of minio.listObjectsV2(config.MINIO_BUCKET, `visualization/${datasetId}/`, true)) if (entry.name) keys.push(entry.name);
      if (keys.length) await minio.removeObjects(config.MINIO_BUCKET, keys);
    }
    if (datasetId) await db.dataset.delete({ where: { id: datasetId } });
    if (userId) await db.user.delete({ where: { id: userId } });
    await minio.removeObject(config.MINIO_BUCKET, key);
    await db.$disconnect();
  }
}
void main();
