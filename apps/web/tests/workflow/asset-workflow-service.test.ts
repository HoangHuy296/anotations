import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { AssetStatus, AssetWorkflowAction } from "@internal/db";

import { mutateImageAnnotations } from "@/lib/annotations/annotation-service";
import { db } from "@/lib/db";
import { applyAssetWorkflowAction, getAssetWorkflow } from "@/lib/workflow/asset-workflow-service";
import { createWorkflowFixture } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("workflow transitions are exhaustive, append events, and retain reject feedback", { skip: !enabled }, async () => {
  const fixture = await createWorkflowFixture();
  try {
    const start = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.START, expectedRevision: fixture.asset.revision });
    assert.equal(start.ok, true);
    if (!start.ok) return;
    const submit = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: start.asset.revision });
    assert.equal(submit.ok, true);
    if (!submit.ok) return;
    const opened = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.OPEN_REVIEW, expectedRevision: submit.asset.revision });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal(opened.asset.revision, submit.asset.revision, "opening review cannot change content revision");
    const rejected = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.REJECT, expectedRevision: submit.asset.revision, feedback: "Please tighten the box." });
    assert.equal(rejected.ok, true);
    if (!rejected.ok) return;
    const rework = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.START_REWORK, expectedRevision: rejected.asset.revision });
    assert.equal(rework.ok, true);
    if (!rework.ok) return;
    const resubmit = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.RESUBMIT, expectedRevision: rework.asset.revision });
    assert.equal(resubmit.ok, true);
    if (!resubmit.ok) return;
    const approved = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.APPROVE, expectedRevision: resubmit.asset.revision });
    assert.equal(approved.ok, true);
    if (!approved.ok) return;
    assert.equal(approved.asset.status, AssetStatus.REVIEWED);
    const history = await getAssetWorkflow(fixture.owner, fixture.dataset.id, fixture.asset.id);
    assert.equal(history.ok, true);
    if (!history.ok) return;
    assert.deepEqual(history.history.map((event) => event.action), ["START", "SUBMIT", "OPEN_REVIEW", "REJECT", "START_REWORK", "RESUBMIT", "APPROVE"]);
    assert.equal(history.history[3]?.feedback, "Please tighten the box.");
  } finally { await fixture.cleanup(); }
});

test("a stale reviewer decision creates no event or status change after annotation mutation", { skip: !enabled }, async () => {
  const fixture = await createWorkflowFixture();
  try {
    await db.asset.update({ where: { id: fixture.asset.id }, data: { status: AssetStatus.NEEDS_REVIEW } });
    const loaded = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { revision: true } });
    const changed = await mutateImageAnnotations(fixture.labeler, fixture.asset.id, { creates: [{ id: crypto.randomUUID(), type: "BOUNDING_BOX", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }], updates: [], deletes: [] });
    assert.equal(changed.ok, false, "review state must reject delayed annotation writes");
    // Simulate an earlier valid edit having completed after reviewer load.
    await db.asset.update({ where: { id: fixture.asset.id }, data: { status: AssetStatus.IN_PROGRESS, revision: { increment: 1 } } });
    await db.asset.update({ where: { id: fixture.asset.id }, data: { status: AssetStatus.NEEDS_REVIEW } });
    const result = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.APPROVE, expectedRevision: loaded.revision });
    assert.deepEqual(result, { ok: false, failure: { kind: "STALE_REVISION", currentRevision: loaded.revision + 1 } });
    const persisted = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { status: true } });
    assert.equal(persisted.status, AssetStatus.NEEDS_REVIEW);
    assert.equal(await db.assetWorkflowEvent.count({ where: { assetId: fixture.asset.id } }), 0);
  } finally { await fixture.cleanup(); }
});

test("concurrent reviewer decisions have one winner and one STALE_REVISION loser", { skip: !enabled }, async () => {
  const fixture = await createWorkflowFixture();
  try {
    await db.asset.update({ where: { id: fixture.asset.id }, data: { status: AssetStatus.NEEDS_REVIEW } });
    const asset = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { revision: true } });
    const [approve, reject] = await Promise.all([
      applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.APPROVE, expectedRevision: asset.revision }),
      applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.REJECT, expectedRevision: asset.revision, feedback: "Concurrent decision" }),
    ]);
    assert.equal([approve, reject].filter((result) => result.ok).length, 1);
    assert.equal([approve, reject].filter((result) => !result.ok && result.failure.kind === "STALE_REVISION").length, 1);
    assert.equal(await db.assetWorkflowEvent.count({ where: { assetId: fixture.asset.id } }), 1);
  } finally { await fixture.cleanup(); }
});
