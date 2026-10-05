import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { AssetAssignmentType, DatasetMemberRole, UserRole } from "@internal/db";

import { AssetAssignmentError, removeAssetAssignment, upsertAssetAssignment } from "@/lib/collaboration/asset-assignment-service";
import { db } from "@/lib/db";
import { addWorkspaceMember, cleanupWorkspaceFixture, createImageAsset, createWorkspaceDataset, createWorkspaceUser } from "../workspace/helpers";
import { hasIntegrationDatabase } from "../auth-ownership/helpers";

function actor(user: { id: string; email: string; name: string; role: UserRole }) { return user; }

test("typed assignment slots preserve legacy annotation mirroring, review isolation, history, and outbox/notification durability", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const labelerA = await createWorkspaceUser();
  const labelerB = await createWorkspaceUser();
  const reviewerA = await createWorkspaceUser();
  const reviewerB = await createWorkspaceUser();
  const dataset = await createWorkspaceDataset(owner.id);
  await Promise.all([
    addWorkspaceMember(dataset.id, labelerA.id, DatasetMemberRole.LABELER), addWorkspaceMember(dataset.id, labelerB.id, DatasetMemberRole.LABELER),
    addWorkspaceMember(dataset.id, reviewerA.id, DatasetMemberRole.REVIEWER), addWorkspaceMember(dataset.id, reviewerB.id, DatasetMemberRole.REVIEWER),
  ]);
  const asset = await createImageAsset(dataset.id);
  try {
    const initial = await upsertAssetAssignment(actor(owner), { datasetId: dataset.id, assetId: asset.id, type: AssetAssignmentType.ANNOTATION, userId: labelerA.id });
    assert.equal(initial.reused, false); assert.ok(initial.outboxJobIds.length > 0);
    assert.equal((await db.asset.findUniqueOrThrow({ where: { id: asset.id } })).assignedToId, labelerA.id);
    const review = await upsertAssetAssignment(actor(owner), { datasetId: dataset.id, assetId: asset.id, type: AssetAssignmentType.REVIEW, userId: reviewerA.id });
    assert.equal(review.reused, false);
    assert.equal((await db.asset.findUniqueOrThrow({ where: { id: asset.id } })).assignedToId, labelerA.id, "review assignment never writes legacy field");
    const reassigned = await upsertAssetAssignment(actor(owner), { datasetId: dataset.id, assetId: asset.id, type: AssetAssignmentType.ANNOTATION, userId: labelerB.id });
    assert.equal(reassigned.reused, false);
    assert.equal(await db.assetAssignment.count({ where: { assetId: asset.id, type: AssetAssignmentType.ANNOTATION } }), 1);
    assert.equal((await db.asset.findUniqueOrThrow({ where: { id: asset.id } })).assignedToId, labelerB.id);
    const replay = await upsertAssetAssignment(actor(owner), { datasetId: dataset.id, assetId: asset.id, type: AssetAssignmentType.ANNOTATION, userId: labelerB.id });
    assert.equal(replay.reused, true);
    assert.equal(await db.assetAssignmentEvent.count({ where: { assetId: asset.id } }), 3);
    assert.equal(await db.notification.count({ where: { assetId: asset.id } }), 3, "one recipient notification per accepted assignment event");
    await removeAssetAssignment(actor(owner), { datasetId: dataset.id, assetId: asset.id, type: AssetAssignmentType.ANNOTATION });
    assert.equal((await db.asset.findUniqueOrThrow({ where: { id: asset.id } })).assignedToId, null);
    await removeAssetAssignment(actor(owner), { datasetId: dataset.id, assetId: asset.id, type: AssetAssignmentType.REVIEW });
    assert.equal(await db.assetAssignment.count({ where: { assetId: asset.id } }), 0);
    assert.equal(await db.assetAssignmentEvent.count({ where: { assetId: asset.id } }), 5);
    assert.equal(await db.collaborationOutboxEvent.count({ where: { assetId: asset.id, type: "ASSIGNMENT_CHANGED" } }), 5);
  } finally { await cleanupWorkspaceFixture([owner.id, labelerA.id, labelerB.id, reviewerA.id, reviewerB.id], [dataset.id]); }
});

