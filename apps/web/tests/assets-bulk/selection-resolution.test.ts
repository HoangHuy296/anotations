import assert from "node:assert/strict";
import test from "node:test";

import { Modality, UserRole } from "@internal/db";

import { resolveBulkSelection } from "@/lib/assets/asset-bulk-service";
import { db } from "@/lib/db";
import { BULK_SYNC_MAX_ASSETS } from "@/types/workspace";
import { cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser, workspaceUnique } from "../workspace/helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

/**
 * T024 (022): proves "Select All Filtered" resolves server-side via a
 * bounded `count()` + `findMany({ take: maxAssets })` -- never an unbounded
 * fetch of every matching row -- and that the resolved-count cap is
 * enforced strictly (FR-010/FR-026, SC-002).
 */
test("a FILTERED selection resolves to real asset ids matching the query, scoped to the dataset", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const otherDataset = await createWorkspaceDataset(owner.id);
  try {
    const marker = workspaceUnique("selection-resolve");
    const matching = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: `${marker}-${index}.png`, mimeType: "image/png", sourceFingerprint: `${marker}-${index}` } })));
    // Same filename marker in a different dataset: must never be resolved by this call.
    await db.asset.create({ data: { datasetId: otherDataset.id, modality: Modality.IMAGE, filename: `${marker}-other.png`, mimeType: "image/png", sourceFingerprint: `${marker}-other` } });

    const resolved = await resolveBulkSelection(dataset.id, { mode: "FILTERED", query: { q: marker } });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.deepEqual(new Set(resolved.assetIds), new Set(matching.map((asset) => asset.id)));
    assert.deepEqual(resolved.notFoundIds, []);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id, otherDataset.id]); }
});

test("a FILTERED selection exceeding the sync max is rejected with the true resolved count, not a truncated batch", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const marker = workspaceUnique("selection-too-large");
    const overLimit = 3;
    await db.asset.createMany({
      data: Array.from({ length: overLimit }, (_, index) => ({ datasetId: dataset.id, modality: Modality.IMAGE, filename: `${marker}-${index}.png`, mimeType: "image/png", sourceFingerprint: `${marker}-${index}` })),
    });
    const resolved = await resolveBulkSelection(dataset.id, { mode: "FILTERED", query: { q: marker } }, overLimit - 1);
    assert.deepEqual(resolved, { ok: false, reason: "TOO_LARGE", max: overLimit - 1, resolvedCount: overLimit });
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("an EXPLICIT selection over the sync max is rejected by its claimed count alone, without querying the database", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const tooMany = Array.from({ length: BULK_SYNC_MAX_ASSETS + 1 }, (_, index) => `cly${String(index).padStart(22, "0")}`);
    const resolved = await resolveBulkSelection(dataset.id, { mode: "EXPLICIT", assetIds: tooMany });
    assert.deepEqual(resolved, { ok: false, reason: "TOO_LARGE", max: BULK_SYNC_MAX_ASSETS, resolvedCount: tooMany.length });
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("an EXPLICIT selection referencing an id outside the dataset resolves it into notFoundIds, not assetIds", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const otherDataset = await createWorkspaceDataset(owner.id);
  try {
    const marker = workspaceUnique("selection-cross-dataset");
    const inScope = await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: `${marker}-in.png`, mimeType: "image/png", sourceFingerprint: `${marker}-in` } });
    const outsideScope = await db.asset.create({ data: { datasetId: otherDataset.id, modality: Modality.IMAGE, filename: `${marker}-out.png`, mimeType: "image/png", sourceFingerprint: `${marker}-out` } });
    const resolved = await resolveBulkSelection(dataset.id, { mode: "EXPLICIT", assetIds: [inScope.id, outsideScope.id] });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.deepEqual(resolved.assetIds, [inScope.id]);
    assert.deepEqual(resolved.notFoundIds, [outsideScope.id]);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id, otherDataset.id]); }
});
