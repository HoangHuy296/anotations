import assert from "node:assert/strict";
import test from "node:test";

import { AssetAssignmentType, DatasetMemberRole, UserRole } from "@internal/db";

import { upsertAssetAssignment } from "@/lib/collaboration/asset-assignment-service";
import { createAssetComment, updateAssetComment } from "@/lib/collaboration/asset-comment-service";
import { runCollaborationTransaction } from "@/lib/collaboration/collaboration-outbox-service";
import { createDatasetInvitation } from "@/lib/collaboration/dataset-membership-service";
import { createDurableNotification } from "@/lib/collaboration/notification-service";
import { db } from "@/lib/db";
import { hasIntegrationDatabase } from "../auth-ownership/helpers";
import {
  addWorkspaceMember,
  cleanupWorkspaceFixture,
  createImageAsset,
  createWorkspaceDataset,
  createWorkspaceUser,
} from "../workspace/helpers";

const enabled = hasIntegrationDatabase;

test("concurrent collaboration replays preserve durable invitation, assignment, comment notification, and outbox idempotency", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const invitee = await createWorkspaceUser();
  const firstLabeler = await createWorkspaceUser();
  const secondLabeler = await createWorkspaceUser();
  const mentioned = await createWorkspaceUser();
  const dataset = await createWorkspaceDataset(owner.id);
  const asset = await createImageAsset(dataset.id);
  await Promise.all([
    addWorkspaceMember(dataset.id, firstLabeler.id, DatasetMemberRole.LABELER),
    addWorkspaceMember(dataset.id, secondLabeler.id, DatasetMemberRole.LABELER),
    addWorkspaceMember(dataset.id, mentioned.id, DatasetMemberRole.REVIEWER),
  ]);
  try {
    const invitationInput = { datasetId: dataset.id, inviteeUserId: invitee.id, role: DatasetMemberRole.LABELER };
    const [firstInvite, secondInvite] = await Promise.all([createDatasetInvitation(owner, invitationInput), createDatasetInvitation(owner, invitationInput)]);
    assert.equal(firstInvite.invitation.id, secondInvite.invitation.id);
    assert.equal(await db.datasetInvitation.count({ where: { datasetId: dataset.id, inviteeUserId: invitee.id } }), 1);

    await Promise.all([
      upsertAssetAssignment(owner, { datasetId: dataset.id, assetId: asset.id, type: AssetAssignmentType.ANNOTATION, userId: firstLabeler.id }),
      upsertAssetAssignment(owner, { datasetId: dataset.id, assetId: asset.id, type: AssetAssignmentType.ANNOTATION, userId: secondLabeler.id }),
    ]);
    assert.equal(await db.assetAssignment.count({ where: { assetId: asset.id, type: AssetAssignmentType.ANNOTATION } }), 1);

    const root = await createAssetComment(firstLabeler, { datasetId: dataset.id, assetId: asset.id, body: "root" });
    const body = `updated @${mentioned.email}`;
    await Promise.all([updateAssetComment(firstLabeler, root.commentId, body), updateAssetComment(firstLabeler, root.commentId, body)]);
    assert.equal(await db.commentMention.count({ where: { commentId: root.commentId, userId: mentioned.id } }), 1);
    assert.equal(await db.notification.count({ where: { userId: mentioned.id, dedupeKey: `mention:${root.commentId}:${mentioned.id}` } }), 1);
    assert.equal(await db.collaborationOutboxEvent.count({ where: { dedupeKey: `notification:mention:${root.commentId}:${mentioned.id}` } }), 1);

    await Promise.all([
      runCollaborationTransaction((tx) => createDurableNotification(tx, { userId: mentioned.id, actorId: owner.id, type: "ASSET_ASSIGNED", datasetId: dataset.id, assetId: asset.id, title: "assigned", body: "assigned", dedupeKey: `concurrency-notification:${asset.id}` })),
      runCollaborationTransaction((tx) => createDurableNotification(tx, { userId: mentioned.id, actorId: owner.id, type: "ASSET_ASSIGNED", datasetId: dataset.id, assetId: asset.id, title: "assigned", body: "assigned", dedupeKey: `concurrency-notification:${asset.id}` })),
    ]);
    assert.equal(await db.notification.count({ where: { userId: mentioned.id, dedupeKey: `concurrency-notification:${asset.id}` } }), 1);
  } finally {
    await cleanupWorkspaceFixture([owner.id, invitee.id, firstLabeler.id, secondLabeler.id, mentioned.id], [dataset.id]);
  }
});
