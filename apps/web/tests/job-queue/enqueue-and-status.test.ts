import assert from "node:assert/strict";
import test from "node:test";

import { JobStatus, JobType } from "@internal/db";
import { fieldframeQueueName } from "@fieldframe/queue";

import { db } from "@/lib/db";
import { createAndEnqueueFoundationJob } from "@/lib/queue/enqueue-job";
import { createJobQueueFixture, createQueueInspector, hasQueueIntegration } from "./helpers";

test("an authorized foundation Job is durable, delivered by its own id, and transport-stamped", { skip: !hasQueueIntegration }, async () => {
  const fixture = await createJobQueueFixture();
  const inspector = createQueueInspector();
  try {
    const result = await createAndEnqueueFoundationJob(fixture.owner, {
      datasetId: fixture.datasetId,
      type: JobType.EXPORT_DATASET,
      input: { format: "json" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.deliveryPending, false);
    assert.ok(result.status === 201 || result.status === 200);

    const persisted = await db.job.findUniqueOrThrow({ where: { id: result.job.id }, select: {
      id: true, datasetId: true, status: true, queueName: true, queueJobId: true, enqueuedAt: true,
    } });
    assert.equal(persisted.datasetId, fixture.datasetId);
    assert.equal(persisted.status, JobStatus.QUEUED);
    assert.equal(persisted.queueName, fieldframeQueueName);
    assert.equal(persisted.queueJobId, persisted.id);
    assert.ok(persisted.enqueuedAt);

    const transport = await inspector.find(persisted.id);
    assert.deepEqual(transport?.data, { jobId: persisted.id });
    assert.equal(transport?.id, persisted.id);
    await inspector.remove(persisted.id);
  } finally {
    await inspector.close();
    await fixture.cleanup();
  }
});
