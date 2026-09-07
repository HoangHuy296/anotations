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
