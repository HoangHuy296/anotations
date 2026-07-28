import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { createWorkerMinio } from "../../src/providers/minio.js";
import { routeQueueDelivery } from "../../src/queue/queue-router.js";

const enabled = process.env.REPOSITORY_IMPORT_RUNTIME_TESTS === "1" && Boolean(process.env.DATABASE_URL);

async function startFixture() {
  const files = Array.from({ length: 51 }, (_, index) => ({ path: `images/${String(index).padStart(3, "0")}.png`, sha: `blob-${index}`, size: 1, type: "blob" }));
  const server = http.createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/api/v1/repos/fixture/many/git/trees/main") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tree: files }));
      return;
    }
    if (path.startsWith("/api/v1/repos/fixture/many/raw/main/images/")) {
      response.writeHead(200, { "content-type": "image/png", "content-length": "1" });
      response.end(Buffer.from([0]));
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function startMixedOutcomeFixture() {
  const files = [
    ...Array.from({ length: 51 }, (_, index) => ({ path: `images/${String(index).padStart(3, "0")}.png`, sha: `mixed-${index}`, size: 1, type: "blob" })),
    { path: "notes/unsupported.bin", sha: "mixed-unsupported", size: 1, type: "blob" },
  ];
  const server = http.createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/api/v1/repos/fixture/mixed/git/trees/main") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tree: files }));
      return;
    }
    if (path.startsWith("/api/v1/repos/fixture/mixed/raw/main/images/")) {
      if (path.endsWith("/050.png")) { response.writeHead(503); response.end(); return; }
      response.writeHead(200, { "content-type": "image/png", "content-length": "1" });
      response.end(Buffer.from([0]));
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("51 controlled repository files produce two aggregate batch events and durable counters", { skip: enabled ? false : "explicit controlled runtime required" }, async () => {
  const fixture = await startFixture();
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  const suffix = randomUUID();
  let datasetId: string | null = null;
  const keys: string[] = [];
  try {
    const owner = await db.user.create({ data: { email: `phase016-multibatch-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `phase016-multibatch-${suffix}`, sourceMode: "MIRROR_TO_MINIO" }, select: { id: true } });
    datasetId = dataset.id;
    const job = await db.job.create({ data: {
      datasetId: dataset.id, createdById: owner.id, type: "IMPORT_DATASET", status: "QUEUED", provider: "GITEA", totalItems: 51,
      input: { source: { repository: { provider: "GITEA", owner: "fixture", repo: "many", ref: "main", rootPath: null, visibility: "PUBLIC" }, manifest: { itemCount: 51, declaredBytes: 51 }, sourceConnectionId: null } },
    }, select: { id: true } });
    const previous = process.env.GITEA_INTERNAL_URL;
    process.env.GITEA_INTERNAL_URL = fixture.baseUrl;
    try { await routeQueueDelivery({ db, payload: { jobId: job.id }, workerId: `phase016-multibatch-${suffix}` }); } finally { process.env.GITEA_INTERNAL_URL = previous; }
    const stored = await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, processedItems: true, successItems: true, events: { where: { message: "IMPORT_BATCH_COMPLETED" }, orderBy: { createdAt: "asc" }, select: { data: true } } } });
    assert.equal(stored.status, "COMPLETED");
    assert.equal(stored.processedItems, 51);
    assert.equal(stored.successItems, 51);
    assert.deepEqual(stored.events.map((event) => event.data), [{ imported: 50, skipped: 0, failed: 0 }, { imported: 51, skipped: 0, failed: 0 }]);
    const assets = await db.asset.findMany({ where: { datasetId: dataset.id }, select: { storageKey: true } });
    assert.equal(assets.length, 51);
    for (const asset of assets) if (asset.storageKey) keys.push(asset.storageKey);
  } finally {
    if (datasetId) await db.dataset.delete({ where: { id: datasetId } }).catch(() => undefined);
    await Promise.all(keys.map((key) => createWorkerMinio(config).removeObject(config.MINIO_BUCKET, key).catch(() => undefined)));
    await db.$disconnect();
    await fixture.close();
  }
});

test("cancellation after the first 50-file batch never completes or starts the next batch", { skip: enabled ? false : "explicit controlled runtime required" }, async () => {
  const fixture = await startFixture(); const config = getWorkerConfig(); const db = createWorkerDatabase(config); const suffix = randomUUID();
  let datasetId: string | null = null; const keys: string[] = [];
  const previous = process.env.GITEA_INTERNAL_URL; const previousInjection = process.env.REPOSITORY_IMPORT_FAILURE_INJECTION; const previousPoint = process.env.REPOSITORY_IMPORT_TEST_POINT;
  try {
    const owner = await db.user.create({ data: { email: `phase016-cancel-batch-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `phase016-cancel-batch-${suffix}`, sourceMode: "MIRROR_TO_MINIO" }, select: { id: true } }); datasetId = dataset.id;
    const job = await db.job.create({ data: {
      datasetId: dataset.id, createdById: owner.id, type: "IMPORT_DATASET", status: "QUEUED", provider: "GITEA", totalItems: 51,
      input: { source: { repository: { provider: "GITEA", owner: "fixture", repo: "many", ref: "main", rootPath: null, visibility: "PUBLIC" }, manifest: { itemCount: 51, declaredBytes: 51 }, sourceConnectionId: null } },
    }, select: { id: true } });
    process.env.GITEA_INTERNAL_URL = fixture.baseUrl; process.env.REPOSITORY_IMPORT_FAILURE_INJECTION = "1"; process.env.REPOSITORY_IMPORT_TEST_POINT = "CANCEL_AFTER_BATCH";
    await routeQueueDelivery({ db, payload: { jobId: job.id }, workerId: `phase016-cancel-batch-${suffix}` });
    const stored = await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, processedItems: true, successItems: true, events: { where: { message: { in: ["IMPORT_BATCH_COMPLETED", "JOB_COMPLETED"] } }, orderBy: { createdAt: "asc" }, select: { message: true, data: true } } } });
    assert.equal(stored.status, "CANCELED"); assert.equal(stored.processedItems, 50); assert.equal(stored.successItems, 50);
    assert.deepEqual(stored.events, [{ message: "IMPORT_BATCH_COMPLETED", data: { imported: 50, skipped: 0, failed: 0 } }]);
    const assets = await db.asset.findMany({ where: { datasetId: dataset.id }, select: { storageKey: true } }); assert.equal(assets.length, 50);
    for (const asset of assets) if (asset.storageKey) keys.push(asset.storageKey);
  } finally {
    if (previous === undefined) delete process.env.GITEA_INTERNAL_URL; else process.env.GITEA_INTERNAL_URL = previous;
    if (previousInjection === undefined) delete process.env.REPOSITORY_IMPORT_FAILURE_INJECTION; else process.env.REPOSITORY_IMPORT_FAILURE_INJECTION = previousInjection;
    if (previousPoint === undefined) delete process.env.REPOSITORY_IMPORT_TEST_POINT; else process.env.REPOSITORY_IMPORT_TEST_POINT = previousPoint;
    if (datasetId) await db.dataset.delete({ where: { id: datasetId } }).catch(() => undefined);
    await Promise.all(keys.map((key) => createWorkerMinio(config).removeObject(config.MINIO_BUCKET, key).catch(() => undefined)));
    await db.$disconnect(); await fixture.close();
  }
});

