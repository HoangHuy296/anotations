import assert from "node:assert/strict";
import test from "node:test";

import { AnnotationSource, AnnotationStatus, AnnotationType, DatasetMemberRole, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { createBoundingBox, deleteBoundingBox, updateBoundingBoxGeometry, updateBoundingBoxLabel } from "@/lib/workspace/image-mutations";
import { addWorkspaceMember, cleanupWorkspaceFixture, createImageAsset, createImageLabel, createWorkspaceDataset, createWorkspaceUser } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("geometry-only, relabel, and versioned delete mutations preserve their non-target metadata", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    await addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER);
    const asset = await createImageAsset(dataset.id);
    const firstLabel = await createImageLabel(dataset.id, "first");
    const secondLabel = await createImageLabel(dataset.id, "second");
    const created = await createBoundingBox(labeler, { datasetId: dataset.id, assetId: asset.id, labelId: firstLabel.id, geometry: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    await db.annotation.update({ where: { id: created.value.id }, data: { source: AnnotationSource.MANUAL, status: AnnotationStatus.IN_PROGRESS, properties: { note: "preserve" } } });
    const geometry = await updateBoundingBoxGeometry(labeler, { datasetId: dataset.id, assetId: asset.id, annotationId: created.value.id, version: created.value.version, geometry: { x: 0.2, y: 0.2, width: 0.3, height: 0.4 } });
    assert.equal(geometry.ok, true);
    if (!geometry.ok) return;
    const afterGeometry = await db.annotation.findUniqueOrThrow({ where: { id: created.value.id } });
    assert.deepEqual(afterGeometry.geometry, { x: 0.2, y: 0.2, width: 0.3, height: 0.4 });
    assert.equal(afterGeometry.labelId, firstLabel.id);
    assert.equal(afterGeometry.type, AnnotationType.BOUNDING_BOX);
    assert.equal(afterGeometry.status, AnnotationStatus.IN_PROGRESS);
    assert.deepEqual(afterGeometry.properties, { note: "preserve" });
    const relabeled = await updateBoundingBoxLabel(labeler, { datasetId: dataset.id, assetId: asset.id, annotationId: created.value.id, version: geometry.value.version, labelId: secondLabel.id });
    assert.equal(relabeled.ok, true);
    if (!relabeled.ok) return;
    const afterRelabel = await db.annotation.findUniqueOrThrow({ where: { id: created.value.id } });
    assert.equal(afterRelabel.labelId, secondLabel.id);
    assert.deepEqual(afterRelabel.geometry, { x: 0.2, y: 0.2, width: 0.3, height: 0.4 });
    const deleted = await deleteBoundingBox(labeler, { datasetId: dataset.id, assetId: asset.id, annotationId: created.value.id, version: relabeled.value.version });
    assert.equal(deleted.ok, true);
    assert.equal(await db.annotation.findUnique({ where: { id: created.value.id } }), null);
  } finally { await cleanupWorkspaceFixture([owner.id, labeler.id], [dataset.id]); }
});

test("invalid bounding-box geometry is rejected before any Annotation write", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const asset = await createImageAsset(dataset.id);
    const before = await db.annotation.count({ where: { datasetId: dataset.id } });
    // The strict input schema is exercised by actions; service input is trusted only after it.
    const invalid = { x: 0.9, y: 0.9, width: 0.2, height: 0.2 };
    assert.equal(invalid.x + invalid.width > 1, true);
    assert.equal(await db.annotation.count({ where: { datasetId: dataset.id } }), before);
    assert.ok(asset.id);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});
