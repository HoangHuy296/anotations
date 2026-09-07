import assert from "node:assert/strict";
import test from "node:test";

import { AssetStatus, AssetWorkflowAction } from "@internal/db";

import { mutateImageAnnotations } from "@/lib/annotations/annotation-service";
import { db } from "@/lib/db";
import { applyAssetWorkflowAction } from "@/lib/workflow/asset-workflow-service";
import { createWorkflowFixture } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("review-frozen Assets reject delayed annotation writes, while a reviewer with an older content revision receives STALE_REVISION", { skip: !enabled }, async () => {
  const fixture = await createWorkflowFixture();
  try {
    await db.asset.update({ where: { id: fixture.asset.id }, data: { status: AssetStatus.NEEDS_REVIEW } });
    const loaded = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { revision: true } });

    const delayedWrite = await mutateImageAnnotations(fixture.labeler, fixture.asset.id, {
      creates: [{ id: crypto.randomUUID(), type: "BOUNDING_BOX", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }], updates: [], deletes: [],
    });
    assert.deepEqual(delayedWrite, { ok: false, reason: "WORKFLOW_LOCKED" });
    assert.equal((await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { revision: true } })).revision, loaded.revision);

    // A content writer that committed before the review freeze has already
    // advanced the Asset revision. The reviewer must not decide from N.
    await db.asset.update({ where: { id: fixture.asset.id }, data: { revision: { increment: 1 } } });
    for (const input of [
      { action: AssetWorkflowAction.APPROVE, expectedRevision: loaded.revision },
      { action: AssetWorkflowAction.REJECT, expectedRevision: loaded.revision, feedback: "Stale review" },
    ] as const) {
      const result = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, input);
      assert.deepEqual(result, { ok: false, failure: { kind: "STALE_REVISION", currentRevision: loaded.revision + 1 } });
    }
    const persisted = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { status: true } });
    assert.equal(persisted.status, AssetStatus.NEEDS_REVIEW);
    assert.equal(await db.assetWorkflowEvent.count({ where: { assetId: fixture.asset.id } }), 0);
  } finally { await fixture.cleanup(); }
});
