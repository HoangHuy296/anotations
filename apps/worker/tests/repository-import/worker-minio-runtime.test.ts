import assert from "node:assert/strict";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { createWorkerMinio } from "../../src/providers/minio.js";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { routeQueueDelivery } from "../../src/queue/queue-router.js";

const enabled = process.env.REPOSITORY_IMPORT_RUNTIME_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const privateEnabled = enabled && Boolean(process.env.SOURCE_CONNECTION_GITEA_TOKEN && process.env.SOURCE_CONNECTION_ENCRYPTION_KEY);
const skip = "repository MinIO runtime test requires explicitly enabled controlled Compose services";

test("controlled public Gitea file mirrors to one private object, one Asset/ImageAsset, and a completed Job", { skip: enabled ? false : skip }, async () => {
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  const suffix = randomUUID();
  let datasetId: string | null = null;
  let objectKey: string | null = null;
  try {
    const owner = await db.user.create({ data: { email: `phase016-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `phase016-${suffix}`, sourceMode: "MIRROR_TO_MINIO", sourceRef: "main" }, select: { id: true } });
    datasetId = dataset.id;
    const job = await db.job.create({
      data: {
        datasetId: dataset.id, createdById: owner.id, type: "IMPORT_DATASET", status: "QUEUED", provider: "GITEA", totalItems: 1,
        input: { source: { repository: { provider: "GITEA", owner: "annotation-admin", repo: "ImageDataset", ref: "main", rootPath: null, visibility: "PUBLIC" }, manifest: { itemCount: 1, declaredBytes: 59499 }, sourceConnectionId: null } },
      }, select: { id: true },
    });
    assert.deepEqual(await routeQueueDelivery({ db, payload: { jobId: job.id }, workerId: `phase016-${suffix}` }), { kind: "claimed", jobId: job.id });
    const completed = await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, errorCode: true, progress: true, successItems: true, input: true, summary: true, events: { select: { message: true, data: true } } } });
    assert.equal(completed.status, "COMPLETED", `safe worker error code: ${completed.errorCode ?? "none"}`);
    assert.equal(completed.progress, 100);
    assert.equal(completed.successItems, 1);
    assert.ok(completed.events.some((event) => event.message === "IMPORT_BATCH_COMPLETED"));
    assert.equal(JSON.stringify({ input: completed.input, summary: completed.summary, events: completed.events }).includes("token"), false);
    const assets = await db.asset.findMany({ where: { datasetId: dataset.id }, include: { imageAsset: true, videoAsset: true, audioAsset: true, textAsset: true } });
    assert.equal(assets.length, 1);
    const asset = assets[0]!;
    assert.equal(asset.modality, "IMAGE");
    assert.ok(asset.imageAsset);
    assert.equal(Boolean(asset.videoAsset) || Boolean(asset.audioAsset) || Boolean(asset.textAsset), false);
    assert.equal(asset.storageProvider, "MINIO");
    assert.ok(asset.storageKey?.startsWith(`repository-imports/${dataset.id}/`));
    objectKey = asset.storageKey;
    await createWorkerMinio(config).statObject(config.MINIO_BUCKET, objectKey!);
    const before = await db.asset.count({ where: { datasetId: dataset.id } });
    const deliveries = await Promise.all([
      routeQueueDelivery({ db, payload: { jobId: job.id }, workerId: `${suffix}-redelivery-a` }),
      routeQueueDelivery({ db, payload: { jobId: job.id }, workerId: `${suffix}-redelivery-b` }),
    ]);
    assert.deepEqual(deliveries, [{ kind: "skipped", reason: "NOT_QUEUED" }, { kind: "skipped", reason: "NOT_QUEUED" }]);
    assert.equal(await db.asset.count({ where: { datasetId: dataset.id } }), before);
    assert.equal(await db.jobEvent.count({ where: { jobId: job.id, message: "JOB_COMPLETED" } }), 1);
  } finally {
    if (datasetId) await db.dataset.delete({ where: { id: datasetId } }).catch(() => undefined);
    if (datasetId && objectKey) await createWorkerMinio(config).removeObject(config.MINIO_BUCKET, objectKey).catch(() => undefined);
    await db.$disconnect();
  }
});

function encryptForFixture(token: string) {
  const key = Buffer.from(process.env.SOURCE_CONNECTION_ENCRYPTION_KEY!, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

test("controlled owned ACTIVE SourceConnection is revalidated and mirrors one private source Asset", { skip: privateEnabled ? false : "private source runtime test requires explicit local PAT fixture" }, async () => {
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  const suffix = randomUUID();
  let datasetId: string | null = null;
  let objectKey: string | null = null;
  try {
    const owner = await db.user.create({ data: { email: `phase016-private-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
    const connection = await db.sourceConnection.create({ data: { userId: owner.id, provider: "GITEA", authType: "TOKEN", baseUrl: "http://127.0.0.1:3100", name: `phase016-${suffix}`, tokenEncrypted: encryptForFixture(process.env.SOURCE_CONNECTION_GITEA_TOKEN!), status: "ACTIVE" }, select: { id: true } });
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `phase016-private-${suffix}`, sourceMode: "MIRROR_TO_MINIO", sourceConnectionId: connection.id, sourceRef: "main" }, select: { id: true } });
    datasetId = dataset.id;
    const job = await db.job.create({ data: {
      datasetId: dataset.id, createdById: owner.id, sourceConnectionId: connection.id, provider: "GITEA", type: "IMPORT_DATASET", status: "QUEUED", totalItems: 1,
      input: { source: { repository: { provider: "GITEA", owner: "annotation-admin", repo: "ImageDataset", ref: "main", rootPath: null, visibility: "PRIVATE" }, manifest: { itemCount: 1, declaredBytes: 59499 }, sourceConnectionId: connection.id } },
    }, select: { id: true } });
    await routeQueueDelivery({ db, payload: { jobId: job.id }, workerId: `phase016-private-${suffix}` });
    const stored = await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, input: true, events: { select: { data: true } } } });
    assert.equal(stored.status, "COMPLETED");
    assert.equal(JSON.stringify({ input: stored.input, events: stored.events }).includes(process.env.SOURCE_CONNECTION_GITEA_TOKEN!), false);
    const asset = await db.asset.findFirstOrThrow({ where: { datasetId: dataset.id }, select: { storageKey: true, imageAsset: true } });
    assert.ok(asset.imageAsset && asset.storageKey);
    objectKey = asset.storageKey;
    await createWorkerMinio(config).statObject(config.MINIO_BUCKET, objectKey);
  } finally {
    if (datasetId) await db.dataset.delete({ where: { id: datasetId } }).catch(() => undefined);
    if (datasetId && objectKey) await createWorkerMinio(config).removeObject(config.MINIO_BUCKET, objectKey).catch(() => undefined);
    await db.$disconnect();
  }
});

