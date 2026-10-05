import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { AssetAssignmentType, DatasetMemberRole, UserRole } from "@internal/db";
import { upsertAssetAssignment, removeAssetAssignment } from "@/lib/collaboration/asset-assignment-service";
import { db } from "@/lib/db";
import { addWorkspaceMember, cleanupWorkspaceFixture, createImageAsset, createWorkspaceDataset, createWorkspaceUser } from "../workspace/helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);
test("typed responsibility mutations preserve Phase 023 workflow, asset revision, and annotation revision", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER); const labeler = await createWorkspaceUser(); const reviewer = await createWorkspaceUser(); const dataset = await createWorkspaceDataset(owner.id); await Promise.all([addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER), addWorkspaceMember(dataset.id, reviewer.id, DatasetMemberRole.REVIEWER)]); const asset = await createImageAsset(dataset.id);
  try {
    await db.asset.update({ where: { id: asset.id }, data: { status: "NEEDS_REVIEW", revision: 7 } });
    const before = await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { status: true, revision: true } });
    const eventCount = await db.assetWorkflowEvent.count({ where: { assetId: asset.id } });
    const actor = owner;
    await upsertAssetAssignment(actor, { datasetId: dataset.id, assetId: asset.id, type: AssetAssignmentType.ANNOTATION, userId: labeler.id });
    await upsertAssetAssignment(actor, { datasetId: dataset.id, assetId: asset.id, type: AssetAssignmentType.REVIEW, userId: reviewer.id });
    await removeAssetAssignment(actor, { datasetId: dataset.id, assetId: asset.id, type: AssetAssignmentType.ANNOTATION });
    const after = await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { status: true, revision: true } });
    assert.deepEqual(after, before);
    assert.equal(await db.assetWorkflowEvent.count({ where: { assetId: asset.id } }), eventCount);
  } finally { await cleanupWorkspaceFixture([owner.id, labeler.id, reviewer.id], [dataset.id]); }
});
