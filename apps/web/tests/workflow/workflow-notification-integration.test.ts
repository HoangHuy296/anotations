import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { AssetAssignmentType, AssetStatus, AssetWorkflowAction, NotificationType } from "@internal/db";

import { db } from "@/lib/db";
import { applyAssetWorkflowAction } from "@/lib/workflow/asset-workflow-service";
import { createWorkflowFixture } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("workflow transition creates one durable recipient notification and outbox intent without changing workflow semantics", { skip: !enabled }, async () => {
  const fixture = await createWorkflowFixture();
  try {
    await db.assetAssignment.createMany({ data: [
      { datasetId: fixture.dataset.id, assetId: fixture.asset.id, userId: fixture.labeler.id, type: AssetAssignmentType.ANNOTATION, assignedById: fixture.owner.id },
      { datasetId: fixture.dataset.id, assetId: fixture.asset.id, userId: fixture.reviewer.id, type: AssetAssignmentType.REVIEW, assignedById: fixture.owner.id },
    ] });
    const start = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.START, expectedRevision: fixture.asset.revision });
    assert.equal(start.ok, true);
    if (!start.ok) return;
    const submit = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: start.asset.revision });
    assert.equal(submit.ok, true);
    if (!submit.ok) return;
    assert.equal(submit.asset.status, AssetStatus.NEEDS_REVIEW);
    assert.equal(await db.notification.count({ where: { userId: fixture.reviewer.id, type: NotificationType.REVIEW_SUBMITTED, assetId: fixture.asset.id } }), 1);
    assert.equal(await db.collaborationOutboxEvent.count({ where: { recipientUserId: fixture.reviewer.id, type: "NOTIFICATION_CREATED" } }), 1);
    assert.equal(await db.assetWorkflowEvent.count({ where: { assetId: fixture.asset.id, action: AssetWorkflowAction.SUBMIT } }), 1);
  } finally { await fixture.cleanup(); }
});

test("workflow uses the assigned reviewer before the eligible-reviewer fallback", { skip: !enabled }, async () => {
  const fixture = await createWorkflowFixture();
  try {
    await db.assetAssignment.create({ data: { datasetId: fixture.dataset.id, assetId: fixture.asset.id, userId: fixture.reviewer.id, type: AssetAssignmentType.REVIEW, assignedById: fixture.owner.id } });
    const start = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.START, expectedRevision: fixture.asset.revision });
    if (!start.ok) throw new Error("start should succeed");
    await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: start.asset.revision });
    assert.equal(await db.notification.count({ where: { assetId: fixture.asset.id, type: NotificationType.REVIEW_SUBMITTED, userId: fixture.reviewer.id } }), 1);
  } finally { await fixture.cleanup(); }
});

test("stale, invalid, unauthorized, and replayed workflow requests produce no duplicate notification or outbox intent", { skip: !enabled }, async () => {
  const fixture = await createWorkflowFixture();
  try {
    const baseline = async () => ({
      notifications: await db.notification.count({ where: { assetId: fixture.asset.id } }),
      outbox: await db.collaborationOutboxEvent.count({ where: { assetId: fixture.asset.id } }),
    });
    const beforeInvalid = await baseline();
    const invalid = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: fixture.asset.revision });
    assert.deepEqual(invalid, { ok: false, failure: { kind: "INVALID_TRANSITION" } });
    assert.deepEqual(await baseline(), beforeInvalid);

    const beforeUnauthorized = await baseline();
    const unauthorized = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.START, expectedRevision: fixture.asset.revision });
    assert.equal(unauthorized.ok, false);
    if (!unauthorized.ok) assert.equal(unauthorized.failure.kind, "FORBIDDEN");
    assert.deepEqual(await baseline(), beforeUnauthorized);

    await db.asset.update({ where: { id: fixture.asset.id }, data: { status: AssetStatus.NEEDS_REVIEW, revision: { increment: 1 } } });
    const current = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { revision: true } });
    const beforeStale = await baseline();
    const stale = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.APPROVE, expectedRevision: current.revision - 1 });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.failure.kind, "STALE_REVISION");
    assert.deepEqual(await baseline(), beforeStale);

    await db.asset.update({ where: { id: fixture.asset.id }, data: { status: AssetStatus.IN_PROGRESS } });
    const started = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { revision: true } });
    const [submit, replay] = await Promise.all([
      applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: started.revision }),
      applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: started.revision }),
    ]);
    assert.equal([submit, replay].filter((result) => result.ok).length, 1);
    assert.equal(await db.notification.count({ where: { assetId: fixture.asset.id, type: NotificationType.REVIEW_SUBMITTED } }), 1);
    assert.equal(await db.collaborationOutboxEvent.count({ where: { assetId: fixture.asset.id, type: "NOTIFICATION_CREATED" } }), 1);
  } finally { await fixture.cleanup(); }
});