test("assignment authorization and eligibility reject invalid members without partial state", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const labeler = await createWorkspaceUser();
  const reviewer = await createWorkspaceUser();
  const outsider = await createWorkspaceUser();
  const dataset = await createWorkspaceDataset(owner.id);
  const otherDataset = await createWorkspaceDataset(owner.id);
  await Promise.all([addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER), addWorkspaceMember(dataset.id, reviewer.id, DatasetMemberRole.REVIEWER)]);
  const asset = await createImageAsset(dataset.id); const otherAsset = await createImageAsset(otherDataset.id);
  try {
    await assert.rejects(() => upsertAssetAssignment(actor(owner), { datasetId: dataset.id, assetId: asset.id, type: AssetAssignmentType.ANNOTATION, userId: reviewer.id }), AssetAssignmentError);
    await assert.rejects(() => upsertAssetAssignment(actor(owner), { datasetId: dataset.id, assetId: asset.id, type: AssetAssignmentType.REVIEW, userId: labeler.id }), AssetAssignmentError);
    await assert.rejects(() => upsertAssetAssignment(actor(owner), { datasetId: dataset.id, assetId: asset.id, type: AssetAssignmentType.ANNOTATION, userId: outsider.id }), AssetAssignmentError);
    await assert.rejects(() => upsertAssetAssignment(actor(outsider), { datasetId: dataset.id, assetId: asset.id, type: AssetAssignmentType.ANNOTATION, userId: labeler.id }), AssetAssignmentError);
    await assert.rejects(() => upsertAssetAssignment(actor(owner), { datasetId: dataset.id, assetId: otherAsset.id, type: AssetAssignmentType.ANNOTATION, userId: labeler.id }), AssetAssignmentError);
    assert.equal(await db.assetAssignment.count({ where: { assetId: asset.id } }), 0);
    assert.equal(await db.assetAssignmentEvent.count({ where: { assetId: asset.id } }), 0);
    assert.equal(await db.notification.count({ where: { assetId: asset.id } }), 0);
    assert.equal(await db.collaborationOutboxEvent.count({ where: { assetId: asset.id } }), 0);
  } finally { await cleanupWorkspaceFixture([owner.id, labeler.id, reviewer.id, outsider.id], [dataset.id, otherDataset.id]); }
});

test("concurrent reassignments retain one current slot with ordered durable history", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER); const first = await createWorkspaceUser(); const second = await createWorkspaceUser();
  const dataset = await createWorkspaceDataset(owner.id); await Promise.all([addWorkspaceMember(dataset.id, first.id, DatasetMemberRole.LABELER), addWorkspaceMember(dataset.id, second.id, DatasetMemberRole.LABELER)]);
  const asset = await createImageAsset(dataset.id);
  try {
    const [left, right] = await Promise.all([
      upsertAssetAssignment(actor(owner), { datasetId: dataset.id, assetId: asset.id, type: AssetAssignmentType.ANNOTATION, userId: first.id }),
      upsertAssetAssignment(actor(owner), { datasetId: dataset.id, assetId: asset.id, type: AssetAssignmentType.ANNOTATION, userId: second.id }),
    ]);
    assert.equal([left, right].filter((result) => !result.reused).length, 2);
    const current = await db.assetAssignment.findUniqueOrThrow({ where: { assetId_type: { assetId: asset.id, type: AssetAssignmentType.ANNOTATION } } });
    assert.ok([first.id, second.id].includes(current.userId));
    assert.equal(await db.assetAssignment.count({ where: { assetId: asset.id, type: AssetAssignmentType.ANNOTATION } }), 1);
    assert.equal(await db.assetAssignmentEvent.count({ where: { assetId: asset.id } }), 2);
    assert.equal((await db.asset.findUniqueOrThrow({ where: { id: asset.id } })).assignedToId, current.userId);
  } finally { await cleanupWorkspaceFixture([owner.id, first.id, second.id], [dataset.id]); }
});
