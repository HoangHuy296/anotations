import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { updateJobProgress } from "../../src/jobs/job-claim-lock.js";
import { claimJob } from "../../src/jobs/job.repository.js";
import { buildMirrorObjectKey, buildSourceFingerprint } from "../../src/jobs/source-fingerprint.js";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { createWorkerMinio } from "../../src/providers/minio.js";
import { routeQueueDelivery } from "../../src/queue/queue-router.js";

const enabled = process.env.REPOSITORY_IMPORT_RUNTIME_TESTS === "1" && Boolean(process.env.DATABASE_URL);

async function fixture() {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/api/v1/repos/fixture/retry/git/trees/main") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ tree: [{ path: "images/retry.png", type: "blob", sha: "retry-blob", size: 1 }] }));
      return;
    }
    if (path === "/api/v1/repos/fixture/retry/raw/main/images/retry.png") {
      response.writeHead(200, { "content-type": "image/png", "content-length": "1" }); response.end(Buffer.from([0])); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests: () => requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function createRepositoryJob(db: ReturnType<typeof createWorkerDatabase>, suffix: string) {
  const owner = await db.user.create({ data: { email: `phase016-retry-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `phase016-retry-${suffix}`, sourceMode: "MIRROR_TO_MINIO" }, select: { id: true } });
  const job = await db.job.create({ data: {
    datasetId: dataset.id, createdById: owner.id, type: "IMPORT_DATASET", status: "QUEUED", provider: "GITEA", totalItems: 1,
    input: { source: { repository: { provider: "GITEA", owner: "fixture", repo: "retry", ref: "main", rootPath: null, visibility: "PUBLIC" }, manifest: { itemCount: 1, declaredBytes: 1 }, sourceConnectionId: null } },
  }, select: { id: true } });
  return { owner, dataset, job };
}

test("failure after Asset commit reconciles the same private object and Asset on retry", { skip: enabled ? false : "explicit controlled runtime required" }, async () => {
  const source = await fixture(); const config = getWorkerConfig(); const db = createWorkerDatabase(config); const suffix = randomUUID();
  let datasetId: string | null = null; let objectKey: string | null = null;
  const oldUrl = process.env.GITEA_INTERNAL_URL; const oldEnabled = process.env.REPOSITORY_IMPORT_FAILURE_INJECTION; const oldPoint = process.env.REPOSITORY_IMPORT_TEST_POINT;
  try {
    const created = await createRepositoryJob(db, suffix); datasetId = created.dataset.id;
    process.env.GITEA_INTERNAL_URL = source.baseUrl; process.env.REPOSITORY_IMPORT_FAILURE_INJECTION = "1"; process.env.REPOSITORY_IMPORT_TEST_POINT = "AFTER_PERSIST_BEFORE_COMPLETE";
    await routeQueueDelivery({ db, payload: { jobId: created.job.id }, workerId: `${suffix}-first` });
    const failed = await db.job.findUniqueOrThrow({ where: { id: created.job.id }, select: { status: true } });
    assert.equal(failed.status, "FAILED");
    const first = await db.asset.findFirstOrThrow({ where: { datasetId: created.dataset.id }, select: { id: true, storageKey: true } }); objectKey = first.storageKey;
    assert.ok(objectKey);
    await createWorkerMinio(config).statObject(config.MINIO_BUCKET, objectKey);
    await db.job.update({ where: { id: created.job.id }, data: { status: "RETRYING", lockToken: null, lockedBy: null, lockedAt: null, lockedUntil: null, heartbeatAt: null, errorCode: null } });
    delete process.env.REPOSITORY_IMPORT_FAILURE_INJECTION; delete process.env.REPOSITORY_IMPORT_TEST_POINT;
    await routeQueueDelivery({ db, payload: { jobId: created.job.id }, workerId: `${suffix}-retry` });
    const completed = await db.job.findUniqueOrThrow({ where: { id: created.job.id }, select: { status: true, events: { where: { message: "JOB_COMPLETED" }, select: { id: true } } } });
    const second = await db.asset.findFirstOrThrow({ where: { datasetId: created.dataset.id }, select: { id: true, storageKey: true, imageAsset: { select: { id: true } }, versions: { select: { id: true } } } });
    assert.equal(completed.status, "COMPLETED"); assert.equal(second.id, first.id); assert.equal(second.storageKey, objectKey); assert.ok(second.imageAsset); assert.equal(second.versions.length, 0); assert.equal(completed.events.length, 1);
  } finally {
    if (oldUrl === undefined) delete process.env.GITEA_INTERNAL_URL; else process.env.GITEA_INTERNAL_URL = oldUrl;
    if (oldEnabled === undefined) delete process.env.REPOSITORY_IMPORT_FAILURE_INJECTION; else process.env.REPOSITORY_IMPORT_FAILURE_INJECTION = oldEnabled;
    if (oldPoint === undefined) delete process.env.REPOSITORY_IMPORT_TEST_POINT; else process.env.REPOSITORY_IMPORT_TEST_POINT = oldPoint;
    if (datasetId) await db.dataset.delete({ where: { id: datasetId } }).catch(() => undefined);
    if (objectKey) await createWorkerMinio(config).removeObject(config.MINIO_BUCKET, objectKey).catch(() => undefined);
    await db.$disconnect(); await source.close();
  }
});

test("concurrent redelivery has one claimant and a stale lock token cannot mutate progress", { skip: enabled ? false : "explicit controlled runtime required" }, async () => {
  const source = await fixture(); const config = getWorkerConfig(); const db = createWorkerDatabase(config); const suffix = randomUUID();
  let datasetId: string | null = null; const oldUrl = process.env.GITEA_INTERNAL_URL;
  try {
    const created = await createRepositoryJob(db, suffix); datasetId = created.dataset.id; process.env.GITEA_INTERNAL_URL = source.baseUrl;
    const result = await Promise.all([routeQueueDelivery({ db, payload: { jobId: created.job.id }, workerId: `${suffix}-a` }), routeQueueDelivery({ db, payload: { jobId: created.job.id }, workerId: `${suffix}-b` })]);
    assert.equal(result.filter((item) => item.kind === "claimed").length, 1);
    assert.equal(await db.asset.count({ where: { datasetId: datasetId } }), 1);
    assert.equal(await db.jobEvent.count({ where: { jobId: created.job.id, message: "JOB_COMPLETED" } }), 1);
    const stale = await createRepositoryJob(db, `${suffix}-stale`);
    const first = await claimJob(db, stale.job.id, "stale-worker"); assert.ok(first);
    await db.job.update({ where: { id: stale.job.id }, data: { status: "RETRYING", lockedUntil: new Date(Date.now() - 1_000) } });
    const replacement = await claimJob(db, stale.job.id, "replacement-worker"); assert.ok(replacement);
    assert.deepEqual(await updateJobProgress(db, { jobId: stale.job.id, lockToken: first.lockToken, progress: 5 }), { kind: "refused" });
    await db.dataset.delete({ where: { id: stale.dataset.id } });
  } finally {
    if (oldUrl === undefined) delete process.env.GITEA_INTERNAL_URL; else process.env.GITEA_INTERNAL_URL = oldUrl;
    if (datasetId) await db.dataset.delete({ where: { id: datasetId } }).catch(() => undefined);
    await db.$disconnect(); await source.close();
  }
});

test("cancellation at upload and batch boundaries preserves only canonical committed data", { skip: enabled ? false : "explicit controlled runtime required" }, async () => {
  const source = await fixture(); const config = getWorkerConfig(); const db = createWorkerDatabase(config); const suffix = randomUUID();
  const oldUrl = process.env.GITEA_INTERNAL_URL; const oldEnabled = process.env.REPOSITORY_IMPORT_FAILURE_INJECTION; const oldPoint = process.env.REPOSITORY_IMPORT_TEST_POINT;
  const datasets: string[] = [];
  try {
    process.env.GITEA_INTERNAL_URL = source.baseUrl; process.env.REPOSITORY_IMPORT_FAILURE_INJECTION = "1";
    const beforePersist = await createRepositoryJob(db, `${suffix}-upload`); datasets.push(beforePersist.dataset.id);
    process.env.REPOSITORY_IMPORT_TEST_POINT = "CANCEL_AFTER_UPLOAD";
    await routeQueueDelivery({ db, payload: { jobId: beforePersist.job.id }, workerId: `${suffix}-upload` });
    const canceledBeforePersist = await db.job.findUniqueOrThrow({ where: { id: beforePersist.job.id }, select: { status: true, events: { where: { message: "JOB_COMPLETED" }, select: { id: true } } } });
    assert.equal(canceledBeforePersist.status, "CANCELED"); assert.equal(canceledBeforePersist.events.length, 0);
    assert.equal(await db.asset.count({ where: { datasetId: beforePersist.dataset.id } }), 0);
    const fingerprint = buildSourceFingerprint({ provider: "GITEA", owner: "fixture", repository: "retry", path: "images/retry.png" });
    const objectKey = buildMirrorObjectKey({ datasetId: beforePersist.dataset.id, sourceFingerprint: fingerprint, revision: "main", providerFileIdentity: "retry-blob" });
    await assert.rejects(() => createWorkerMinio(config).statObject(config.MINIO_BUCKET, objectKey));

    const afterPersist = await createRepositoryJob(db, `${suffix}-batch`); datasets.push(afterPersist.dataset.id);
    process.env.REPOSITORY_IMPORT_TEST_POINT = "CANCEL_AFTER_BATCH";
    await routeQueueDelivery({ db, payload: { jobId: afterPersist.job.id }, workerId: `${suffix}-batch` });
    const canceledAfterPersist = await db.job.findUniqueOrThrow({ where: { id: afterPersist.job.id }, select: { status: true, events: { where: { message: "JOB_COMPLETED" }, select: { id: true } } } });
    assert.equal(canceledAfterPersist.status, "CANCELED"); assert.equal(canceledAfterPersist.events.length, 0);
    assert.equal(await db.asset.count({ where: { datasetId: afterPersist.dataset.id } }), 1);
  } finally {
    if (oldUrl === undefined) delete process.env.GITEA_INTERNAL_URL; else process.env.GITEA_INTERNAL_URL = oldUrl;
    if (oldEnabled === undefined) delete process.env.REPOSITORY_IMPORT_FAILURE_INJECTION; else process.env.REPOSITORY_IMPORT_FAILURE_INJECTION = oldEnabled;
    if (oldPoint === undefined) delete process.env.REPOSITORY_IMPORT_TEST_POINT; else process.env.REPOSITORY_IMPORT_TEST_POINT = oldPoint;
    for (const datasetId of datasets) {
      const keys = await db.asset.findMany({ where: { datasetId }, select: { storageKey: true } }).catch(() => []);
      await db.dataset.delete({ where: { id: datasetId } }).catch(() => undefined);
      await Promise.all(keys.flatMap((asset) => asset.storageKey ? [createWorkerMinio(config).removeObject(config.MINIO_BUCKET, asset.storageKey).catch(() => undefined)] : []));
    }
    await db.$disconnect(); await source.close();
  }
});

test("bounded failure windows clean only unpublished objects and converge after ambiguous completion", { skip: enabled ? false : "explicit controlled runtime required" }, async () => {
  const source = await fixture(); const config = getWorkerConfig(); const db = createWorkerDatabase(config); const suffix = randomUUID();
  const oldUrl = process.env.GITEA_INTERNAL_URL; const oldEnabled = process.env.REPOSITORY_IMPORT_FAILURE_INJECTION; const oldPoint = process.env.REPOSITORY_IMPORT_TEST_POINT;
  const datasets: string[] = [];
  try {
    process.env.GITEA_INTERNAL_URL = source.baseUrl; process.env.REPOSITORY_IMPORT_FAILURE_INJECTION = "1";
    for (const point of ["BEFORE_UPLOAD", "AFTER_UPLOAD_BEFORE_PERSIST"] as const) {
      const created = await createRepositoryJob(db, `${suffix}-${point}`); datasets.push(created.dataset.id); process.env.REPOSITORY_IMPORT_TEST_POINT = point;
      await routeQueueDelivery({ db, payload: { jobId: created.job.id }, workerId: `${suffix}-${point}` });
      const failed = await db.job.findUniqueOrThrow({ where: { id: created.job.id }, select: { status: true } }); assert.equal(failed.status, "FAILED");
      assert.equal(await db.asset.count({ where: { datasetId: created.dataset.id } }), 0);
      const key = buildMirrorObjectKey({ datasetId: created.dataset.id, sourceFingerprint: buildSourceFingerprint({ provider: "GITEA", owner: "fixture", repository: "retry", path: "images/retry.png" }), revision: "main", providerFileIdentity: "retry-blob" });
      await assert.rejects(() => createWorkerMinio(config).statObject(config.MINIO_BUCKET, key));
    }
    const ambiguous = await createRepositoryJob(db, `${suffix}-ack`); datasets.push(ambiguous.dataset.id); process.env.REPOSITORY_IMPORT_TEST_POINT = "AFTER_COMPLETE_BEFORE_ACK";
    await routeQueueDelivery({ db, payload: { jobId: ambiguous.job.id }, workerId: `${suffix}-ack-a` });
    delete process.env.REPOSITORY_IMPORT_TEST_POINT;
    await routeQueueDelivery({ db, payload: { jobId: ambiguous.job.id }, workerId: `${suffix}-ack-b` });
    const stored = await db.job.findUniqueOrThrow({ where: { id: ambiguous.job.id }, select: { status: true, events: { where: { message: "JOB_COMPLETED" }, select: { id: true } } } });
    assert.equal(stored.status, "COMPLETED"); assert.equal(stored.events.length, 1); assert.equal(await db.asset.count({ where: { datasetId: ambiguous.dataset.id } }), 1);
  } finally {
    if (oldUrl === undefined) delete process.env.GITEA_INTERNAL_URL; else process.env.GITEA_INTERNAL_URL = oldUrl;
    if (oldEnabled === undefined) delete process.env.REPOSITORY_IMPORT_FAILURE_INJECTION; else process.env.REPOSITORY_IMPORT_FAILURE_INJECTION = oldEnabled;
    if (oldPoint === undefined) delete process.env.REPOSITORY_IMPORT_TEST_POINT; else process.env.REPOSITORY_IMPORT_TEST_POINT = oldPoint;
    for (const datasetId of datasets) {
      const keys = await db.asset.findMany({ where: { datasetId }, select: { storageKey: true } }).catch(() => []);
      await db.dataset.delete({ where: { id: datasetId } }).catch(() => undefined);
      await Promise.all(keys.flatMap((asset) => asset.storageKey ? [createWorkerMinio(config).removeObject(config.MINIO_BUCKET, asset.storageKey).catch(() => undefined)] : []));
    }
    await db.$disconnect(); await source.close();
  }
});
