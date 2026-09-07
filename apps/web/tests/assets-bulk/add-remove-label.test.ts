import assert from "node:assert/strict";
import test from "node:test";

import { UserRole } from "@internal/db";

import { createBoundingBox } from "@/lib/workspace/image-mutations";
import { addLabelBulk, removeLabelBulk } from "@/lib/assets/asset-bulk-service";
import { findAssetsWithAnnotationsReferencingLabel, resolveOrCreateLabel } from "@/lib/assets/asset-label-service";
import { db } from "@/lib/db";
import { cleanupWorkspaceFixture, createImageAsset, createImageLabel, createWorkspaceDataset, createWorkspaceUser } from "../workspace/helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

/** T021 (022): Add/Remove Label modify Asset metadata only, are idempotent, and never touch Annotation data. */
test("Add Label attaches an existing label to every selected asset, idempotently, without creating any Annotation", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const label = await createImageLabel(dataset.id, "cat");
    const assetA = await createImageAsset(dataset.id, { filename: "a.png" });
    const assetB = await createImageAsset(dataset.id, { filename: "b.png" });
    const annotationCountBefore = await db.annotation.count({ where: { datasetId: dataset.id } });

    const first = await addLabelBulk([assetA.id, assetB.id], [], label.id, owner.id);
    assert.deepEqual(first, { processed: 2, succeeded: 2, failed: 0, skipped: 0, failures: [] });

    const attachments = await db.assetLabel.findMany({ where: { assetId: { in: [assetA.id, assetB.id] }, labelId: label.id } });
    assert.equal(attachments.length, 2);
    assert.equal(await db.annotation.count({ where: { datasetId: dataset.id } }), annotationCountBefore, "Add Label must never create an Annotation");

    // Idempotency: re-adding the same label reports skipped, not failed, and creates no duplicate row.
    const replay = await addLabelBulk([assetA.id, assetB.id], [], label.id, owner.id);
    assert.deepEqual(replay, { processed: 2, succeeded: 0, failed: 0, skipped: 2, failures: [{ assetId: assetA.id, reason: "already_labeled" }, { assetId: assetB.id, reason: "already_labeled" }] });
    assert.equal(await db.assetLabel.count({ where: { assetId: { in: [assetA.id, assetB.id] }, labelId: label.id } }), 2, "no duplicate AssetLabel rows after replay");
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("resolveOrCreateLabel creates a new label inline, reusing an existing one on a name collision rather than duplicating", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const created = await resolveOrCreateLabel(dataset.id, { createLabel: { name: "New Label", color: "#0EA5E9" } });
    assert.equal(created.ok, true);
    const collision = await resolveOrCreateLabel(dataset.id, { createLabel: { name: "new label", color: "#111111" } });
    assert.equal(collision.ok, true);
    if (created.ok && collision.ok) assert.equal(collision.labelId, created.labelId, "a normalized-name collision reuses the existing label, never duplicates");
    const count = await db.label.count({ where: { datasetId: dataset.id } });
    assert.equal(count, 1);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("Remove Label removes only the Asset-Label attachment, leaving Annotations that reference the label untouched, and is idempotent", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const label = await createImageLabel(dataset.id, "vehicle");
    const asset = await createImageAsset(dataset.id);
    await db.assetLabel.create({ data: { assetId: asset.id, labelId: label.id } });
    const annotation = await createBoundingBox(owner, { datasetId: dataset.id, assetId: asset.id, labelId: label.id, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } });
    assert.equal(annotation.ok, true);

    const referencing = await findAssetsWithAnnotationsReferencingLabel([asset.id], label.id);
    assert.deepEqual(referencing, [asset.id], "the warning check finds the referencing asset before removal");

    const result = await removeLabelBulk([asset.id], [], label.id);
    assert.deepEqual(result, { processed: 1, succeeded: 1, failed: 0, skipped: 0, failures: [] });
    assert.equal(await db.assetLabel.count({ where: { assetId: asset.id, labelId: label.id } }), 0, "the attachment is gone");

    const stillReferencing = await db.annotation.findFirst({ where: { assetId: asset.id, labelId: label.id }, select: { id: true } });
    assert.ok(stillReferencing, "the Annotation referencing this label is completely unchanged -- Remove Asset Label != Remove Annotation Label");

    // Idempotency: removing an already-absent attachment is skipped, not failed.
    const replay = await removeLabelBulk([asset.id], [], label.id);
    assert.deepEqual(replay, { processed: 1, succeeded: 0, failed: 0, skipped: 1, failures: [{ assetId: asset.id, reason: "not_labeled" }] });
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("selection ids outside the dataset are reported skipped as not_in_dataset, never acted on", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const otherDataset = await createWorkspaceDataset(owner.id);
  try {
    const label = await createImageLabel(dataset.id, "object");
    const inScope = await createImageAsset(dataset.id);
    const outsideScope = await createImageAsset(otherDataset.id);
    // Simulates what `resolveBulkSelection` would already have filtered out --
    // this proves the per-item service function itself never silently acts
    // on an id it wasn't told belongs to the dataset.
    const result = await addLabelBulk([inScope.id], [outsideScope.id], label.id, owner.id);
    assert.equal(result.succeeded, 1);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.failures, [{ assetId: outsideScope.id, reason: "not_in_dataset" }]);
    assert.equal(await db.assetLabel.count({ where: { assetId: outsideScope.id } }), 0);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id, otherDataset.id]); }
});
