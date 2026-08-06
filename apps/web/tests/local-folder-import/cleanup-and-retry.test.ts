import assert from "node:assert/strict";
import test from "node:test";

import { AssetStatus, DatasetSourceMode, Modality, StorageProvider } from "@internal/db";

import { cleanupPreparedImportOrphans } from "@/lib/imports/import-cleanup";
import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";
import { configureLocalImportHostMinio, createPreparedImportFixture, hasImportIntegration, objectExists, uploadTestObject } from "./helpers";

test("cleanup removes only unreferenced objects inside its Dataset's prefix and is idempotent", { skip: !hasImportIntegration }, async () => {
  configureLocalImportHostMinio();
  const fixture = await createPreparedImportFixture();
  const { config, minio } = getDirectUploadProviders();
  const prefix = `prepared-imports/${fixture.dataset.id}/`;
  const orphan = `${prefix}orphan`;
  const published = `${prefix}published`;
  const outside = "prepared-imports/another-dataset/outside";
  try {
    await Promise.all([uploadTestObject(orphan), uploadTestObject(published), uploadTestObject(outside)]);
    await db.asset.create({ data: { datasetId: fixture.dataset.id, uploadedById: fixture.owner.id, modality: Modality.TEXT, filename: "published.txt", mimeType: "text/plain", sourceMode: DatasetSourceMode.UPLOAD, storageProvider: StorageProvider.MINIO, storageBucket: config.MINIO_BUCKET, storageKey: published, sourceFingerprint: published, status: AssetStatus.READY, textDocument: { create: { tokenization: {}, metadata: {} } } } });
    const first = await cleanupPreparedImportOrphans({ minio, bucket: config.MINIO_BUCKET, datasetId: fixture.dataset.id });
    const second = await cleanupPreparedImportOrphans({ minio, bucket: config.MINIO_BUCKET, datasetId: fixture.dataset.id });
    assert.equal(first.removed, 1); assert.equal(second.removed, 0);
    assert.equal(await objectExists(orphan), false); assert.equal(await objectExists(published), true); assert.equal(await objectExists(outside), true);
  } finally { await minio.removeObjects(config.MINIO_BUCKET, [orphan, published, outside]).catch(() => undefined); await fixture.cleanup(); }
});
