import assert from "node:assert/strict";
import test from "node:test";

import { DatasetMemberRole, UserRole } from "@internal/db";

import {
  AssetCommentError,
  createAssetComment,
  deleteAssetComment,
  listAssetComments,
  updateAssetComment,
} from "@/lib/collaboration/asset-comment-service";
import { listNotifications } from "@/lib/collaboration/notification-service";
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

test("collaboration services conceal cross-dataset and post-removal discussion access and protect another author's comment", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const author = await createWorkspaceUser();
  const otherMember = await createWorkspaceUser();
  const outsider = await createWorkspaceUser();
  const dataset = await createWorkspaceDataset(owner.id);
  const otherDataset = await createWorkspaceDataset(owner.id);
  const asset = await createImageAsset(dataset.id);
  const otherAsset = await createImageAsset(otherDataset.id);
  await Promise.all([
    addWorkspaceMember(dataset.id, author.id, DatasetMemberRole.LABELER),
    addWorkspaceMember(dataset.id, otherMember.id, DatasetMemberRole.LABELER),
  ]);

  try {
    const root = await createAssetComment(author, { datasetId: dataset.id, assetId: asset.id, body: "author-only" });
    await assert.rejects(() => updateAssetComment(otherMember, root.commentId, "not mine"), AssetCommentError);
    await assert.rejects(() => deleteAssetComment(otherMember, root.commentId), AssetCommentError);
    await assert.rejects(() => listAssetComments(outsider, dataset.id, asset.id), AssetCommentError);
    await assert.rejects(() => createAssetComment(author, { datasetId: otherDataset.id, assetId: otherAsset.id, body: "cross dataset" }), AssetCommentError);

    await db.datasetMember.delete({ where: { datasetId_userId: { datasetId: dataset.id, userId: author.id } } });
    await assert.rejects(() => listAssetComments(author, dataset.id, asset.id), AssetCommentError);
    await assert.rejects(() => updateAssetComment(author, root.commentId, "removed"), AssetCommentError);
    assert.equal((await db.assetComment.findUniqueOrThrow({ where: { id: root.commentId } })).body, "author-only");
  } finally {
    await cleanupWorkspaceFixture([owner.id, author.id, otherMember.id, outsider.id], [dataset.id, otherDataset.id]);
  }
});

test("notification history redacts context immediately after dataset access loss", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const recipient = await createWorkspaceUser();
  const dataset = await createWorkspaceDataset(owner.id);
  const asset = await createImageAsset(dataset.id);
  await addWorkspaceMember(dataset.id, recipient.id, DatasetMemberRole.LABELER);
  try {
    await db.notification.create({
      data: {
        userId: recipient.id,
        actorId: owner.id,
        type: "ASSET_ASSIGNED",
        datasetId: dataset.id,
        assetId: asset.id,
        title: "Private dataset title",
        body: "Private asset detail",
        dedupeKey: `security-redaction:${dataset.id}:${recipient.id}`,
      },
    });
    await db.datasetMember.delete({ where: { datasetId_userId: { datasetId: dataset.id, userId: recipient.id } } });
    const page = await listNotifications(recipient, { limit: 10 });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.unavailable, true);
    assert.equal(page.items[0]?.datasetId, null);
    assert.equal(page.items[0]?.assetId, null);
    assert.equal(page.items[0]?.title, "Notification unavailable");
    assert.equal(page.items[0]?.body, "The related item is no longer available.");
  } finally {
    await cleanupWorkspaceFixture([owner.id, recipient.id], [dataset.id]);
  }
});
