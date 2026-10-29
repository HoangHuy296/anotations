import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { DatasetMemberRole, UserRole } from "@internal/db";

import { assignBulk } from "@/lib/assets/asset-bulk-service";
import { db } from "@/lib/db";
import { addWorkspaceMember, cleanupWorkspaceFixture, createImageAsset, createWorkspaceDataset, createWorkspaceUser } from "../workspace/helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

/** T023 (022): the assignment boundary (FR-004/FR-018) -- assign to a current DatasetMember, reject a non-member, unassign via null. */
test("Assign sets Asset.assignedToId to a current DatasetMember and can unassign via null", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    await addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER);
    const asset = await createImageAsset(dataset.id);

    const assigned = await assignBulk(dataset.id, [asset.id], [], labeler.id, owner.id);
    assert.equal(assigned.ok, true);
    if (assigned.ok) assert.deepEqual(assigned.result, { processed: 1, succeeded: 1, failed: 0, skipped: 0, failures: [] });
    assert.equal((await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { assignedToId: true } })).assignedToId, labeler.id);
    // The assignee is told which asset was assigned; unassigning (below) notifies nobody.
    const notices = await db.notification.findMany({ where: { userId: labeler.id, type: "ASSET_ASSIGNED", datasetId: dataset.id }, select: { title: true, body: true, assetId: true, actorId: true } });
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.title, "1 asset assigned to you");
    assert.equal(notices[0]!.assetId, asset.id);
    assert.equal(notices[0]!.actorId, owner.id);
    assert.ok(notices[0]!.body.includes(asset.filename ?? ""), "the notification names the assigned asset");

    const unassigned = await assignBulk(dataset.id, [asset.id], [], null, owner.id);
    assert.equal(unassigned.ok, true);
    assert.equal((await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { assignedToId: true } })).assignedToId, null);
    assert.equal(await db.notification.count({ where: { userId: labeler.id, type: "ASSET_ASSIGNED", datasetId: dataset.id } }), 1, "unassigning must not notify");
  } finally { await cleanupWorkspaceFixture([owner.id, labeler.id], [dataset.id]); }
});

test("Assign rejects an assignee who is not a member of the dataset", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const outsider = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const asset = await createImageAsset(dataset.id);
    const result = await assignBulk(dataset.id, [asset.id], [], outsider.id, owner.id);
    assert.deepEqual(result, { ok: false, reason: "INVALID_ASSIGNEE" });
    assert.equal((await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { assignedToId: true } })).assignedToId, null, "the asset must remain unassigned when the assignee is rejected");
  } finally { await cleanupWorkspaceFixture([owner.id, outsider.id], [dataset.id]); }
});
