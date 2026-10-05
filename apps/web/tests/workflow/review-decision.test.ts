import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { AssetStatus, AssetWorkflowAction } from "@internal/db";

import { applyAssetWorkflowAction } from "@/lib/workflow/asset-workflow-service";
import { assetWorkflowActionRequestSchema } from "@/lib/validation/asset-workflow";
import { createWorkflowFixture } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

async function submitForReview() {
  const fixture = await createWorkflowFixture();
  const started = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.START, expectedRevision: fixture.asset.revision });
  assert.equal(started.ok, true);
  if (!started.ok) throw new Error("failed to start fixture asset");
  const submitted = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: started.asset.revision });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) throw new Error("failed to submit fixture asset");
  return { fixture, revision: submitted.asset.revision };
}

test("review decisions persist feedback and reject blank feedback", { skip: !enabled }, async () => {
  assert.equal(assetWorkflowActionRequestSchema.safeParse({ action: AssetWorkflowAction.REJECT, expectedRevision: 1, feedback: "   " }).success, false);
  const { fixture, revision } = await submitForReview();
  try {
    const opened = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.OPEN_REVIEW, expectedRevision: revision });
    assert.equal(opened.ok, true);
    const rejected = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.REJECT, expectedRevision: revision, feedback: "Adjust the box boundary." });
    assert.equal(rejected.ok, true);
    if (!rejected.ok) return;
    assert.equal(rejected.asset.status, AssetStatus.REJECTED);
    assert.equal(rejected.event.feedback, "Adjust the box boundary.");
  } finally { await fixture.cleanup(); }
});

test("only one concurrent review decision can win at the loaded revision", { skip: !enabled }, async () => {
  const { fixture, revision } = await submitForReview();
  try {
    const [approve, reject] = await Promise.all([
      applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.APPROVE, expectedRevision: revision }),
      applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.REJECT, expectedRevision: revision, feedback: "Concurrent review feedback." }),
    ]);
    assert.equal([approve, reject].filter((result) => result.ok).length, 1);
    assert.equal([approve, reject].filter((result) => !result.ok && result.failure.kind === "STALE_REVISION").length, 1);
  } finally { await fixture.cleanup(); }
});