test("mixed two-batch repository outcome persists only aggregate safe counters", { skip: enabled ? false : "explicit controlled runtime required" }, async () => {
  const fixture = await startMixedOutcomeFixture();
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  const suffix = randomUUID();
  let datasetId: string | null = null;
  const keys: string[] = [];
  const previous = process.env.GITEA_INTERNAL_URL;
  try {
    const owner = await db.user.create({ data: { email: `phase016-mixed-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `phase016-mixed-${suffix}`, sourceMode: "MIRROR_TO_MINIO" }, select: { id: true } });
    datasetId = dataset.id;
    const job = await db.job.create({ data: {
      datasetId: dataset.id, createdById: owner.id, type: "IMPORT_DATASET", status: "QUEUED", provider: "GITEA", totalItems: 52,
      input: { source: { repository: { provider: "GITEA", owner: "fixture", repo: "mixed", ref: "main", rootPath: null, visibility: "PUBLIC" }, manifest: { itemCount: 52, declaredBytes: 52 }, sourceConnectionId: null } },
    }, select: { id: true } });
    process.env.GITEA_INTERNAL_URL = fixture.baseUrl;
    await routeQueueDelivery({ db, payload: { jobId: job.id }, workerId: `phase016-mixed-${suffix}` });
    const stored = await db.job.findUniqueOrThrow({
      where: { id: job.id },
      select: {
        status: true, totalItems: true, processedItems: true, successItems: true, failedItems: true, skippedItems: true, summary: true,
        events: { where: { message: { in: ["IMPORT_BATCH_COMPLETED", "JOB_COMPLETED"] } }, orderBy: { createdAt: "asc" }, select: { message: true, data: true } },
      },
    });
    assert.equal(stored.status, "COMPLETED");
    assert.deepEqual(
      { total: stored.totalItems, processed: stored.processedItems, success: stored.successItems, failed: stored.failedItems, skipped: stored.skippedItems },
      { total: 52, processed: 52, success: 50, failed: 1, skipped: 1 },
    );
    assert.equal(stored.processedItems, stored.successItems + stored.failedItems + stored.skippedItems);
    assert.ok(stored.processedItems! <= stored.totalItems!);
    assert.deepEqual(stored.summary, { outcome: "completed", resultCount: 50, imported: 50, skipped: 1, failed: 1 });
    assert.deepEqual(stored.events, [
      { message: "IMPORT_BATCH_COMPLETED", data: { imported: 50, skipped: 0, failed: 0 } },
      { message: "IMPORT_BATCH_COMPLETED", data: { imported: 50, skipped: 1, failed: 1 } },
      { message: "JOB_COMPLETED", data: {} },
    ]);
    const assets = await db.asset.findMany({ where: { datasetId: dataset.id }, select: { storageKey: true, imageAsset: { select: { id: true } }, videoAsset: { select: { id: true } }, audioAsset: { select: { id: true } }, textDocument: { select: { id: true } } } });
    assert.equal(assets.length, 50);
    assert.ok(assets.every((asset) => asset.imageAsset && !asset.videoAsset && !asset.audioAsset && !asset.textDocument));
    for (const asset of assets) if (asset.storageKey) keys.push(asset.storageKey);
    assert.equal((await Promise.all(keys.map((key) => createWorkerMinio(config).statObject(config.MINIO_BUCKET, key)))).length, 50);
  } finally {
    if (previous === undefined) delete process.env.GITEA_INTERNAL_URL; else process.env.GITEA_INTERNAL_URL = previous;
    if (datasetId) await db.dataset.delete({ where: { id: datasetId } }).catch(() => undefined);
    await Promise.all(keys.map((key) => createWorkerMinio(config).removeObject(config.MINIO_BUCKET, key).catch(() => undefined)));
    await db.$disconnect();
    await fixture.close();
  }
});
