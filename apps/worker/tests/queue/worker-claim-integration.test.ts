import assert from "node:assert/strict";
import test from "node:test";

import { routeQueueDelivery } from "../../src/queue/queue-router.js";
import { createWorkerJobFixture } from "./helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

test("duplicate strict queue deliveries receive one durable claim and no token leaks into JobEvents", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    // IMPORT_DATASET intentionally remains RUNNING while it waits for the
    // browser commit signal. EXPORT_DATASET now has a real terminal processor.
    const job = await fixture.createJob({ type: "IMPORT_DATASET" });
    const [first, second] = await Promise.all([
      routeQueueDelivery({ db: fixture.db, payload: { jobId: job.id }, workerId: "worker-a" }),
      routeQueueDelivery({ db: fixture.db, payload: { jobId: job.id }, workerId: "worker-b" }),
    ]);
    assert.equal([first, second].filter((result) => result.kind === "claimed").length, 1);
    const stored = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, lockToken: true } });
    assert.equal(stored.status, "RUNNING");
    const events = await fixture.db.jobEvent.findMany({ where: { jobId: job.id }, select: { data: true, message: true } });
    assert.equal(events.filter((event) => event.message === "JOB_CLAIMED").length, 1);
    assert.equal(JSON.stringify(events).includes(stored.lockToken ?? "missing"), false);
  } finally { await fixture.cleanup(); }
});
