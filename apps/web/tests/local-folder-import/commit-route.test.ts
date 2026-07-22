import assert from "node:assert/strict";
import test from "node:test";

import { AssetStatus, DatasetSourceMode, Modality, StorageProvider } from "@internal/db";

import { commitLocalFolderImport } from "@/lib/imports/commit-local-folder-import";
import { db } from "@/lib/db";
import { hasImportIntegration, createPreparedImportFixture, createPreparedImportItemFixture } from "./helpers";

async function publishFixtureAsset(datasetId: string, ownerId: string, key: string) {
  return db.asset.create({ data: { datasetId, uploadedById: ownerId, modality: Modality.TEXT, filename: "item.txt", mimeType: "text/plain", sourceMode: DatasetSourceMode.UPLOAD, storageProvider: StorageProvider.MINIO, storageBucket: "test", storageKey: key, sourceFingerprint: key, status: AssetStatus.READY, textDocument: { create: { tokenization: {}, metadata: {} } } }, select: { id: true } });
}

test("incomplete import commit is rejected without database or event side effects", { skip: !hasImportIntegration }, async () => {
  const fixture = await createPreparedImportFixture({ expectedItemCount: 2 });
  try {
    await createPreparedImportItemFixture(fixture.preparedImport.id, { position: 0 });
    await createPreparedImportItemFixture(fixture.preparedImport.id, { position: 1 });
    const before = await Promise.all([db.job.findUniqueOrThrow({ where: { id: fixture.job.id }, select: { status: true, updatedAt: true } }), db.jobEvent.count({ where: { jobId: fixture.job.id } }), db.asset.count({ where: { datasetId: fixture.dataset.id } })]);
    const result = await commitLocalFolderImport(fixture.owner, fixture.job.id);
    const after = await Promise.all([db.job.findUniqueOrThrow({ where: { id: fixture.job.id }, select: { status: true, updatedAt: true } }), db.jobEvent.count({ where: { jobId: fixture.job.id } }), db.asset.count({ where: { datasetId: fixture.dataset.id } })]);
    assert.equal(result.ok, false); assert.equal("code" in result && result.code, "IMPORT_INCOMPLETE");
    assert.deepEqual(after, before);
  } finally { await fixture.cleanup(); }
});

test("simultaneous complete commits produce one terminal transition and one event", { skip: !hasImportIntegration }, async () => {
  const fixture = await createPreparedImportFixture();
  try {
    const item = await createPreparedImportItemFixture(fixture.preparedImport.id);
    const asset = await publishFixtureAsset(fixture.dataset.id, fixture.owner.id, `asset-${item.id}`);
    await db.preparedImportItem.update({ where: { id: item.id }, data: { assetId: asset.id, completedAt: new Date() } });
    const [one, two] = await Promise.all([commitLocalFolderImport(fixture.owner, fixture.job.id), commitLocalFolderImport(fixture.owner, fixture.job.id)]);
    assert.equal(one.ok, true); assert.equal(two.ok, true);
    assert.equal(await db.jobEvent.count({ where: { jobId: fixture.job.id, message: "IMPORT_COMMITTED" } }), 1);
    assert.equal(await db.asset.count({ where: { datasetId: fixture.dataset.id } }), 1);
    const job = await db.job.findUniqueOrThrow({ where: { id: fixture.job.id }, select: { status: true } });
    assert.equal(job.status, "COMPLETED");
  } finally { await fixture.cleanup(); }
});
