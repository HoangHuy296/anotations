import assert from "node:assert/strict";
import test from "node:test";

import { Modality, UserRole } from "@internal/db";

import { readDatasetOverview } from "@/lib/datasets/dataset-overview-service";
import { db } from "@/lib/db";
import { cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser, workspaceUnique } from "../workspace/helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

/** T050 (022): Dataset Overview counts, modality breakdown, progress, annotation count, and created/updated. */
test("reports accurate asset counts (including zero-count modalities), annotation count, and progress", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const marker = workspaceUnique("overview");
    const label = await db.label.create({ data: { datasetId: dataset.id, name: "cat", normalizedName: `cat-${marker}`, color: "#000000", modality: Modality.IMAGE }, select: { id: true } });
    const completed = await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: `${marker}-a.png`, mimeType: "image/png", sourceFingerprint: `${marker}-a`, status: "COMPLETED" }, select: { id: true } });
    await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: `${marker}-b.png`, mimeType: "image/png", sourceFingerprint: `${marker}-b`, status: "NEW" } });
    await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.VIDEO, filename: `${marker}-c.mp4`, mimeType: "video/mp4", sourceFingerprint: `${marker}-c`, status: "NEW" } });
    await db.annotation.create({ data: { datasetId: dataset.id, assetId: completed.id, labelId: label.id, createdById: owner.id, modality: Modality.IMAGE, type: "BOUNDING_BOX", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } } });

    const result = await readDatasetOverview(owner, dataset.id);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.overview.assetCounts.total, 3);
    assert.equal(result.overview.assetCounts.byModality.IMAGE, 2);
    assert.equal(result.overview.assetCounts.byModality.VIDEO, 1);
    assert.equal(result.overview.assetCounts.byModality.AUDIO, 0, "a zero-count modality is still present, not omitted");
    assert.equal(result.overview.assetCounts.byModality.TEXT, 0);
    assert.equal(result.overview.annotationCount, 1);
    assert.equal(result.overview.progress.totalAssets, 3);
    assert.equal(result.overview.progress.completedAssets, 1, "only the non-NEW asset counts toward progress -- the same definition the workspace tabs already use");
    assert.ok(result.overview.dataset.createdAt);
    assert.ok(result.overview.dataset.updatedAt);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("a dataset with zero assets returns a valid empty overview, not an error", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const result = await readDatasetOverview(owner, dataset.id);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.overview.assetCounts, { total: 0, byModality: { IMAGE: 0, VIDEO: 0, TEXT: 0, AUDIO: 0 } });
    assert.equal(result.overview.annotationCount, 0);
    assert.deepEqual(result.overview.progress, { completedAssets: 0, totalAssets: 0 });
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});
