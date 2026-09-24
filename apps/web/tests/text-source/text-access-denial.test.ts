import assert from "node:assert/strict";
import test from "node:test";
import { DatasetMemberRole, Modality, UserRole } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { getWebProviders } from "../../src/lib/providers.js";
import { readTextSource } from "../../src/lib/annotations/text-source-read-service.js";
import { requestTextSourcePreparation } from "../../src/lib/annotations/text-source-prepare-service.js";
import { createWorkspaceUser, createWorkspaceDataset, addWorkspaceMember, cleanupWorkspaceFixture, workspaceUnique } from "../workspace/helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT);

/**
 * T053: a removed member and a cross-dataset actor both get the existing
 * concealed-resource behavior (404, indistinguishable from a nonexistent
 * asset) with no source excerpt disclosed anywhere in the response.
 */

async function seedTextAssetWithRealSource(datasetId: string, text: string) {
  const { config, minio } = getWebProviders();
  const marker = workspaceUnique("access-denial");
  const storageKey = `text-sources/__test-fixtures__/${marker}/source.txt`;
  const bytes = Buffer.from(text, "utf8");
  await minio.putObject(config.MINIO_BUCKET, storageKey, bytes, bytes.length, { "Content-Type": "text/plain" });
  const asset = await db.asset.create({
    data: { datasetId, modality: Modality.TEXT, filename: `${marker}.txt`, mimeType: "text/plain", storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET, storageKey, sourceFingerprint: marker },
    select: { id: true },
  });
  return { assetId: asset.id, storageKey, config, minio };
}

test("a removed member (was a LABELER, then revoked) is concealed exactly like a stranger -- no source excerpt anywhere in either outcome", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const removedMember = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  const fixture = await seedTextAssetWithRealSource(dataset.id, "OpenAI builds AI.");

  const membership = await addWorkspaceMember(dataset.id, removedMember.id, DatasetMemberRole.LABELER);
  // While a member, the actor can read.
  const whileMember = await readTextSource(removedMember, fixture.assetId);
  assert.equal(whileMember.ok, true);

  // Revoke membership (the same mechanism a real "remove member" action uses).
  await db.datasetMember.delete({ where: { id: membership.id } });

  try {
    const afterRemoval = await readTextSource(removedMember, fixture.assetId);
    assert.deepEqual(afterRemoval, { ok: false, reason: "NOT_FOUND" });
    assert.equal(JSON.stringify(afterRemoval).includes("OpenAI"), false, "no source excerpt leaks into a denied outcome");

    const prepareAfterRemoval = await requestTextSourcePreparation(removedMember, fixture.assetId);
    assert.deepEqual(prepareAfterRemoval, { ok: false, reason: "NOT_FOUND" });
  } finally {
    await fixture.minio.removeObject(fixture.config.MINIO_BUCKET, fixture.storageKey).catch(() => undefined);
    await cleanupWorkspaceFixture([owner.id, removedMember.id], [dataset.id]);
  }
});

test("a member of a different dataset cannot read or prepare a TEXT asset that belongs to another dataset -- concealed as NOT_FOUND, not FORBIDDEN", { skip: !hasIntegrationDatabase }, async () => {
  const ownerA = await createWorkspaceUser(UserRole.MANAGER);
  const ownerB = await createWorkspaceUser(UserRole.MANAGER);
  const datasetA = await createWorkspaceDataset(ownerA.id);
  const datasetB = await createWorkspaceDataset(ownerB.id);
  const crossDatasetActor = await createWorkspaceUser(UserRole.LABELER);
  await addWorkspaceMember(datasetB.id, crossDatasetActor.id, DatasetMemberRole.LABELER);
  const fixture = await seedTextAssetWithRealSource(datasetA.id, "cross-dataset fixture");

  try {
    // A member of dataset B, with no relationship to dataset A, requests an asset in A.
    const crossDatasetRead = await readTextSource(crossDatasetActor, fixture.assetId);
    assert.deepEqual(crossDatasetRead, { ok: false, reason: "NOT_FOUND" });
    assert.equal(JSON.stringify(crossDatasetRead).includes("cross-dataset fixture"), false);

    const crossDatasetPrepare = await requestTextSourcePreparation(crossDatasetActor, fixture.assetId);
    assert.deepEqual(crossDatasetPrepare, { ok: false, reason: "NOT_FOUND" });

    // The dataset A owner can, of course, still read their own asset --
    // proving the denial above is genuinely scope-based, not a fixture bug.
    const ownerRead = await readTextSource(ownerA, fixture.assetId);
    assert.equal(ownerRead.ok, true);
  } finally {
    await fixture.minio.removeObject(fixture.config.MINIO_BUCKET, fixture.storageKey).catch(() => undefined);
    await cleanupWorkspaceFixture([ownerA.id, ownerB.id, crossDatasetActor.id], [datasetA.id, datasetB.id]);
  }
});
