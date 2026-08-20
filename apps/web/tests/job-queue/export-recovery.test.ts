import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import { createQueueTransport, readSafeLocalQueueTestConfig } from "@annotationplatform/queue";

import { db } from "@/lib/db";
import { enqueueExistingJob } from "@/lib/queue/enqueue-job";
import { runPendingJobRecovery } from "../../../worker/src/queue/recovery-scanner.js";
import { createJobQueueFixture, createQueueInspector, queueIntegrationSkipReason } from "./helpers";

async function reserveThenReleaseLoopbackPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a controlled loopback outage port.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test("an unavailable real Redis transport leaves one durable export Job for exactly-once recovery", { skip: queueIntegrationSkipReason }, async () => {
  const fixture = await createJobQueueFixture();
  const inspector = createQueueInspector();
  const config = readSafeLocalQueueTestConfig();
  let jobId = "";
  try {
    const pending = await fixture.createQueuedJob();
    jobId = pending.id;
    const unavailablePort = await reserveThenReleaseLoopbackPort();
    const failed = await enqueueExistingJob(pending.id, undefined, undefined, {
      createQueue: () => {
        const queue = createQueueTransport({
          host: config.REDIS_HOST,
          port: unavailablePort,
          password: config.REDIS_PASSWORD,
          db: config.REDIS_TEST_DB,
          prefix: `${config.REDIS_TEST_PREFIX}:outage`,
          failFast: true,
        });
        return { queue, close: () => queue.close() };
      },
    });
    assert.equal(failed.ok, true);
    assert.equal(failed.deliveryPending, true);
    const beforeRecovery = await db.job.findUniqueOrThrow({
      where: { id: pending.id },
      select: { status: true, enqueuedAt: true, queueName: true, queueJobId: true, resultStorageKey: true },
    });
    assert.deepEqual(beforeRecovery, {
      status: "QUEUED",
      enqueuedAt: null,
      queueName: null,
      queueJobId: null,
      resultStorageKey: null,
    });

    const recovered = await runPendingJobRecovery({ db, redeliverExistingJob: (candidateId) => enqueueExistingJob(candidateId) });
    assert.equal(recovered.delivered, 1);
    assert.deepEqual((await inspector.find(pending.id))?.data, { jobId: pending.id });
    const stored = await db.job.findUniqueOrThrow({
      where: { id: pending.id },
      select: { status: true, enqueuedAt: true, queueJobId: true, resultStorageKey: true },
    });
    assert.equal(stored.status, "QUEUED");
    assert.ok(stored.enqueuedAt);
    assert.equal(stored.queueJobId, pending.id);
    assert.equal(stored.resultStorageKey, null);

    const second = await runPendingJobRecovery({ db, redeliverExistingJob: (candidateId) => enqueueExistingJob(candidateId) });
    assert.equal(second.examined, 0);
    assert.equal(await db.job.count({ where: { id: pending.id } }), 1);
  } finally {
    if (jobId) await inspector.remove(jobId);
    await inspector.close();
    await fixture.cleanup();
  }
});
