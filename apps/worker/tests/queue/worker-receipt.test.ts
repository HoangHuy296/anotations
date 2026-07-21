import assert from "node:assert/strict";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { createFoundationWorker } from "../../src/queue/bullmq-worker.js";
import { createWorkerJobFixture, createWorkerQueueInspector } from "./helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL && process.env.REDIS_HOST);

async function waitForClaim(read: () => Promise<string | null>) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Worker did not record claim.");
}

test("private worker consumes a strict Job reference, claims it, and does not invoke business work", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  const inspector = createWorkerQueueInspector();
  const runtime = createFoundationWorker({ config: getWorkerConfig(), db: fixture.db });
  let jobId = "";
  try {
    await runtime.worker.waitUntilReady();
    const job = await fixture.createJob({ enqueuedAt: new Date() });
    jobId = job.id;
    await inspector.add(job.id);
    await waitForClaim(async () => (await fixture.db.job.findUnique({ where: { id: job.id }, select: { lockToken: true } }))?.lockToken ?? null);
    const persisted = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, dequeuedAt: true, lockToken: true } });
    assert.equal(persisted.status, "RUNNING");
    assert.ok(persisted.dequeuedAt);
    assert.ok(persisted.lockToken);
    const events = await fixture.db.jobEvent.findMany({ where: { jobId: job.id }, select: { message: true, data: true } });
    assert.deepEqual(events.map((event) => event.message).sort(), ["JOB_CLAIMED", "QUEUE_RECEIVED"]);
    assert.equal(JSON.stringify(events).includes("input"), false);
    assert.equal(JSON.stringify(events).includes(persisted.lockToken), false);
  } finally {
    await runtime.close();
    if (jobId) await inspector.remove(jobId).catch(() => undefined);
    await inspector.close();
    await fixture.cleanup();
  }
});
