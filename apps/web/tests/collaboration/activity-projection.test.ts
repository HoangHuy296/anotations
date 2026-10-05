import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { AssetAssignmentEventAction, UserRole } from "@internal/db";

import { createAssetComment } from "@/lib/collaboration/asset-comment-service";
import { readAssetActivity } from "@/lib/collaboration/activity-projection-service";
import { createCollaborationFixture } from "./helpers";
import { createWorkspaceUser } from "../workspace/helpers";
import { db } from "@/lib/db";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1";

test("activity is an authorized redacted projection, not a new durable source", { skip: !enabled }, async () => {
  const fixture = await createCollaborationFixture();
  const outsider = await createWorkspaceUser(UserRole.LABELER);
  try {
    const owner = { id: fixture.owner.id, email: fixture.owner.email, name: fixture.owner.name, role: fixture.owner.role };
    await createAssetComment(owner, { datasetId: fixture.dataset.id, assetId: fixture.asset.id, body: "private discussion body" });
    await db.assetAssignmentEvent.create({ data: { datasetId: fixture.dataset.id, assetId: fixture.asset.id, action: AssetAssignmentEventAction.ASSIGNED, actorId: fixture.owner.id, createdAt: new Date("2026-01-01T00:00:00.000Z") } });
    await db.assetAssignmentEvent.create({ data: { datasetId: fixture.dataset.id, assetId: fixture.asset.id, action: AssetAssignmentEventAction.UNASSIGNED, actorId: fixture.owner.id, createdAt: new Date("2026-01-02T00:00:00.000Z") } });
    const items = await readAssetActivity(owner, fixture.dataset.id, fixture.asset.id);
    assert.ok(items?.some((item) => item.kind === "DISCUSSION" && item.action === "COMMENT_CREATED"));
    assert.equal(JSON.stringify(items).includes("private discussion body"), false, "activity redacts comment content");
    assert.deepEqual(items?.map((item) => item.createdAt), [...(items ?? [])].map((item) => item.createdAt).sort().reverse(), "activity uses one deterministic newest-first ordering across projected sources");
    const denied = await readAssetActivity({ id: outsider.id, email: outsider.email, name: outsider.name, role: outsider.role }, fixture.dataset.id, fixture.asset.id);
    assert.equal(denied, null, "cross-dataset activity is concealed");
  } finally {
    await fixture.cleanup();
    await db.user.delete({ where: { id: outsider.id } });
  }
});
