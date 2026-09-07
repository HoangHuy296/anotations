import assert from "node:assert/strict";
import test from "node:test";

import { AssetStatus, Modality, UserRole } from "@internal/db";

import { changeStatusBulk } from "@/lib/assets/asset-bulk-service";
import { db } from "@/lib/db";
import { cleanupWorkspaceFixture, createImageAsset, createImageLabel, createWorkspaceDataset, createWorkspaceUser, workspaceUnique } from "../workspace/helpers";
import { createBoundingBox } from "@/lib/workspace/image-mutations";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

/** T022 (022): Change Status touches Asset.status only -- Annotation/Job/AI task status for the same assets stay untouched (FR-017). */
test("Change Status updates only Asset.status, leaving Annotation status on the same assets untouched", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const label = await createImageLabel(dataset.id);
    const asset = await createImageAsset(dataset.id);
    const created = await createBoundingBox(owner, { datasetId: dataset.id, assetId: asset.id, labelId: label.id, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const annotationStatusBefore = created.value.status;

    const result = await changeStatusBulk(dataset.id, [asset.id], [], AssetStatus.READY);
    assert.deepEqual(result, { processed: 1, succeeded: 1, failed: 0, skipped: 0, failures: [] });

    const refreshedAsset = await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { status: true } });
    assert.equal(refreshedAsset.status, AssetStatus.NEEDS_REVIEW);
    const refreshedAnnotation = await db.annotation.findUniqueOrThrow({ where: { id: created.value.id }, select: { status: true } });
    assert.equal(refreshedAnnotation.status, annotationStatusBefore, "Annotation status must be completely unaffected by an Asset status change");
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("Setting an asset to its current status is a genuine no-op success, not a skip or failure", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const marker = workspaceUnique("same-status");
    const asset = await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: `${marker}.png`, mimeType: "image/png", sourceFingerprint: marker, status: AssetStatus.READY } });
    const result = await changeStatusBulk(dataset.id, [asset.id], [], AssetStatus.READY);
    assert.deepEqual(result, { processed: 1, succeeded: 1, failed: 0, skipped: 0, failures: [] });
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});
