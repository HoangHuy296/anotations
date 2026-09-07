import assert from "node:assert/strict";
import test from "node:test";

import { DatasetMemberRole, UserRole } from "@internal/db";

import {
  AssetCommentError,
  createAssetComment,
  deleteAssetComment,
  listAssetComments,
  resolveAssetComment,
  updateAssetComment,
} from "@/lib/collaboration/asset-comment-service";
import { db } from "@/lib/db";
import {
  addWorkspaceMember,
  cleanupWorkspaceFixture,
  createImageAsset,
  createWorkspaceDataset,
  createWorkspaceUser,
} from "../workspace/helpers";
import { hasIntegrationDatabase } from "../auth-ownership/helpers";

const enabled = hasIntegrationDatabase;

test("discussion preserves flat threads, mentions, notifications, soft deletion, and resolution", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const author = await createWorkspaceUser();
  const replyAuthor = await createWorkspaceUser();
  const mentioned = await createWorkspaceUser();
  const editedMention = await createWorkspaceUser();
  const outsider = await createWorkspaceUser();
  const dataset = await createWorkspaceDataset(owner.id);
  const otherDataset = await createWorkspaceDataset(owner.id);
  const asset = await createImageAsset(dataset.id);
  const otherAsset = await createImageAsset(dataset.id);
  const crossDatasetAsset = await createImageAsset(otherDataset.id);

  await Promise.all([
    addWorkspaceMember(dataset.id, author.id, DatasetMemberRole.LABELER),
    addWorkspaceMember(dataset.id, replyAuthor.id, DatasetMemberRole.LABELER),
    addWorkspaceMember(dataset.id, mentioned.id, DatasetMemberRole.REVIEWER),
    addWorkspaceMember(dataset.id, editedMention.id, DatasetMemberRole.REVIEWER),
  ]);

  try {
    const root = await createAssetComment(author, {
      datasetId: dataset.id,
      assetId: asset.id,
      body: `hello @${mentioned.email} @${mentioned.email}`,
    });
    const reply = await createAssetComment(replyAuthor, {
      datasetId: dataset.id,
      assetId: asset.id,
      parentId: root.commentId,
      body: `reply @${mentioned.email}`,
    });

    await assert.rejects(
      () => createAssetComment(author, { datasetId: dataset.id, assetId: asset.id, parentId: reply.commentId, body: "too deep" }),
      AssetCommentError,
    );
    await assert.rejects(
      () => createAssetComment(author, { datasetId: dataset.id, assetId: otherAsset.id, parentId: root.commentId, body: "wrong asset" }),
      AssetCommentError,
    );
    await assert.rejects(
      () => createAssetComment(owner, { datasetId: otherDataset.id, assetId: crossDatasetAsset.id, parentId: root.commentId, body: "wrong dataset" }),
      AssetCommentError,
    );

    assert.equal(await db.commentMention.count({ where: { commentId: root.commentId } }), 1);
    assert.equal(await db.notification.count({ where: { userId: mentioned.id, commentId: { in: [root.commentId, reply.commentId] } } }), 2);
    assert.equal(await db.collaborationOutboxEvent.count({ where: { dedupeKey: `notification:mention:${root.commentId}:${mentioned.id}` } }), 1, "duplicate mention syntax creates one durable delivery intent");
    assert.equal(await db.notification.count({ where: { userId: author.id, commentId: reply.commentId, type: "COMMENT_REPLY" } }), 1);
    assert.equal(await db.notification.count({ where: { userId: replyAuthor.id } }), 0, "self-notifications are suppressed");

    await updateAssetComment(author, root.commentId, `edited @${editedMention.email}`);
    assert.equal(await db.commentMention.count({ where: { commentId: root.commentId } }), 1, "removed mentions are removed from the durable recipient map");
    assert.equal(await db.notification.count({ where: { userId: editedMention.id, commentId: root.commentId, type: "MENTIONED" } }), 1, "a newly added mention is notified once");
    await updateAssetComment(author, root.commentId, `edited again @${editedMention.email}`);
    assert.equal(await db.notification.count({ where: { userId: editedMention.id, commentId: root.commentId, type: "MENTIONED" } }), 1, "ordinary edits do not resend mention notifications");
    assert.equal(await db.collaborationOutboxEvent.count({ where: { dedupeKey: `notification:mention:${root.commentId}:${editedMention.id}` } }), 1, "notification delivery intent shares the durable dedupe invariant");

    await deleteAssetComment(author, root.commentId);
    const threads = await listAssetComments(author, dataset.id, asset.id);
    assert.ok(threads[0]?.deletedAt, "deletion is retained as visible thread context");
    assert.equal(threads[0]?.replies.length, 1);

    await resolveAssetComment(replyAuthor, reply.commentId, true);
    assert.ok((await db.assetComment.findUniqueOrThrow({ where: { id: root.commentId } })).resolvedAt);
    await resolveAssetComment(owner, root.commentId, false);
    assert.equal((await db.assetComment.findUniqueOrThrow({ where: { id: root.commentId } })).resolvedAt, null);
    await assert.rejects(() => updateAssetComment(outsider, root.commentId, "no"), AssetCommentError);
  } finally {
    await cleanupWorkspaceFixture(
      [owner.id, author.id, replyAuthor.id, mentioned.id, editedMention.id, outsider.id],
      [dataset.id, otherDataset.id],
    );
  }
});

test("discussion rejects removed members without partial comment or outbox state", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const removedMember = await createWorkspaceUser();
  const dataset = await createWorkspaceDataset(owner.id);
  const asset = await createImageAsset(dataset.id);
  await addWorkspaceMember(dataset.id, removedMember.id, DatasetMemberRole.LABELER);

  try {
    await db.datasetMember.delete({ where: { datasetId_userId: { datasetId: dataset.id, userId: removedMember.id } } });
    const [commentsBefore, outboxBefore] = await Promise.all([
      db.assetComment.count({ where: { assetId: asset.id } }),
      db.collaborationOutboxEvent.count({ where: { datasetId: dataset.id } }),
    ]);
    await assert.rejects(
      () => createAssetComment(removedMember, { datasetId: dataset.id, assetId: asset.id, body: "must fail" }),
      AssetCommentError,
    );
    assert.equal(await db.assetComment.count({ where: { assetId: asset.id } }), commentsBefore);
    assert.equal(await db.collaborationOutboxEvent.count({ where: { datasetId: dataset.id } }), outboxBefore);
  } finally {
    await cleanupWorkspaceFixture([owner.id, removedMember.id], [dataset.id]);
  }
});
