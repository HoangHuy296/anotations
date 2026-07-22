import assert from "node:assert/strict";
import test from "node:test";

import { db } from "@/lib/db";
import { enqueueExistingJob } from "@/lib/queue/enqueue-job";
import { runPendingJobRecovery } from "../../../worker/src/queue/recovery-scanner.js";
import { createJobQueueFixture, createQueueInspector, queueIntegrationSkipReason } from "./helpers";

test("a failed enqueue leaves one pending Job and an explicit recovery delivers that same Job once", { skip: queueIntegrationSkipReason }, async () => {
  const fixture = await createJobQueueFixture();
  const inspector = createQueueInspector();
  try {
    const pending = await fixture.createQueuedJob();
    const failed = await enqueueExistingJob(pending.id, undefined, undefined, {
      createQueue: () => ({
        queue: { add: async () => { throw new Error("controlled queue outage"); } },
        close: async () => undefined,
      }),
    });
    assert.equal(failed.ok, true);
    assert.equal(failed.deliveryPending, true);
    const beforeRecovery = await db.job.findUniqueOrThrow({ where: { id: pending.id }, select: { status: true, enqueuedAt: true } });
    assert.equal(beforeRecovery.status, "QUEUED");
    assert.equal(beforeRecovery.enqueuedAt, null);

    const first = await runPendingJobRecovery({ db, redeliverExistingJob: (jobId) => enqueueExistingJob(jobId) });
    assert.equal(first.delivered, 1);
    const recovered = await db.job.findUniqueOrThrow({ where: { id: pending.id }, select: { id: true, enqueuedAt: true, queueJobId: true } });
    assert.equal(recovered.id, pending.id);
    assert.equal(recovered.queueJobId, pending.id);
    assert.ok(recovered.enqueuedAt);
    assert.deepEqual((await inspector.find(pending.id))?.data, { jobId: pending.id });

    const second = await runPendingJobRecovery({ db, redeliverExistingJob: (jobId) => enqueueExistingJob(jobId) });
    assert.equal(second.examined, 0);
    assert.equal(await db.job.count({ where: { id: pending.id } }), 1);
    await inspector.remove(pending.id);
  } finally {
    await inspector.close();
    await fixture.cleanup();
  }
});
