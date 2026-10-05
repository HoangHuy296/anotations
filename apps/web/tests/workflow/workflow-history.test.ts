import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { AssetWorkflowAction } from "@internal/db";

import { applyAssetWorkflowAction, getAssetWorkflow } from "@/lib/workflow/asset-workflow-service";
import { createWorkflowFixture } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("workflow history is ordered, safely attributed, and readable only by dataset members", { skip: !enabled }, async () => {
  const fixture = await createWorkflowFixture();
  try {
    const empty = await getAssetWorkflow(fixture.labeler, fixture.dataset.id, fixture.asset.id);
    assert.equal(empty.ok, true); if (!empty.ok) return;
    assert.deepEqual(empty.history, []);
    const start = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.START, expectedRevision: fixture.asset.revision });
    assert.equal(start.ok, true); if (!start.ok) return;
    const submit = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: start.asset.revision });
    assert.equal(submit.ok, true); if (!submit.ok) return;
    const open = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.OPEN_REVIEW, expectedRevision: submit.asset.revision });
    assert.equal(open.ok, true); if (!open.ok) return;
    const history = await getAssetWorkflow(fixture.owner, fixture.dataset.id, fixture.asset.id);
    assert.equal(history.ok, true); if (!history.ok) return;
    assert.deepEqual(history.history.map((event) => event.action), [AssetWorkflowAction.START, AssetWorkflowAction.SUBMIT, AssetWorkflowAction.OPEN_REVIEW]);
    assert.equal(history.history[2]?.actor.id, fixture.reviewer.id);
    assert.equal(history.history[2]?.assetRevision, submit.asset.revision);
  } finally { await fixture.cleanup(); }
});
