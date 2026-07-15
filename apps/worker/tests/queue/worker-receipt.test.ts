import assert from "node:assert/strict";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { createFoundationWorker } from "../../src/queue/bullmq-worker.js";
import { createWorkerJobFixture, createWorkerQueueInspector } from "./helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL && process.env.REDIS_HOST);

async function waitForReceipt(read: () => Promise<Date | null>) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Worker did not record receipt.");
}

test("private worker consumes a strict Job reference and records one durable receipt", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createWorkerJobFixture();
  const inspector = createWorkerQueueInspector();
  const runtime = createFoundationWorker({ config: getWorkerConfig(), db: fixture.db });
  let jobId = "";
  try {
    await runtime.worker.waitUntilReady();
    const job = await fixture.createJob({ enqueuedAt: new Date() });
    jobId = job.id;
    await inspector.add(job.id);
    await waitForReceipt(async () => (await fixture.db.job.findUnique({ where: { id: job.id }, select: { dequeuedAt: true } }))?.dequeuedAt ?? null);
    const persisted = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, dequeuedAt: true } });
    assert.equal(persisted.status, "QUEUED");
    assert.ok(persisted.dequeuedAt);
    const events = await fixture.db.jobEvent.findMany({ where: { jobId: job.id, message: "QUEUE_RECEIVED" }, select: { message: true, data: true } });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.message, "QUEUE_RECEIVED");
    assert.equal(JSON.stringify(events[0]?.data).includes("input"), false);
  } finally {
    await runtime.close();
    if (jobId) await inspector.remove(jobId).catch(() => undefined);
    await inspector.close();
    await fixture.cleanup();
  }
});
