import assert from "node:assert/strict";
import test from "node:test";

import { AssetStatus, AssetWorkflowAction, Modality } from "@internal/db";

import { db } from "@/lib/db";
import { applyAssetWorkflowAction, getAssetWorkflow } from "@/lib/workflow/asset-workflow-service";
import { createWorkflowFixture } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("rework preserves annotations and rejection feedback before a guarded resubmission", { skip: !enabled }, async () => {
  const fixture = await createWorkflowFixture();
  try {
    await db.annotation.create({ data: { id: crypto.randomUUID(), datasetId: fixture.dataset.id, assetId: fixture.asset.id, createdById: fixture.labeler.id, modality: Modality.IMAGE, type: "BOUNDING_BOX", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } } });
    const start = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.START, expectedRevision: fixture.asset.revision });
    assert.equal(start.ok, true); if (!start.ok) return;
    const submit = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: start.asset.revision });
    assert.equal(submit.ok, true); if (!submit.ok) return;
    const reject = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.REJECT, expectedRevision: submit.asset.revision, feedback: "Please verify the boundary." });
    assert.equal(reject.ok, true); if (!reject.ok) return;
    const forbidden = await applyAssetWorkflowAction(fixture.reviewer, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.START_REWORK, expectedRevision: reject.asset.revision });
    assert.deepEqual(forbidden, { ok: false, failure: { kind: "FORBIDDEN" } });
    const rework = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.START_REWORK, expectedRevision: reject.asset.revision });
    assert.equal(rework.ok, true); if (!rework.ok) return;
    assert.equal(rework.asset.status, AssetStatus.IN_PROGRESS);
    assert.equal(await db.annotation.count({ where: { assetId: fixture.asset.id } }), 1);
    const resubmit = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.RESUBMIT, expectedRevision: rework.asset.revision });
    assert.equal(resubmit.ok, true); if (!resubmit.ok) return;
    const history = await getAssetWorkflow(fixture.labeler, fixture.dataset.id, fixture.asset.id);
    assert.equal(history.ok, true); if (!history.ok) return;
    assert.equal(history.history.find((event) => event.action === AssetWorkflowAction.REJECT)?.feedback, "Please verify the boundary.");
  } finally { await fixture.cleanup(); }
});
