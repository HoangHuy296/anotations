import assert from "node:assert/strict";
import test from "node:test";

import { db } from "@/lib/db";
import { enqueueExistingJob } from "@/lib/queue/enqueue-job";
import { runPendingJobRecovery } from "../../../worker/src/queue/recovery-scanner.js";

import {
  assertNoRepositoryImportSecret,
  cleanupRepositoryImportUser,
  publicGithubRequest,
  repositoryImportHttpEnabled,
  repositoryImportRequest,
  registerAndLoginRepositoryImportUser,
  safeQueueInspector,
} from "./helpers";

type AcceptedEnvelope = {
  data?: { dataset?: { id?: string }; job?: { id?: string; datasetId?: string; status?: string }; progressPath?: string };
  error?: { code?: string };
};

/**
 * This test is run only after the Compose *web* service is recreated with an
 * unused Redis port. The HTTP route therefore exercises the actual post-commit
 * enqueue failure path, while this host-side recovery call uses the controlled
 * safe Redis DB/prefix. No mock transport is used.
 */
test("an unavailable enqueue leaves one recoverable repository-import Job and recovery delivers that same Job once", {
  skip: repositoryImportHttpEnabled && process.env.REPOSITORY_IMPORT_QUEUE_OUTAGE === "1"
    ? false
    : "repository-import recovery requires the controlled Compose web queue-outage runtime",
  concurrency: false,
}, async () => {
  const actor = await registerAndLoginRepositoryImportUser();
  const queue = safeQueueInspector();
  let jobId = "";
  try {
    const response = await repositoryImportRequest(actor.cookie, publicGithubRequest());
    assert.equal(response.status, 202);
    const payload = await response.json() as AcceptedEnvelope;
    assert.ok(payload.data?.dataset?.id);
    assert.ok(payload.data?.job?.id);
    assert.equal(payload.data?.job?.datasetId, payload.data?.dataset?.id);
    assert.equal(payload.data?.job?.status, "QUEUED");
    assert.equal(payload.data?.progressPath, `/datasets/${payload.data.dataset.id}/imports/${payload.data.job.id}`);
    assertNoRepositoryImportSecret(payload);
    jobId = payload.data.job.id;

    const pending = await db.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { id: true, datasetId: true, status: true, queueName: true, queueJobId: true, enqueuedAt: true },
    });
    assert.deepEqual(pending, {
      id: jobId,
      datasetId: payload.data.dataset.id,
      status: "QUEUED",
      queueName: null,
      queueJobId: null,
      enqueuedAt: null,
    });
    assert.equal(await queue.getJob(jobId), undefined, "failed delivery must not create a Redis job");

    const recovered = await runPendingJobRecovery({
      db,
      redeliverExistingJob: (candidateId) => enqueueExistingJob(candidateId),
    });
    // The scanner is global by design. A prior interrupted controlled run may
    // leave another *independent* pending test Job in the shared development
    // database, so prove our durable Job was delivered exactly once below
    // instead of treating the scanner's aggregate delivery count as its ID.
    assert.ok(recovered.delivered >= 1);
    const recoveredDelivery = await queue.getJob(jobId);
    assert.deepEqual(recoveredDelivery?.data, { jobId });
    assert.deepEqual(Object.keys(recoveredDelivery?.data ?? {}), ["jobId"]);

    const delivered = await db.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { id: true, datasetId: true, status: true, queueJobId: true, enqueuedAt: true },
    });
    assert.equal(delivered.id, jobId);
    assert.equal(delivered.datasetId, payload.data.dataset.id);
    assert.equal(delivered.status, "QUEUED");
    assert.equal(delivered.queueJobId, jobId);
    assert.ok(delivered.enqueuedAt);

    const second = await runPendingJobRecovery({
      db,
      redeliverExistingJob: (candidateId) => enqueueExistingJob(candidateId),
    });
    assert.equal(second.examined, 0);
    assert.equal(await db.job.count({ where: { id: jobId } }), 1);
  } finally {
    if (jobId) await queue.removeJob(jobId);
    await queue.close();
    await cleanupRepositoryImportUser(actor.userId);
  }
});
