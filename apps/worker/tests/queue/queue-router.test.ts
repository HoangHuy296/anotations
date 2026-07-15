import assert from "node:assert/strict";
import test from "node:test";

import { routeQueueDelivery } from "../../src/queue/queue-router.js";
import { createWorkerJobFixture } from "./helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

test("malformed, unknown, cancelled, non-queued, inactive, and unsupported deliveries are skipped without business side effects", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const archived = await fixture.createArchivedDataset();
    const [cancelled, running, inactive, unsupported] = await Promise.all([
      fixture.createJob({ cancelRequestedAt: new Date() }),
      fixture.createJob({ status: "RUNNING" }),
      fixture.createJob({ datasetId: archived.id }),
      fixture.createJob({ type: "IMPORT_DATASET" }),
    ]);
    const before = await fixture.db.job.count();
    assert.deepEqual(await routeQueueDelivery({ db: fixture.db, payload: { jobId: cancelled.id, input: {} } }), { kind: "skipped", reason: "MALFORMED_PAYLOAD" });
    assert.deepEqual(await routeQueueDelivery({ db: fixture.db, payload: { jobId: "unknown" } }), { kind: "skipped", reason: "UNKNOWN_JOB" });
    for (const [job, reason] of [[cancelled, "CANCELED"], [running, "NOT_QUEUED"], [inactive, "INACTIVE_DATASET"], [unsupported, "UNSUPPORTED_TYPE"]] as const) {
      assert.deepEqual(await routeQueueDelivery({ db: fixture.db, payload: { jobId: job.id } }), { kind: "skipped", reason });
      assert.equal((await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { dequeuedAt: true } })).dequeuedAt, null);
    }
    assert.equal(await fixture.db.job.count(), before);
    assert.equal(await fixture.db.jobEvent.count({ where: { jobId: { in: [cancelled.id, running.id, inactive.id, unsupported.id] }, message: "QUEUE_SKIPPED" } }), 4);
  } finally {
    await fixture.cleanup();
  }
});
