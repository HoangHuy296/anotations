import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Modality, UserRole } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { getWebProviders } from "../../src/lib/providers.js";
import { requestTextSourcePreparation } from "../../src/lib/annotations/text-source-prepare-service.js";
import { createWorkspaceUser, createWorkspaceDataset, workspaceUnique } from "../workspace/helpers.js";

const enabled = Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT && process.env.MINIO_ACCESS_KEY);
const skip = "text source prepare service integration skipped: PostgreSQL/MinIO configuration is unavailable";

async function seedTextAssetWithRealSource(datasetId: string, text: string) {
  const { config, minio } = getWebProviders();
  const marker = workspaceUnique("prepare-service");
  const storageKey = `text-sources/__test-fixtures__/${marker}/source.txt`;
  const bytes = Buffer.from(text, "utf8");
  await minio.putObject(config.MINIO_BUCKET, storageKey, bytes, bytes.length, { "Content-Type": "text/plain" });
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const asset = await db.asset.create({
    data: { datasetId, modality: Modality.TEXT, filename: `${marker}.txt`, mimeType: "text/plain", storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET, storageKey, checksum, sizeBytes: BigInt(bytes.length), sourceFingerprint: marker },
    select: { id: true },
  });
  return { assetId: asset.id, storageKey, config, minio };
}

test(enabled ? "requestTextSourcePreparation authorizes on dataset.read alone, independent of annotation.create, and idempotently reuses the Job for a repeated request" : skip, { skip: !enabled }, async (t) => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const fixture = await seedTextAssetWithRealSource(dataset.id, "requestTextSourcePreparation fixture");

  t.after(async () => {
    await fixture.minio.removeObject(fixture.config.MINIO_BUCKET, fixture.storageKey).catch(() => undefined);
    const textAsset = await db.textAsset.findUnique({ where: { assetId: fixture.assetId }, select: { boundaryArtifactKey: true } });
    if (textAsset?.boundaryArtifactKey) await fixture.minio.removeObject(fixture.config.MINIO_BUCKET, textAsset.boundaryArtifactKey).catch(() => undefined);
    await db.annotationMutationReceipt.deleteMany({ where: { assetId: fixture.assetId } });
    await db.job.deleteMany({ where: { datasetId: dataset.id } });
    await db.asset.deleteMany({ where: { datasetId: dataset.id } });
    await db.dataset.delete({ where: { id: dataset.id } });
    await db.user.delete({ where: { id: owner.id } });
  });

  const first = await requestTextSourcePreparation(owner, fixture.assetId);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.created, true);

  const job = await db.job.findUniqueOrThrow({ where: { id: first.job.id }, select: { type: true, modality: true, createdById: true, datasetId: true } });
  assert.equal(job.type, "TEXT_SOURCE_PREPARE");
  assert.equal(job.modality, "TEXT");
  assert.equal(job.createdById, owner.id);
  assert.equal(job.datasetId, dataset.id);

  // A second request for the same still-current source reuses the same Job.
  const second = await requestTextSourcePreparation(owner, fixture.assetId);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.job.id, first.job.id);
  assert.equal(second.created, false);
  assert.equal(await db.job.count({ where: { datasetId: dataset.id, type: "TEXT_SOURCE_PREPARE" } }), 1, "no duplicate Job for a repeated prepare request against the same source");
});

test(enabled ? "requestTextSourcePreparation conceals a TEXT asset from a non-member as NOT_FOUND" : skip, { skip: !enabled }, async (t) => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const outsider = await createWorkspaceUser(UserRole.LABELER);
  const fixture = await seedTextAssetWithRealSource(dataset.id, "concealed fixture");

  t.after(async () => {
    await fixture.minio.removeObject(fixture.config.MINIO_BUCKET, fixture.storageKey).catch(() => undefined);
    await db.job.deleteMany({ where: { datasetId: dataset.id } });
    await db.asset.deleteMany({ where: { datasetId: dataset.id } });
    await db.dataset.delete({ where: { id: dataset.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, outsider.id] } } });
  });

  const outcome = await requestTextSourcePreparation(outsider, fixture.assetId);
  assert.deepEqual(outcome, { ok: false, reason: "NOT_FOUND" });
});

test(enabled ? "requestTextSourcePreparation reports SOURCE_UNAVAILABLE for a TEXT asset with no uploaded object" : skip, { skip: !enabled }, async (t) => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const asset = await db.asset.create({
    data: { datasetId: dataset.id, modality: Modality.TEXT, filename: "no-object.txt", mimeType: "text/plain", sourceFingerprint: workspaceUnique("no-object") },
    select: { id: true },
  });

  t.after(async () => {
    await db.asset.deleteMany({ where: { datasetId: dataset.id } });
    await db.dataset.delete({ where: { id: dataset.id } });
    await db.user.delete({ where: { id: owner.id } });
  });

  const outcome = await requestTextSourcePreparation(owner, asset.id);
  assert.deepEqual(outcome, { ok: false, reason: "SOURCE_UNAVAILABLE" });
});
