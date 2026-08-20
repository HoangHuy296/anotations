import assert from "node:assert/strict";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

import { createQueueTransport } from "@annotationplatform/queue";

import { getWorkerConfig } from "../../src/config.js";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { createWorkerMinio } from "../../src/providers/minio.js";

const enabled = process.env.WORKER_CONTAINER_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const privateEnabled = enabled && Boolean(process.env.SOURCE_CONNECTION_GITEA_TOKEN && process.env.SOURCE_CONNECTION_ENCRYPTION_KEY);
const skip = "container worker runtime test requires explicit local Compose enablement";

function encryptSourceTokenForFixture(token: string) {
  const key = Buffer.from(process.env.SOURCE_CONNECTION_ENCRYPTION_KEY!, "base64");
  assert.equal(key.length, 32, "test encryption key must be valid");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

async function waitForTerminal(db: ReturnType<typeof createWorkerDatabase>, jobId: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { status: true, errorCode: true } });
    if (["COMPLETED", "FAILED", "CANCELED"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Worker container did not reach a terminal state in time.");
}

test("Compose worker consumes exactly { jobId } and completes a controlled repository mirror", { skip: enabled ? false : skip }, async () => {
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  const suffix = randomUUID();
  let datasetId: string | null = null;
  let jobId: string | null = null;
  let objectKey: string | null = null;
  const queue = createQueueTransport({ host: "127.0.0.1", port: config.REDIS_PORT, password: config.REDIS_PASSWORD, db: config.REDIS_DB, prefix: config.BULLMQ_PREFIX });
  try {
    const owner = await db.user.create({ data: { email: `phase016-container-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `phase016-container-${suffix}`, sourceMode: "MIRROR_TO_MINIO", sourceRef: "main" }, select: { id: true } });
    datasetId = dataset.id;
    const job = await db.job.create({ data: {
      datasetId: dataset.id, createdById: owner.id, type: "IMPORT_DATASET", status: "QUEUED", provider: "GITEA", totalItems: 1,
      input: { source: { repository: { provider: "GITEA", owner: "annotation-admin", repo: "ImageDataset", ref: "main", rootPath: null, visibility: "PUBLIC" }, manifest: { itemCount: 1, declaredBytes: 59499 }, sourceConnectionId: null } },
    }, select: { id: true } });
    jobId = job.id;
    await queue.add("durable-job", { jobId: job.id }, { jobId: job.id });
    const delivered = await queue.getJob(job.id);
    assert.deepEqual(delivered?.data, { jobId: job.id });
    const terminal = await waitForTerminal(db, job.id);
    assert.equal(terminal.status, "COMPLETED", `safe worker error code: ${terminal.errorCode ?? "none"}`);
    const asset = await db.asset.findFirstOrThrow({ where: { datasetId: dataset.id }, select: { storageKey: true, imageAsset: true } });
    assert.ok(asset.imageAsset && asset.storageKey);
    objectKey = asset.storageKey;
    await createWorkerMinio(config).statObject(config.MINIO_BUCKET, objectKey);
  } finally {
    if (jobId) await queue.remove(jobId).catch(() => undefined);
    if (datasetId) await db.dataset.delete({ where: { id: datasetId } }).catch(() => undefined);
    if (objectKey) await createWorkerMinio(config).removeObject(config.MINIO_BUCKET, objectKey).catch(() => undefined);
    await queue.close();
    await db.$disconnect();
  }
});

test("Compose worker maps the configured public Gitea root for an ACTIVE encrypted SourceConnection", {
  skip: privateEnabled ? false : "private Compose worker runtime test requires an explicit local Gitea PAT fixture",
}, async () => {
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  const suffix = randomUUID();
  let datasetId: string | null = null;
  let jobId: string | null = null;
  let objectKey: string | null = null;
  let ownerId: string | null = null;
  let sourceConnectionId: string | null = null;
  const queue = createQueueTransport({ host: "127.0.0.1", port: config.REDIS_PORT, password: config.REDIS_PASSWORD, db: config.REDIS_DB, prefix: config.BULLMQ_PREFIX });
  try {
    const owner = await db.user.create({ data: { email: `phase016-private-container-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
    ownerId = owner.id;
    // This is the browser-facing public endpoint stored by an existing local
    // connection. The worker must replace it only via the exact configured
    // Compose public-to-internal mapping before making provider calls.
    const connection = await db.sourceConnection.create({
      data: {
        userId: owner.id,
        provider: "GITEA",
        authType: "TOKEN",
        baseUrl: "http://localhost:3100",
        name: `phase016-private-container-${suffix}`,
        tokenEncrypted: encryptSourceTokenForFixture(process.env.SOURCE_CONNECTION_GITEA_TOKEN!),
        status: "ACTIVE",
      },
      select: { id: true },
    });
    sourceConnectionId = connection.id;
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `phase016-private-container-${suffix}`, sourceMode: "MIRROR_TO_MINIO", sourceConnectionId: connection.id, sourceRef: "main" }, select: { id: true } });
    datasetId = dataset.id;
    const job = await db.job.create({ data: {
      datasetId: dataset.id,
      createdById: owner.id,
      sourceConnectionId: connection.id,
      type: "IMPORT_DATASET",
      status: "QUEUED",
      provider: "GITEA",
      // Match Phase-015 Jobs accepted before preview aggregates were stored.
      // The worker must scan with server limits, then persist the discovered
      // safe counters instead of treating this as a zero-item import.
      totalItems: 0,
      input: { source: { repository: { provider: "GITEA", owner: "annotation-admin", repo: "ImageDataset", ref: "main", rootPath: null, visibility: "PRIVATE" }, manifest: { itemCount: 0, declaredBytes: 0 }, sourceConnectionId: connection.id } },
    }, select: { id: true } });
    jobId = job.id;
    await queue.add("durable-job", { jobId: job.id }, { jobId: job.id });
    const terminal = await waitForTerminal(db, job.id);
    assert.equal(terminal.status, "COMPLETED", `safe worker error code: ${terminal.errorCode ?? "none"}`);
    const completed = await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { totalItems: true, processedItems: true, successItems: true } });
    assert.ok((completed.totalItems ?? 0) > 0);
    assert.equal(completed.processedItems, completed.successItems);
    const asset = await db.asset.findFirstOrThrow({ where: { datasetId: dataset.id }, select: { storageKey: true, imageAsset: true } });
    assert.ok(asset.imageAsset && asset.storageKey);
    objectKey = asset.storageKey;
    await createWorkerMinio(config).statObject(config.MINIO_BUCKET, objectKey);
  } finally {
    if (jobId) await queue.remove(jobId).catch(() => undefined);
    if (datasetId) await db.dataset.delete({ where: { id: datasetId } }).catch(() => undefined);
    if (objectKey) await createWorkerMinio(config).removeObject(config.MINIO_BUCKET, objectKey).catch(() => undefined);
    if (sourceConnectionId) await db.sourceConnection.delete({ where: { id: sourceConnectionId } }).catch(() => undefined);
    if (ownerId) await db.user.delete({ where: { id: ownerId } }).catch(() => undefined);
    await queue.close();
    await db.$disconnect();
  }
});
