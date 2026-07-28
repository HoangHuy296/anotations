import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { safeCleanupUnpublishedObject } from "../../src/jobs/repository-asset-mirror.js";
import { createWorkerDatabase } from "../../src/providers/db.js";
import { createWorkerMinio } from "../../src/providers/minio.js";

const enabled = process.env.REPOSITORY_IMPORT_RUNTIME_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("compensation deletes only unreferenced in-scope objects and preserves Asset references", { skip: enabled ? false : "explicit controlled MinIO runtime required" }, async () => {
  const config = getWorkerConfig();
  const db = createWorkerDatabase(config);
  const minio = createWorkerMinio(config);
  const suffix = randomUUID();
  const datasetId = `phase016-cleanup-${suffix}`;
  const orphanKey = `repository-imports/${datasetId}/orphan`;
  const referencedKey = `repository-imports/${datasetId}/referenced`;
  const outOfScopeKey = `direct-uploads/${datasetId}/outside`;
  let createdDataset: string | null = null;
  try {
    const owner = await db.user.create({ data: { email: `phase016-cleanup-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: datasetId, sourceMode: "MIRROR_TO_MINIO" }, select: { id: true } });
    createdDataset = dataset.id;
    const key = (value: string) => value.replace(datasetId, dataset.id);
    await Promise.all([minio.putObject(config.MINIO_BUCKET, key(orphanKey), Buffer.from("x")), minio.putObject(config.MINIO_BUCKET, key(referencedKey), Buffer.from("x")), minio.putObject(config.MINIO_BUCKET, key(outOfScopeKey), Buffer.from("x"))]);
    await db.asset.create({ data: { datasetId: dataset.id, modality: "TEXT", filename: "referenced.txt", mimeType: "text/plain", sourceMode: "MIRROR_TO_MINIO", storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET, storageKey: key(referencedKey), sourceFingerprint: `phase016-cleanup-${suffix}`, textDocument: { create: { tokenization: {}, metadata: {} } } } });
    assert.equal(await safeCleanupUnpublishedObject(db, { bucket: config.MINIO_BUCKET, objectKey: key(orphanKey), datasetId: dataset.id }), true);
    await assert.rejects(() => minio.statObject(config.MINIO_BUCKET, key(orphanKey)));
    assert.equal(await safeCleanupUnpublishedObject(db, { bucket: config.MINIO_BUCKET, objectKey: key(referencedKey), datasetId: dataset.id }), false);
    await minio.statObject(config.MINIO_BUCKET, key(referencedKey));
    assert.equal(await safeCleanupUnpublishedObject(db, { bucket: config.MINIO_BUCKET, objectKey: key(outOfScopeKey), datasetId: dataset.id }), false);
    await minio.statObject(config.MINIO_BUCKET, key(outOfScopeKey));
  } finally {
    if (createdDataset) await db.dataset.delete({ where: { id: createdDataset } }).catch(() => undefined);
    const prefix = `phase016-cleanup-${suffix}`;
    await Promise.all([orphanKey, referencedKey, outOfScopeKey].map((key) => minio.removeObject(config.MINIO_BUCKET, key.replace(prefix, createdDataset ?? prefix)).catch(() => undefined)));
    await db.$disconnect();
  }
});
