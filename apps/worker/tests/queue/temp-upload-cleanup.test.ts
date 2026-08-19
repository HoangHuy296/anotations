import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { cleanupTempUploads } from "../../src/queue/temp-upload-cleanup.js";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { createWorkerMinio } from "../../src/providers/minio.js";

const enabled = process.env.GARBAGE_COLLECTION_RUNTIME_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const skip = enabled ? false : "explicit GARBAGE_COLLECTION_RUNTIME_TESTS=1 + DATABASE_URL required (real MinIO deletes)";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("an object belonging to an active PreparedImport session is never deleted, regardless of age", { skip }, async () => {
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  const minio = createWorkerMinio(config);
  const suffix = randomUUID();
  const owner = await db.user.create({ data: { email: `temp-active-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `temp-active-${suffix}` }, select: { id: true } });
  const job = await db.job.create({ data: { datasetId: dataset.id, createdById: owner.id, type: "IMPORT_DATASET", status: "RUNNING" }, select: { id: true } });
  const key = `prepared-imports/${dataset.id}/item-active`;
  try {
    await minio.putObject(config.MINIO_BUCKET, key, Buffer.from("x"));
    const preparedImport = await db.preparedImport.create({
      data: { datasetId: dataset.id, jobId: job.id, createdById: owner.id, status: "PREPARING", expectedItemCount: 1, deadlineAt: new Date(Date.now() + 60_000), idempotencyKey: `temp-active-${suffix}` },
      select: { id: true },
    });
    await db.preparedImportItem.create({ data: { preparedImportId: preparedImport.id, logicalPath: "a.txt", normalizedPath: "a.txt", filename: "a.txt", mimeType: "text/plain", sizeBytes: 1n, modality: "TEXT", position: 0, fingerprint: key, storageKey: key } });

    await sleep(60);
    const results = await cleanupTempUploads({ db, minio, bucket: config.MINIO_BUCKET, gracePeriodMs: 0, prefixes: [`prepared-imports/${dataset.id}/`] });
    assert.deepEqual(results[`prepared-imports/${dataset.id}/`]!.deleted, [], "an active import's item object must never be deleted, even with zero grace period");
    await minio.statObject(config.MINIO_BUCKET, key);
  } finally {
    await minio.removeObject(config.MINIO_BUCKET, key).catch(() => undefined);
    await db.dataset.deleteMany({ where: { id: dataset.id } });
    await db.user.deleteMany({ where: { id: owner.id } });
    await db.$disconnect();
  }
});

test("an abandoned item from an expired PreparedImport is eventually cleaned up, once past the grace period", { skip }, async () => {
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  const minio = createWorkerMinio(config);
  const suffix = randomUUID();
  const owner = await db.user.create({ data: { email: `temp-expired-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `temp-expired-${suffix}` }, select: { id: true } });
  const job = await db.job.create({ data: { datasetId: dataset.id, createdById: owner.id, type: "IMPORT_DATASET", status: "FAILED" }, select: { id: true } });
  const key = `prepared-imports/${dataset.id}/item-expired`;
  try {
    await minio.putObject(config.MINIO_BUCKET, key, Buffer.from("x"));
    const preparedImport = await db.preparedImport.create({
      data: { datasetId: dataset.id, jobId: job.id, createdById: owner.id, status: "EXPIRED", expectedItemCount: 1, deadlineAt: new Date(Date.now() - 60_000), idempotencyKey: `temp-expired-${suffix}` },
      select: { id: true },
    });
    // The item row itself is never deleted when its import expires —
    // exactly what makes this scenario worth testing explicitly.
    await db.preparedImportItem.create({ data: { preparedImportId: preparedImport.id, logicalPath: "a.txt", normalizedPath: "a.txt", filename: "a.txt", mimeType: "text/plain", sizeBytes: 1n, modality: "TEXT", position: 0, fingerprint: key, storageKey: key } });

    await sleep(60);
    const results = await cleanupTempUploads({ db, minio, bucket: config.MINIO_BUCKET, gracePeriodMs: 50, prefixes: [`prepared-imports/${dataset.id}/`] });
    assert.deepEqual(results[`prepared-imports/${dataset.id}/`]!.deleted, [key]);
    await assert.rejects(() => minio.statObject(config.MINIO_BUCKET, key));
  } finally {
    await minio.removeObject(config.MINIO_BUCKET, key).catch(() => undefined);
    await db.dataset.deleteMany({ where: { id: dataset.id } });
    await db.user.deleteMany({ where: { id: owner.id } });
    await db.$disconnect();
  }
});

test("a direct-upload object younger than the retention period is never deleted", { skip }, async () => {
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  const minio = createWorkerMinio(config);
  const suffix = randomUUID();
  const key = `direct-uploads/temp-upload-test-${suffix}/actor/nonce/file.txt`;
  try {
    await minio.putObject(config.MINIO_BUCKET, key, Buffer.from("x"));
    const results = await cleanupTempUploads({ db, minio, bucket: config.MINIO_BUCKET, gracePeriodMs: 60_000, prefixes: [`direct-uploads/temp-upload-test-${suffix}/`] });
    assert.deepEqual(results[`direct-uploads/temp-upload-test-${suffix}/`]!.deleted, []);
    await minio.statObject(config.MINIO_BUCKET, key);
  } finally {
    await minio.removeObject(config.MINIO_BUCKET, key).catch(() => undefined);
    await db.$disconnect();
  }
});

test("a published direct-upload object (now a real Asset) is protected even after the retention period", { skip }, async () => {
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  const minio = createWorkerMinio(config);
  const suffix = randomUUID();
  const owner = await db.user.create({ data: { email: `temp-published-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `temp-published-${suffix}` }, select: { id: true } });
  const key = `direct-uploads/${dataset.id}/actor/nonce/file.txt`;
  try {
    await minio.putObject(config.MINIO_BUCKET, key, Buffer.from("x"));
    await db.asset.create({
      data: {
        datasetId: dataset.id, modality: "TEXT", filename: "file.txt", mimeType: "text/plain",
        sourceMode: "UPLOAD", storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET,
        storageKey: key, sourceFingerprint: key, status: "READY", textAsset: { create: { tokenization: {}, metadata: {} } },
      },
    });
    await sleep(60);
    const results = await cleanupTempUploads({ db, minio, bucket: config.MINIO_BUCKET, gracePeriodMs: 50, prefixes: [`direct-uploads/${dataset.id}/`] });
    assert.deepEqual(results[`direct-uploads/${dataset.id}/`]!.deleted, []);
    await minio.statObject(config.MINIO_BUCKET, key);
  } finally {
    await minio.removeObject(config.MINIO_BUCKET, key).catch(() => undefined);
    await db.dataset.deleteMany({ where: { id: dataset.id } });
    await db.user.deleteMany({ where: { id: owner.id } });
    await db.$disconnect();
  }
});
