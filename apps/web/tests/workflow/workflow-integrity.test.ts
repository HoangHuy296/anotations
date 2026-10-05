import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { AssetStatus, AssetWorkflowAction } from "@internal/db";

import { db } from "@/lib/db";
import { applyAssetWorkflowAction } from "@/lib/workflow/asset-workflow-service";
import { createWorkflowFixture } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("workflow state writes are atomic and stale revision takes precedence over transition validation", { skip: !enabled }, async () => {
  const fixture = await createWorkflowFixture();
  try {
    await db.asset.update({ where: { id: fixture.asset.id }, data: { status: AssetStatus.REVIEWED, revision: { increment: 1 } } });
    const current = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { revision: true, status: true } });
    const staleInvalid = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: current.revision - 1 });
    assert.deepEqual(staleInvalid, { ok: false, failure: { kind: "STALE_REVISION", currentRevision: current.revision } });
    assert.equal(await db.assetWorkflowEvent.count({ where: { assetId: fixture.asset.id } }), 0);
    const persisted = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { revision: true, status: true } });
    assert.deepEqual(persisted, current, "a failed action must not partially write status or an event");
  } finally { await fixture.cleanup(); }
});

test("concurrent submissions have one state/event winner and one stale loser", { skip: !enabled }, async () => {
  const fixture = await createWorkflowFixture();
  try {
    await db.asset.update({ where: { id: fixture.asset.id }, data: { status: AssetStatus.IN_PROGRESS } });
    const asset = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { revision: true } });
    const [first, second] = await Promise.all([
      applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: asset.revision }),
      applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: asset.revision }),
    ]);
    assert.equal([first, second].filter((result) => result.ok).length, 1);
    assert.equal([first, second].filter((result) => !result.ok && result.failure.kind === "STALE_REVISION").length, 1);
    assert.equal(await db.assetWorkflowEvent.count({ where: { assetId: fixture.asset.id } }), 1);
  } finally { await fixture.cleanup(); }
});
