import assert from "node:assert/strict";
import test from "node:test";

import { db } from "@/lib/db";
import { enqueueExistingJob } from "@/lib/queue/enqueue-job";
import { runPendingJobRecovery } from "../../../worker/src/queue/recovery-scanner.js";
import { createJobQueueFixture, createQueueInspector, queueIntegrationSkipReason } from "./helpers";

test("recovery does not overwrite conflicting transport metadata or create a replacement Job", { skip: queueIntegrationSkipReason }, async () => {
  const fixture = await createJobQueueFixture();
  const inspector = createQueueInspector();
  try {
    const conflicting = await fixture.createQueuedJob();
    await db.job.update({ where: { id: conflicting.id }, data: { queueName: "other-private-queue" } });
    const recovery = await runPendingJobRecovery({ db, redeliverExistingJob: (jobId) => enqueueExistingJob(jobId) });
    assert.equal(recovery.skipped, 1);
    const after = await db.job.findUniqueOrThrow({ where: { id: conflicting.id }, select: { queueName: true, queueJobId: true, enqueuedAt: true } });
    assert.equal(after.queueName, "other-private-queue");
    assert.equal(after.queueJobId, null);
    assert.equal(after.enqueuedAt, null);
    assert.equal(await inspector.find(conflicting.id), undefined);
    assert.equal(await db.job.count({ where: { id: conflicting.id } }), 1);
  } finally {
    await inspector.close();
    await fixture.cleanup();
  }
});

test("an existing deterministic BullMQ delivery is reconciled onto the same unstamped Job", { skip: queueIntegrationSkipReason }, async () => {
  const fixture = await createJobQueueFixture();
  const inspector = createQueueInspector();
  try {
    const pending = await fixture.createQueuedJob();
    await inspector.add(pending.id);
    const reconciled = await enqueueExistingJob(pending.id);
    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.deliveryPending, false);
    const after = await db.job.findUniqueOrThrow({ where: { id: pending.id }, select: { id: true, queueJobId: true, enqueuedAt: true } });
    assert.equal(after.queueJobId, pending.id);
    assert.ok(after.enqueuedAt);
    assert.equal(await db.job.count({ where: { id: pending.id } }), 1);
    await inspector.remove(pending.id);
  } finally {
    await inspector.close();
    await fixture.cleanup();
  }
});
