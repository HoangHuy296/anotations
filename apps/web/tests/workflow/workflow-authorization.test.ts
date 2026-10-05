import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { AssetStatus, AssetWorkflowAction } from "@internal/db";

import { db } from "@/lib/db";
import { applyAssetWorkflowAction, getAssetWorkflow } from "@/lib/workflow/asset-workflow-service";
import { createImageAsset, createWorkspaceDataset } from "../workspace/helpers";
import { createWorkflowFixture } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("workflow permissions distinguish labeler submission from reviewer decisions", { skip: !enabled }, async () => {
  const fixture = await createWorkflowFixture();
  try {
    const labelerDecision = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.APPROVE, expectedRevision: fixture.asset.revision });
    assert.deepEqual(labelerDecision, { ok: false, failure: { kind: "FORBIDDEN" } });

    const reviewerSubmission = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.START, expectedRevision: fixture.asset.revision });
    assert.deepEqual(reviewerSubmission, { ok: false, failure: { kind: "FORBIDDEN" } });

    await db.asset.update({ where: { id: fixture.asset.id }, data: { status: AssetStatus.NEEDS_REVIEW } });
    const reviewerRead = await getAssetWorkflow(fixture.reviewer, fixture.dataset.id, fixture.asset.id);
    assert.equal(reviewerRead.ok, true);
  } finally { await fixture.cleanup(); }
});

test("workflow conceals assets outside the authorized dataset", { skip: !enabled }, async () => {
  const fixture = await createWorkflowFixture();
  try {
    const otherDataset = await createWorkspaceDataset(fixture.owner.id);
    const otherAsset = await createImageAsset(otherDataset.id);
    const result = await getAssetWorkflow(fixture.reviewer, otherDataset.id, otherAsset.id);
    assert.deepEqual(result, { ok: false, failure: { kind: "NOT_FOUND" } });
    await db.dataset.delete({ where: { id: otherDataset.id } });
  } finally { await fixture.cleanup(); }
});

test("a dual-tier owner may self-review, while deleted assets stay concealed", { skip: !enabled }, async () => {
  const fixture = await createWorkflowFixture();
  try {
    const started = await applyAssetWorkflowAction(fixture.owner, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.START, expectedRevision: fixture.asset.revision });
    assert.equal(started.ok, true); if (!started.ok) return;
    const submitted = await applyAssetWorkflowAction(fixture.owner, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: started.asset.revision });
    assert.equal(submitted.ok, true); if (!submitted.ok) return;
    const approved = await applyAssetWorkflowAction(fixture.owner, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.APPROVE, expectedRevision: submitted.asset.revision });
    assert.equal(approved.ok, true, "the recorded policy allows a manager/owner to self-review");
    await db.asset.update({ where: { id: fixture.asset.id }, data: { deletedAt: new Date() } });
    assert.deepEqual(await getAssetWorkflow(fixture.owner, fixture.dataset.id, fixture.asset.id), { ok: false, failure: { kind: "NOT_FOUND" } });
  } finally { await fixture.cleanup(); }
});
