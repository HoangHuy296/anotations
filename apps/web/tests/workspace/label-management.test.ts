import assert from "node:assert/strict";
import test from "node:test";

import { DatasetMemberRole, UserRole } from "@internal/db";

import { createBoundingBox } from "@/lib/workspace/image-mutations";
import { deleteUnreferencedLabel, ensureDefaultImageLabels } from "@/lib/workspace/label-management";
import { db } from "@/lib/db";
import { normalizeLabelName } from "@/lib/validation/label";
import { addWorkspaceMember, cleanupWorkspaceFixture, createImageAsset, createWorkspaceDataset, createWorkspaceUser } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("custom label names use the same normalized taxonomy key", () => {
  assert.equal(normalizeLabelName("  Traffic Sign  "), "traffic sign");
});

test("authorized manager establishes idempotent default labels and referenced labels cannot be deleted", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    await addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER);
    const denied = await ensureDefaultImageLabels(labeler, dataset.id);
    assert.deepEqual(denied, { ok: false, status: 403 });
    const first = await ensureDefaultImageLabels(owner, dataset.id);
    assert.deepEqual(first, { ok: true, created: 6 });
    const replay = await ensureDefaultImageLabels(owner, dataset.id);
    assert.deepEqual(replay, { ok: true, created: 0 });
    const labels = await db.label.findMany({ where: { datasetId: dataset.id }, orderBy: { normalizedName: "asc" }, select: { id: true, normalizedName: true } });
    assert.deepEqual(labels.map((label) => label.normalizedName), ["aidetect", "animal", "object", "person", "text", "vehicle"]);
    const asset = await createImageAsset(dataset.id);
    const annotation = await createBoundingBox(labeler, { datasetId: dataset.id, assetId: asset.id, labelId: labels[0]!.id, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } });
    assert.equal(annotation.ok, true);
    assert.deepEqual(await deleteUnreferencedLabel(owner, labels[0]!.id), { ok: false, status: 409 });
    assert.deepEqual(await deleteUnreferencedLabel(labeler, labels[1]!.id), { ok: false, status: 403 });
    assert.deepEqual(await deleteUnreferencedLabel(owner, labels[1]!.id), { ok: true });
  } finally { await cleanupWorkspaceFixture([owner.id, labeler.id], [dataset.id]); }
});

test("default labels backfill only the missing ones into a dataset that already has custom labels", { skip: !enabled }, async () => {
  // Regression coverage: ensureDefaultImageLabels used to early-return
  // { created: 0 } for any dataset with >0 labels, so a dataset with even
  // one pre-existing custom label could never pick up a newly-added
  // DEFAULT_IMAGE_LABELS entry (e.g. "aidetect") -- contradicting the "Add
  // defaults" UI's own copy ("skips any name that already exists").
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    await db.label.create({ data: { datasetId: dataset.id, modality: "IMAGE", name: "Traffic Sign", normalizedName: normalizeLabelName("Traffic Sign"), color: "#123456" } });
    const result = await ensureDefaultImageLabels(owner, dataset.id);
    assert.deepEqual(result, { ok: true, created: 6 });
    const labels = await db.label.findMany({ where: { datasetId: dataset.id }, select: { normalizedName: true } });
    assert.deepEqual(new Set(labels.map((label) => label.normalizedName)), new Set(["traffic sign", "aidetect", "animal", "object", "person", "text", "vehicle"]));
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});
