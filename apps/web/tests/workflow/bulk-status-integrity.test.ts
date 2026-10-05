import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { AssetStatus, UserRole } from "@internal/db";

import { changeStatusBulk, WorkflowStatusRequiresTransitionError } from "@/lib/assets/asset-bulk-service";
import { db } from "@/lib/db";
import { cleanupWorkspaceFixture, createImageAsset, createWorkspaceDataset, createWorkspaceUser } from "../workspace/helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("bulk status updates reject workflow targets and mixed workflow selections without partial writes", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const operational = await createImageAsset(dataset.id);
    const reviewFrozen = await createImageAsset(dataset.id);
    await db.asset.update({ where: { id: reviewFrozen.id }, data: { status: AssetStatus.NEEDS_REVIEW } });
    await assert.rejects(() => changeStatusBulk(dataset.id, [operational.id], [], AssetStatus.IN_PROGRESS), WorkflowStatusRequiresTransitionError);
    assert.equal((await db.asset.findUniqueOrThrow({ where: { id: operational.id }, select: { status: true } })).status, AssetStatus.NEW);
    await assert.rejects(() => changeStatusBulk(dataset.id, [operational.id, reviewFrozen.id], [], AssetStatus.READY), WorkflowStatusRequiresTransitionError);
    const statuses = await db.asset.findMany({ where: { id: { in: [operational.id, reviewFrozen.id] } }, select: { id: true, status: true } });
    assert.deepEqual(new Map(statuses.map((asset) => [asset.id, asset.status])), new Map([[operational.id, AssetStatus.NEW], [reviewFrozen.id, AssetStatus.NEEDS_REVIEW]]));
    const allowed = await changeStatusBulk(dataset.id, [operational.id], [], AssetStatus.READY);
    assert.equal(allowed.succeeded, 1);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});
