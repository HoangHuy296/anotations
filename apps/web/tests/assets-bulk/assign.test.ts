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

    const assigned = await assignBulk(dataset.id, [asset.id], [], labeler.id);
    assert.equal(assigned.ok, true);
    if (assigned.ok) assert.deepEqual(assigned.result, { processed: 1, succeeded: 1, failed: 0, skipped: 0, failures: [] });
    assert.equal((await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { assignedToId: true } })).assignedToId, labeler.id);

    const unassigned = await assignBulk(dataset.id, [asset.id], [], null);
    assert.equal(unassigned.ok, true);
    assert.equal((await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { assignedToId: true } })).assignedToId, null);
  } finally { await cleanupWorkspaceFixture([owner.id, labeler.id], [dataset.id]); }
});

test("Assign rejects an assignee who is not a member of the dataset", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const outsider = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const asset = await createImageAsset(dataset.id);
    const result = await assignBulk(dataset.id, [asset.id], [], outsider.id);
    assert.deepEqual(result, { ok: false, reason: "INVALID_ASSIGNEE" });
    assert.equal((await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { assignedToId: true } })).assignedToId, null, "the asset must remain unassigned when the assignee is rejected");
  } finally { await cleanupWorkspaceFixture([owner.id, outsider.id], [dataset.id]); }
});
