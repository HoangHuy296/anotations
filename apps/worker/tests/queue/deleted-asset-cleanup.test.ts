import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { cleanupDeletedAssetObject } from "../../src/queue/deleted-asset-cleanup.js";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { createWorkerMinio } from "../../src/providers/minio.js";

const enabled = process.env.GARBAGE_COLLECTION_RUNTIME_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const skip = enabled ? false : "explicit GARBAGE_COLLECTION_RUNTIME_TESTS=1 + DATABASE_URL required (real MinIO deletes)";

test("deleting an Asset's DB row makes its object eligible, and cleanup removes it", { skip }, async () => {
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  const minio = createWorkerMinio(config);
  const suffix = randomUUID();
  const owner = await db.user.create({ data: { email: `deleted-asset-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `deleted-asset-${suffix}` }, select: { id: true } });
  const key = `deleted-asset-test/${dataset.id}/object`;
  try {
    await minio.putObject(config.MINIO_BUCKET, key, Buffer.from("x"));
    const asset = await db.asset.create({
      data: {
        datasetId: dataset.id, modality: "TEXT", filename: "a.txt", mimeType: "text/plain",
        sourceMode: "UPLOAD", storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET,
        storageKey: key, sourceFingerprint: key, status: "READY", textAsset: { create: { tokenization: {}, metadata: {} } },
      },
      select: { id: true },
    });

    // While the Asset row still exists and references the key, cleanup must
    // not remove it (mirrors the shared primitive's own referenced-object
    // guarantee, exercised here through this asset-specific entry point).
    const beforeDelete = await cleanupDeletedAssetObject({ db, minio, bucket: config.MINIO_BUCKET, key });
    assert.deepEqual(beforeDelete.deleted, []);
    await minio.statObject(config.MINIO_BUCKET, key);

    // Soft-delete the Asset (the schema's forward-compatible field this
    // feature's audit found no current writer for) — the object is now
    // unreferenced by the shared check.
    await db.asset.update({ where: { id: asset.id }, data: { deletedAt: new Date() } });
    const afterDelete = await cleanupDeletedAssetObject({ db, minio, bucket: config.MINIO_BUCKET, key });
    assert.deepEqual(afterDelete.deleted, [key]);
    await assert.rejects(() => minio.statObject(config.MINIO_BUCKET, key));
  } finally {
    await minio.removeObject(config.MINIO_BUCKET, key).catch(() => undefined);
    await db.dataset.deleteMany({ where: { id: dataset.id } });
    await db.user.deleteMany({ where: { id: owner.id } });
    await db.$disconnect();
  }
});

test("cleanup is safe and retryable when the Asset row is already gone entirely", { skip }, async () => {
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  const minio = createWorkerMinio(config);
  const suffix = randomUUID();
  const key = `deleted-asset-test/no-row-${suffix}/object`;
  try {
    await minio.putObject(config.MINIO_BUCKET, key, Buffer.from("x"));
    // No Asset row was ever created for this key — simulates the row having
    // already been hard-deleted by the time cleanup runs (FR-026).
    const first = await cleanupDeletedAssetObject({ db, minio, bucket: config.MINIO_BUCKET, key });
    assert.deepEqual(first.deleted, [key]);
    // Retrying after the object is already gone must not throw — it is a
    // safe, idempotent no-op (FR-031).
    const second = await cleanupDeletedAssetObject({ db, minio, bucket: config.MINIO_BUCKET, key });
    assert.deepEqual(second, { scanned: 1, orphans: [key], deleted: [], tooYoung: [], failed: [] });
  } finally {
    await minio.removeObject(config.MINIO_BUCKET, key).catch(() => undefined);
    await db.$disconnect();
  }
});