test("controlled multi-item repository writes aggregate counters and one batch event", { skip: enabled ? false : skip }, async () => {
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  const suffix = randomUUID();
  let datasetId: string | null = null;
  const objectKeys: string[] = [];
  try {
    const owner = await db.user.create({ data: { email: `phase016-batch-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `phase016-batch-${suffix}`, sourceMode: "MIRROR_TO_MINIO" }, select: { id: true } });
    datasetId = dataset.id;
    const job = await db.job.create({ data: {
      datasetId: dataset.id, createdById: owner.id, type: "IMPORT_DATASET", status: "QUEUED", provider: "GITEA", totalItems: 5,
      input: { source: { repository: { provider: "GITEA", owner: "annotation-admin", repo: "ImageDataset", ref: "main", rootPath: null, visibility: "PUBLIC" }, manifest: { itemCount: 5, declaredBytes: 420512 }, sourceConnectionId: null } },
    }, select: { id: true } });
    await routeQueueDelivery({ db, payload: { jobId: job.id }, workerId: `phase016-batch-${suffix}` });
    const stored = await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, totalItems: true, processedItems: true, successItems: true, failedItems: true, skippedItems: true, summary: true, events: { where: { message: "IMPORT_BATCH_COMPLETED" }, select: { data: true } } } });
    assert.equal(stored.status, "COMPLETED");
    assert.deepEqual([stored.totalItems, stored.processedItems, stored.successItems, stored.failedItems, stored.skippedItems], [5, 5, 5, 0, 0]);
    assert.equal(stored.events.length, 1);
    assert.deepEqual(stored.events[0]?.data, { imported: 5, skipped: 0, failed: 0 });
    assert.deepEqual(stored.summary, { outcome: "completed", resultCount: 5, imported: 5, skipped: 0, failed: 0 });
    const assets = await db.asset.findMany({ where: { datasetId: dataset.id }, select: { storageKey: true, imageAsset: true } });
    assert.equal(assets.length, 5);
    for (const asset of assets) { assert.ok(asset.imageAsset && asset.storageKey); objectKeys.push(asset.storageKey); }
  } finally {
    if (datasetId) await db.dataset.delete({ where: { id: datasetId } }).catch(() => undefined);
    await Promise.all(objectKeys.map((key) => createWorkerMinio(config).removeObject(config.MINIO_BUCKET, key).catch(() => undefined)));
    await db.$disconnect();
  }
});
