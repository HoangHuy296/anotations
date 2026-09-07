import assert from "node:assert/strict";
import test from "node:test";

import { Modality, UserRole } from "@internal/db";

import { readDatasetOverview } from "@/lib/datasets/dataset-overview-service";
import { db } from "@/lib/db";
import { cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser, workspaceUnique } from "../workspace/helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

/**
 * T051 (022): Dataset Health is data-integrity/operational only (FR-034) --
 * never an annotation-quality metric. Both the positive detection and the
 * negative "never quality-shaped" guard are asserted here.
 */
test("detects a missing storage reference on an otherwise-ready asset", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const marker = workspaceUnique("health-missing-storage");
    await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: `${marker}.png`, mimeType: "image/png", sourceFingerprint: marker, status: "READY", storageKey: null } });
    const result = await readDatasetOverview(owner, dataset.id);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.overview.health.missingStorageReferences, 1);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("a NEW asset with no storage reference yet is not flagged -- it hasn't reached a state where one is expected", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const marker = workspaceUnique("health-new-asset");
    await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: `${marker}.png`, mimeType: "image/png", sourceFingerprint: marker, status: "NEW", storageKey: null } });
    const result = await readDatasetOverview(owner, dataset.id);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.overview.health.missingStorageReferences, 0);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("detects an asset sync conflict", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const marker = workspaceUnique("health-sync-conflict");
    await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: `${marker}.png`, mimeType: "image/png", sourceFingerprint: marker, syncStatus: "CONFLICT" } });
    const result = await readDatasetOverview(owner, dataset.id);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.overview.health.syncConflicts, 1);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("a dataset with no data-integrity problems reports a clean health block, with no field resembling an annotation-quality metric", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const result = await readDatasetOverview(owner, dataset.id);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.overview.health, { missingStorageReferences: 0, syncConflicts: 0, failedJobs: 0, incompleteImports: 0 });
    const serializedKeys = Object.keys(result.overview.health).join(" ").toLowerCase();
    for (const forbidden of ["quality", "agreement", "accuracy", "acceptance", "reviewer"]) {
      assert.equal(serializedKeys.includes(forbidden), false, `health must never expose a "${forbidden}"-named field`);
    }
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});
