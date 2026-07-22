import assert from "node:assert/strict";
import test from "node:test";

import { DatasetMemberRole, UserRole } from "@internal/db";

import { createBoundingBox, deleteBoundingBox, updateBoundingBoxGeometry, updateBoundingBoxLabel } from "@/lib/workspace/image-mutations";
import { addWorkspaceMember, cleanupWorkspaceFixture, createImageAsset, createImageLabel, createWorkspaceDataset, createWorkspaceUser } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("concurrent Annotation edits allow one current revision and preserve the winner", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const manager = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    await addWorkspaceMember(dataset.id, manager.id, DatasetMemberRole.MANAGER);
    const asset = await createImageAsset(dataset.id);
    const label = await createImageLabel(dataset.id);
    const created = await createBoundingBox(owner, { datasetId: dataset.id, assetId: asset.id, labelId: label.id, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const [first, stale] = await Promise.all([
      updateBoundingBoxGeometry(owner, { datasetId: dataset.id, assetId: asset.id, annotationId: created.value.id, version: created.value.version, geometry: { x: 0.2, y: 0.1, width: 0.2, height: 0.2 } }),
      updateBoundingBoxGeometry(manager, { datasetId: dataset.id, assetId: asset.id, annotationId: created.value.id, version: created.value.version, geometry: { x: 0.3, y: 0.1, width: 0.2, height: 0.2 } }),
    ]);
    assert.equal([first, stale].filter((result) => result.ok).length, 1);
    assert.equal([first, stale].filter((result) => !result.ok && result.status === 409).length, 1);
    const winner = first.ok ? first.value : stale.ok ? stale.value : null;
    assert.ok(winner);
    const labelStale = await updateBoundingBoxLabel(manager, { datasetId: dataset.id, assetId: asset.id, annotationId: created.value.id, version: created.value.version, labelId: null });
    assert.deepEqual(labelStale, { ok: false, status: 409 });
    const deleteStale = await deleteBoundingBox(manager, { datasetId: dataset.id, assetId: asset.id, annotationId: created.value.id, version: created.value.version });
    assert.deepEqual(deleteStale, { ok: false, status: 409 });
  } finally { await cleanupWorkspaceFixture([owner.id, manager.id], [dataset.id]); }
});
