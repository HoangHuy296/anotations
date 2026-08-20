import assert from "node:assert/strict";
import test from "node:test";

import { getQueueDeliveryId } from "@annotationplatform/queue";

import { db } from "@/lib/db";

import {
  cleanupRepositoryImportUser,
  getRepositoryImportJob,
  publicGithubRequest,
  repositoryImportHttpEnabled,
  repositoryImportHttpSkipReason,
  repositoryImportRequest,
  repositoryImportQueueEvents,
  repositoryImportSnapshot,
  registerAndLoginRepositoryImportUser,
  safeQueueInspector,
  uniqueRepositoryImportKey,
} from "./helpers";

type ImportResponse = { data?: { dataset?: { id?: string }; job?: { id?: string } }; error?: { code?: string } };

async function read(response: Response) {
  const text = await response.text();
  try {
    return { response, body: JSON.parse(text) as ImportResponse };
  } catch {
    assert.fail(`repository acceptance returned a non-JSON response (HTTP ${response.status}, ${text.length} bytes)`);
  }
}

test("same actor/key/request returns the original Dataset and Job without a second delivery; a changed request conflicts", {
  skip: repositoryImportHttpEnabled ? false : repositoryImportHttpSkipReason,
  concurrency: false,
}, async () => {
  const actor = await registerAndLoginRepositoryImportUser();
  const queued: string[] = [];
  try {
    const key = uniqueRepositoryImportKey("same-key");
    const request = publicGithubRequest({ idempotencyKey: key });
    const first = await read(await repositoryImportRequest(actor.cookie, request));
    assert.equal(first.response.status, 202);
    assert.ok(first.body.data?.dataset?.id);
    assert.ok(first.body.data?.job?.id);
    queued.push(first.body.data.job.id);
    const afterFirst = await repositoryImportSnapshot();

    const second = await read(await repositoryImportRequest(actor.cookie, request));
    assert.equal(second.response.status, 200);
    assert.equal(second.body.data?.dataset?.id, first.body.data.dataset.id);
    assert.equal(second.body.data?.job?.id, first.body.data.job.id);

    const afterSecond = await repositoryImportSnapshot();
    assert.deepEqual(afterSecond, afterFirst, "a sequential replay must not add a durable row, event, delivery, or object");

    const conflict = await read(await repositoryImportRequest(actor.cookie, {
      ...request,
      datasetName: `${request.datasetName}-different`,
    }));
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error?.code, "IDEMPOTENCY_KEY_CONFLICT");

    const datasets = await db.dataset.findMany({
      where: { ownerId: actor.userId, creationIdempotencyKey: key },
      select: { id: true, creationRequestHash: true },
    });
    assert.equal(datasets.length, 1);
    const jobs = await db.job.findMany({
      where: { datasetId: datasets[0].id, idempotencyKey: key },
      select: { id: true },
    });
    assert.deepEqual(jobs.map((job) => job.id), [first.body.data.job.id]);
    assert.equal((await repositoryImportQueueEvents(first.body.data.job.id)).length, 1);
  } finally {
    const queue = safeQueueInspector();
    try { await Promise.all(queued.map((id) => queue.removeJob(id))); } finally { await queue.close(); }
    await cleanupRepositoryImportUser(actor.userId);
  }
});

test("concurrent same-key submissions create exactly one durable Dataset/Job acceptance", {
  skip: repositoryImportHttpEnabled ? false : repositoryImportHttpSkipReason,
  concurrency: false,
}, async () => {
  const actor = await registerAndLoginRepositoryImportUser();
  const queued: string[] = [];
  try {
    const key = uniqueRepositoryImportKey("concurrent-key");
    const request = publicGithubRequest({ idempotencyKey: key });
    const before = await repositoryImportSnapshot();
    const results = await Promise.all([
      repositoryImportRequest(actor.cookie, request).then(read),
      repositoryImportRequest(actor.cookie, request).then(read),
    ]);
    assert.deepEqual(results.map((result) => result.response.status).sort(), [200, 202]);
    const acceptedIds = new Set(results.map((result) => result.body.data?.job?.id));
    assert.equal(acceptedIds.size, 1);
    const jobId = [...acceptedIds][0];
    assert.ok(jobId);
    queued.push(jobId);

    const datasets = await db.dataset.findMany({
      where: { ownerId: actor.userId, creationIdempotencyKey: key },
      select: { id: true },
    });
    assert.equal(datasets.length, 1);
    const jobs = await db.job.findMany({
      where: { datasetId: datasets[0].id, idempotencyKey: key },
      select: { id: true },
    });
    assert.deepEqual(jobs.map((job) => job.id), [jobId]);
    const durableJob = await getRepositoryImportJob(jobId);
    assert.equal(durableJob.datasetId, datasets[0].id);
    assert.equal(durableJob.queueJobId, getQueueDeliveryId(jobId));
    assert.ok(durableJob.enqueuedAt, "the sole durable Job must be stamped after one delivery");
    assert.equal((await repositoryImportQueueEvents(jobId)).length, 1, "concurrent replay must write exactly one enqueue event");

    const queue = safeQueueInspector();
    try {
      const delivery = await queue.getJob(getQueueDeliveryId(jobId));
      assert.ok(delivery, "concurrent acceptance must create one queue delivery");
      assert.deepEqual(delivery.data, { jobId });
      assert.deepEqual(Object.keys(delivery.data), ["jobId"]);
    } finally {
      await queue.close();
    }

    const after = await repositoryImportSnapshot();
    assert.equal(after.datasetIds.length, before.datasetIds.length + 1);
    assert.equal(after.jobIds.length, before.jobIds.length + 1);
    assert.equal(after.jobEventIds.length, before.jobEventIds.length + 1);
    assert.deepEqual(after.sourceConnectionIds, before.sourceConnectionIds);
  } finally {
    const queue = safeQueueInspector();
    try { await Promise.all(queued.map((id) => queue.removeJob(id))); } finally { await queue.close(); }
    await cleanupRepositoryImportUser(actor.userId);
  }
});
