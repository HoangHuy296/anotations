import assert from "node:assert/strict";
import test from "node:test";

import { db } from "@/lib/db";
import { createBoundingBox, updateBoundingBoxGeometry } from "@/lib/workspace/image-mutations";
import { createWorkflowFixture } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("legacy image mutations advance Asset revision once and roll it back on a stale child revision", { skip: !enabled }, async () => {
  const fixture = await createWorkflowFixture();
  try {
    const before = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { revision: true } });
    const created = await createBoundingBox(fixture.labeler, { datasetId: fixture.dataset.id, assetId: fixture.asset.id, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const afterCreate = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { revision: true } });
    assert.equal(afterCreate.revision, before.revision + 1);

    const updated = await updateBoundingBoxGeometry(fixture.labeler, { datasetId: fixture.dataset.id, assetId: fixture.asset.id, annotationId: created.value.id, revision: created.value.revision, geometry: { x: 0.2, y: 0.1, width: 0.2, height: 0.2 } });
    assert.equal(updated.ok, true);
    const afterUpdate = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { revision: true } });
    assert.equal(afterUpdate.revision, afterCreate.revision + 1);

    const stale = await updateBoundingBoxGeometry(fixture.labeler, { datasetId: fixture.dataset.id, assetId: fixture.asset.id, annotationId: created.value.id, revision: created.value.revision, geometry: { x: 0.3, y: 0.1, width: 0.2, height: 0.2 } });
    assert.deepEqual(stale, { ok: false, status: 409 });
    const afterStale = await db.asset.findUniqueOrThrow({ where: { id: fixture.asset.id }, select: { revision: true } });
    assert.equal(afterStale.revision, afterUpdate.revision, "failed child lock must roll back the parent revision claim");
  } finally { await fixture.cleanup(); }
});
