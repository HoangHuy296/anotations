import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { DatasetMemberRole, Modality, UserRole } from "@internal/db";

import { createAssetComment } from "@/lib/collaboration/asset-comment-service";
import { readSafeDiscussionCommentId } from "@/lib/workspace/workspace-read";
import { readWorkspacePage } from "@/lib/workspace/workspace-read";
import { addWorkspaceMember, cleanupWorkspaceFixture, createImageAsset, createWorkspaceDataset, createWorkspaceUser } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1";

test("discussion deep links are asset-scoped, dataset-scoped, and re-authorized", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const removed = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  const otherDataset = await createWorkspaceDataset(owner.id);
  const [asset, otherAsset, foreignAsset] = await Promise.all([createImageAsset(dataset.id), createImageAsset(dataset.id), createImageAsset(otherDataset.id)]);
  try {
    await addWorkspaceMember(dataset.id, removed.id, DatasetMemberRole.LABELER);
    const actor = { id: owner.id, email: owner.email, name: owner.name, role: owner.role };
    const comment = await createAssetComment(actor, { datasetId: dataset.id, assetId: asset.id, body: "safe deep link" });
    assert.equal(await readSafeDiscussionCommentId(actor, dataset.id, asset.id, comment.commentId), comment.commentId);
    assert.equal(await readSafeDiscussionCommentId(actor, dataset.id, otherAsset.id, comment.commentId), null, "cross-asset comment is ignored");
    assert.equal(await readSafeDiscussionCommentId(actor, otherDataset.id, foreignAsset.id, comment.commentId), null, "cross-dataset comment is ignored");
    await (await import("@/lib/db")).db.datasetMember.delete({ where: { datasetId_userId: { datasetId: dataset.id, userId: removed.id } } });
    const removedActor = { id: removed.id, email: removed.email, name: removed.name, role: removed.role };
    assert.equal(await readSafeDiscussionCommentId(removedActor, dataset.id, asset.id, comment.commentId), null, "revoked member cannot resolve old deep link");
  } finally { await cleanupWorkspaceFixture([owner.id, removed.id], [dataset.id, otherDataset.id]); }
});

test("workspace keeps deep links Dataset-scoped within IMAGE and VIDEO Datasets", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const imageDataset = await createWorkspaceDataset(owner.id, Modality.IMAGE);
  const videoDataset = await createWorkspaceDataset(owner.id, Modality.VIDEO);
  try {
    const image = await createImageAsset(imageDataset.id);
    const video = await (await import("@/lib/db")).db.asset.create({ data: { datasetId: videoDataset.id, modality: Modality.VIDEO, filename: "acceptance.mp4", mimeType: "video/mp4", sourceFingerprint: `video-${Date.now()}` }, select: { id: true } });
    const actor = { id: owner.id, email: owner.email, name: owner.name, role: owner.role };
    const imagePage = await readWorkspacePage(actor, imageDataset.id, { selectedAsset: { id: image.id, modality: Modality.IMAGE } });
    const videoPage = await readWorkspacePage(actor, videoDataset.id, { selectedAsset: { id: video.id, modality: Modality.VIDEO } });
    assert.equal(imagePage?.page.selectedAsset?.id, image.id);
    assert.equal(imagePage?.dataset.modality, Modality.IMAGE);
    assert.equal(videoPage?.page.selectedAsset?.id, video.id);
    assert.equal(videoPage?.dataset.modality, Modality.VIDEO);
    const foreignPage = await readWorkspacePage(actor, imageDataset.id, { selectedAsset: { id: video.id, modality: Modality.VIDEO } });
    assert.equal(foreignPage?.dataset.modality, Modality.IMAGE, "a foreign deep link cannot choose another engine");
    assert.equal(foreignPage?.page.selectedAsset?.id, image.id, "legacy content fallback stays within its Dataset");
  } finally { await cleanupWorkspaceFixture([owner.id], [imageDataset.id, videoDataset.id]); }
});
