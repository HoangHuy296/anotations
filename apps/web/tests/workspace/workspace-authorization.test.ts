import assert from "node:assert/strict";
import test from "node:test";

import { DatasetMemberRole, UserRole } from "@internal/db";

import { createBoundingBox, updateBoundingBoxGeometry } from "@/lib/workspace/image-mutations";
import { readImageWorkspaceAsset, readImageWorkspacePage } from "@/lib/workspace/image-workspace";
import { addWorkspaceMember, cleanupWorkspaceFixture, createImageAsset, createImageLabel, createWorkspaceDataset, createWorkspaceUser } from "./helpers";

// Database cases are deliberately opt-in. They never replace PostgreSQL with a
// mock; this keeps the default focused suite useful when Compose is offline.
const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("workspace read conceals another Dataset and revision guards reject stale writes", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  const outsider = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  const otherDataset = await createWorkspaceDataset(outsider.id);
  try {
    await addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER);
    const asset = await createImageAsset(dataset.id);
    const label = await createImageLabel(dataset.id);
    const created = await createBoundingBox(labeler, { datasetId: dataset.id, assetId: asset.id, labelId: label.id, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const update = await updateBoundingBoxGeometry(labeler, { datasetId: dataset.id, assetId: asset.id, annotationId: created.value.id, version: created.value.version, geometry: { x: 0.2, y: 0.1, width: 0.2, height: 0.2 } });
    assert.equal(update.ok, true);
    const stale = await updateBoundingBoxGeometry(labeler, { datasetId: dataset.id, assetId: asset.id, annotationId: created.value.id, version: created.value.version, geometry: { x: 0.3, y: 0.1, width: 0.2, height: 0.2 } });
    assert.deepEqual(stale, { ok: false, status: 409 });
    assert.equal(await readImageWorkspaceAsset(outsider, dataset.id, asset.id), null);
    assert.equal(await readImageWorkspaceAsset(owner, otherDataset.id, asset.id), null);
    assert.equal(await readImageWorkspacePage(outsider, dataset.id, { search: asset.filename }), null);
    const progress = await readImageWorkspacePage(owner, dataset.id);
    assert.equal(progress?.page.total, 1);
    assert.equal(progress?.page.completed, 0);
  } finally { await cleanupWorkspaceFixture([owner.id, labeler.id, outsider.id], [dataset.id, otherDataset.id]); }
});
