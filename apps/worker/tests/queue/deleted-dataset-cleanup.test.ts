import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import {
  captureDatasetAssetStorageKeys,
  cleanupDatasetStorageObjects,
  hardDeleteDatasetAndCaptureStorageKeys,
} from "../../src/queue/deleted-dataset-cleanup.js";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { createWorkerMinio } from "../../src/providers/minio.js";

const enabled = process.env.GARBAGE_COLLECTION_RUNTIME_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const skip = enabled ? false : "explicit GARBAGE_COLLECTION_RUNTIME_TESTS=1 + DATABASE_URL required (real MinIO deletes)";

async function setupDatasetWithAssets(count: number) {
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  const minio = createWorkerMinio(config);
  const suffix = randomUUID();
  const owner = await db.user.create({ data: { email: `deleted-dataset-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `deleted-dataset-${suffix}` }, select: { id: true } });
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const key = `deleted-dataset-test/${dataset.id}/asset-${i}`;
    await minio.putObject(config.MINIO_BUCKET, key, Buffer.from("x"));
    keys.push(key);
    await db.asset.create({
      data: {
        datasetId: dataset.id, modality: "TEXT", filename: `a${i}.txt`, mimeType: "text/plain",
        sourceMode: "UPLOAD", storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET,
        storageKey: key, sourceFingerprint: key, status: "READY", textAsset: { create: { tokenization: {}, metadata: {} } },
      },
    });
  }
  return { config, db, minio, owner, dataset, keys };
}

test("captureDatasetAssetStorageKeys reads every Asset's storage key before any deletion", { skip }, async () => {
  const { db, dataset, keys, owner } = await setupDatasetWithAssets(3);
  try {
    const captured = await captureDatasetAssetStorageKeys(db, dataset.id);
    assert.deepEqual(captured.map((c) => c.key).sort(), [...keys].sort());
  } finally {
    await db.dataset.deleteMany({ where: { id: dataset.id } });
    await db.user.deleteMany({ where: { id: owner.id } });
    await db.$disconnect();
  }
});

test("hard-deleting a Dataset captures its Assets' storage keys before the cascade removes those rows, then the cleanup pass removes every object", { skip }, async () => {
  const { config, db, minio, owner, dataset, keys } = await setupDatasetWithAssets(3);
  let cleanedUp = false;
  try {
    const captured = await hardDeleteDatasetAndCaptureStorageKeys(db, dataset.id);
    assert.deepEqual(captured.map((c) => c.key).sort(), [...keys].sort(), "keys were captured, not silently dropped by the cascade");

    // The cascade already ran — confirm the Asset rows (and the Dataset
    // itself) are genuinely gone, not merely archived.
    assert.equal(await db.asset.count({ where: { datasetId: dataset.id } }), 0);
    assert.equal(await db.dataset.count({ where: { id: dataset.id } }), 0);

    // The objects themselves are untouched by the DB-level cascade — still
    // exist in MinIO until the batched cleanup pass removes them.
    for (const key of keys) await minio.statObject(config.MINIO_BUCKET, key);

    const result = await cleanupDatasetStorageObjects({ db, minio, keys: captured });
    cleanedUp = true;
    assert.deepEqual(result.deleted.sort(), [...keys].sort());
    for (const key of keys) await assert.rejects(() => minio.statObject(config.MINIO_BUCKET, key));
  } finally {
    if (!cleanedUp) await Promise.all(keys.map((key) => minio.removeObject(config.MINIO_BUCKET, key).catch(() => undefined)));
    await db.dataset.deleteMany({ where: { id: dataset.id } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: owner.id } });
    await db.$disconnect();
  }
});

test("cleanupDatasetStorageObjects processes a large key list in bounded batches without missing any", { skip }, async () => {
  const { config, db, minio, owner, dataset, keys } = await setupDatasetWithAssets(7);
  try {
    const captured = await captureDatasetAssetStorageKeys(db, dataset.id);
    await db.dataset.delete({ where: { id: dataset.id } });
    const result = await cleanupDatasetStorageObjects({ db, minio, keys: captured, batchSize: 3 });
    assert.equal(result.deleted.length, 7);
    assert.deepEqual(result.deleted.sort(), [...keys].sort());
  } finally {
    await Promise.all(keys.map((key) => minio.removeObject(config.MINIO_BUCKET, key).catch(() => undefined)));
    await db.user.deleteMany({ where: { id: owner.id } });
    await db.$disconnect();
  }
});
