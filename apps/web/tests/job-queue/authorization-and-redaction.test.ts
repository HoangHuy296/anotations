import assert from "node:assert/strict";
import test from "node:test";

import { JobType } from "@internal/db";

import { db } from "@/lib/db";
import { createAndEnqueueFoundationJob } from "@/lib/queue/enqueue-job";
import { createJobQueueFixture, hasQueueIntegration } from "./helpers";

test("denied, malformed, cross-dataset, and unsupported submissions write no Job", { skip: !hasQueueIntegration }, async () => {
  const fixture = await createJobQueueFixture();
  try {
    const before = await db.job.count({ where: { datasetId: { in: [fixture.datasetId, fixture.otherDatasetId] } } });
    const labeler = await createAndEnqueueFoundationJob(fixture.labeler, { datasetId: fixture.datasetId, type: JobType.EXPORT_DATASET, input: {} });
    assert.deepEqual(labeler, { ok: false, status: 403 });
    const outsider = await createAndEnqueueFoundationJob(fixture.owner, { datasetId: fixture.otherDatasetId, type: JobType.EXPORT_DATASET, input: {} });
    assert.deepEqual(outsider, { ok: false, status: 404 });
    const malformed = await createAndEnqueueFoundationJob(fixture.owner, { datasetId: fixture.datasetId, type: JobType.EXPORT_DATASET, input: {}, queueName: "forged" });
    assert.deepEqual(malformed, { ok: false, status: 400 });
    const unsupported = await createAndEnqueueFoundationJob(fixture.owner, { datasetId: fixture.datasetId, type: JobType.IMPORT_DATASET, input: {} });
    assert.deepEqual(unsupported, { ok: false, status: 400 });
    assert.equal(await db.job.count({ where: { datasetId: { in: [fixture.datasetId, fixture.otherDatasetId] } } }), before);
  } finally {
    await fixture.cleanup();
  }
});
