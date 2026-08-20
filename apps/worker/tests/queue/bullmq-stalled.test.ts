import assert from "node:assert/strict";
import test from "node:test";
import { Worker, type Job as QueueJob } from "bullmq";
import { Redis } from "ioredis";

import { annotationPlatformQueueName } from "@annotationplatform/queue";

import { getWorkerConfig } from "../../src/config.js";
import { claimJob } from "../../src/jobs/job-claim-lock.js";
import { createWorkerJobFixture, createWorkerQueueInspector, workerQueueIntegrationSkipReason } from "./helpers.js";

/**
 * Proves FR-019/FR-020/FR-021 end-to-end against *real* BullMQ stall timing
 * (not just the durable claim guard in isolation, which
 * `queue-router.test.ts`'s "non-queued" case already covers): with the
 * short `lockDuration`/`stalledInterval` this feature makes configurable
 * (`bullmq-worker.ts#createFoundationWorker`), a worker that claims a Job
 * and then genuinely crashes (force-closed, its lock never released or
 * renewed — not a graceful shutdown) has that Job detected as stalled and
 * redelivered by BullMQ itself. The redelivery reaches the same
 * `job.repository.ts#claimJob` guard every other delivery path relies on,
 * so the durable Postgres Job is never claimed/processed twice — BullMQ's
 * own state is a delivery mechanism here, never re-mapped onto Job status.
 */
test("a genuinely stalled BullMQ delivery is redetected and redelivered, and the durable claim guard alone prevents the Job from being claimed twice", { skip: workerQueueIntegrationSkipReason, timeout: 15_000 }, async () => {
  const fixture = await createWorkerJobFixture();
  const inspector = createWorkerQueueInspector();
  const config = getWorkerConfig();
  const claimAttempts: Array<"claimed" | "refused"> = [];
  let onFirstClaim: (() => void) | undefined;
  const firstClaimed = new Promise<void>((resolve) => { onFirstClaim = resolve; });

  function connectionOptions() {
    return { host: config.REDIS_HOST, port: config.REDIS_PORT, password: config.REDIS_PASSWORD, db: config.REDIS_DB, maxRetriesPerRequest: null };
  }

  // Both workers share this processor: attempt the *real* production claim
  // (job-claim-lock.ts#claimJob, the same guard queue-router.ts uses), then
  // — only the delivery that actually wins the claim — hang forever, never
  // completing, heartbeating, or releasing the lock. A refused claim simply
  // returns, so BullMQ's own bookkeeping for that delivery completes
  // normally even though the durable Job was untouched by it.
  function processor() {
    return async (delivery: QueueJob) => {
      const payload = delivery.data as { jobId: string };
      const claim = await claimJob(fixture.db, { jobId: payload.jobId, workerId: "stall-sim" });
      claimAttempts.push(claim.kind === "claimed" ? "claimed" : "refused");
      if (claim.kind === "claimed") {
        onFirstClaim?.();
        await new Promise<void>(() => undefined);
      }
    };
  }

  // `Worker.close()` does not close a `connection` supplied by the caller
  // (see `bullmq-worker.ts`'s own ownership-tracking `close()` — the same
  // reason it exists there) — each raw ioredis connection created below
  // must be disconnected explicitly, or the process never exits.
  const connection1 = new Redis(connectionOptions());
  const connection2 = new Redis(connectionOptions());
  const worker1 = new Worker(annotationPlatformQueueName, processor(), {
    connection: connection1, prefix: config.BULLMQ_PREFIX,
    lockDuration: 300, stalledInterval: 200, maxStalledCount: 2,
  });
  let worker2: Worker | undefined;
  let jobId = "";
  try {
    await worker1.waitUntilReady();
    const job = await fixture.createJob({ type: "EXPORT_DATASET" });
    jobId = job.id;
    await inspector.add(job.id);
    await firstClaimed;

    // Force-close (not graceful): abandons the in-flight delivery without
    // releasing its BullMQ lock or completing the Job — simulating a crash,
    // not a clean shutdown.
    await worker1.close(true);

    // The worker that "comes back" — its own stalled-check timer detects
    // worker1's now-expired, never-renewed lock and is redelivered the Job.
    worker2 = new Worker(annotationPlatformQueueName, processor(), {
      connection: connection2, prefix: config.BULLMQ_PREFIX,
      lockDuration: 300, stalledInterval: 200, maxStalledCount: 2,
    });
    await worker2.waitUntilReady();

    const deadline = Date.now() + 10_000;
    while (claimAttempts.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    assert.deepEqual(
      claimAttempts,
      ["claimed", "refused"],
      "BullMQ must redeliver the stalled Job exactly once observed here, and the durable claim guard — not any BullMQ-side state — must be what refuses the second claim",
    );
    const after = await fixture.db.job.findUniqueOrThrow({ where: { id: jobId }, select: { status: true, lockedBy: true } });
    assert.equal(after.status, "RUNNING", "still RUNNING under the original claim — the refused redelivery never touched it");
    assert.equal(after.lockedBy, "stall-sim");
  } finally {
    await worker1.close(true).catch(() => undefined);
    await worker2?.close(true).catch(() => undefined);
    connection1.disconnect();
    connection2.disconnect();
    if (jobId) await inspector.remove(jobId).catch(() => undefined);
    await inspector.close();
    await fixture.cleanup();
  }
});
