import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { AssetStatus, AssetWorkflowAction } from "@internal/db";

import { db } from "@/lib/db";
import { applyAssetWorkflowAction } from "@/lib/workflow/asset-workflow-service";
import { createWorkflowFixture } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("labeler can start and submit an empty Asset once, with revision guards", { skip: !enabled }, async () => {
  const fixture = await createWorkflowFixture();
  try {
    const started = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.START, expectedRevision: fixture.asset.revision });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(started.asset.status, AssetStatus.IN_PROGRESS);
    const submitted = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: started.asset.revision });
    assert.equal(submitted.ok, true);
    if (!submitted.ok) return;
    assert.equal(submitted.asset.status, AssetStatus.NEEDS_REVIEW);
    const duplicate = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: submitted.asset.revision });
    assert.deepEqual(duplicate, { ok: false, failure: { kind: "INVALID_TRANSITION" } });
    const stale = await applyAssetWorkflowAction(fixture.labeler, fixture.dataset.id, fixture.asset.id, { action: AssetWorkflowAction.SUBMIT, expectedRevision: started.asset.revision });
    assert.deepEqual(stale, { ok: false, failure: { kind: "STALE_REVISION", currentRevision: submitted.asset.revision } });
    assert.equal(await db.annotation.count({ where: { assetId: fixture.asset.id } }), 0, "empty submission must not create annotations");
  } finally { await fixture.cleanup(); }
});
