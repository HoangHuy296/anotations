import assert from "node:assert/strict";
import test from "node:test";

import { getQueueDeliveryId, jobQueuePayloadSchema } from "@annotationplatform/queue";

import {
  cleanupRepositoryImportUser,
  getRepositoryImportJob,
  publicGithubRequest,
  repositoryImportHttpEnabled,
  repositoryImportHttpSkipReason,
  repositoryImportRequest,
  repositoryImportQueueEvents,
  registerAndLoginRepositoryImportUser,
  safeQueueInspector,
} from "./helpers";
import { githubFixtureRequestCount, resetGithubFixtureCounter } from "../repository-preflight/helpers";

async function readSafeResponse(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text) as { data?: { job?: { id?: string } }; error?: { code?: string } };
  } catch {
    assert.fail(`repository acceptance returned a non-JSON response (HTTP ${response.status}, ${text.length} bytes)`);
  }
}

test("accepted repository import has one isolated BullMQ delivery with exactly { jobId }", {
  skip: repositoryImportHttpEnabled ? false : repositoryImportHttpSkipReason,
  concurrency: false,
}, async () => {
  const actor = await registerAndLoginRepositoryImportUser();
  let jobId: string | undefined;
  try {
    await resetGithubFixtureCounter();
    const request = publicGithubRequest();
    assert.deepEqual(request.repository, {
      owner: "fixture",
      name: "public-images",
      repoUrl: "https://github.com/fixture/public-images",
      ref: "main",
      rootPath: "images",
      expectedVisibility: "PUBLIC",
    });
    assert.equal(JSON.stringify(request).includes("github-fixture"), false);
    const response = await repositoryImportRequest(actor.cookie, request);
    const body = await readSafeResponse(response);
    assert.equal(response.status, 202, `repository acceptance failed with ${body.error?.code ?? "unknown"}`);
    jobId = body.data?.job?.id;
    assert.ok(jobId);
    assert.ok(await githubFixtureRequestCount(), "canonical GitHub identity must cause server-side fixture provider access");

    const durable = await getRepositoryImportJob(jobId);
    assert.equal(durable.queueJobId, getQueueDeliveryId(jobId));
    assert.ok(durable.queueName);
    assert.ok(durable.enqueuedAt);
    assert.equal((await repositoryImportQueueEvents(jobId)).length, 1, "acceptance writes exactly one enqueue event");

    const queue = safeQueueInspector();
    try {
      const delivery = await queue.getJob(getQueueDeliveryId(jobId));
      assert.ok(delivery, "queue delivery must be present in the isolated namespace");
      assert.equal(delivery.name, "durable-job");
      assert.equal(delivery.opts.jobId, jobId);
      assert.deepEqual(jobQueuePayloadSchema.parse(delivery.data), { jobId });
      assert.deepEqual(Object.keys(delivery.data).sort(), ["jobId"]);
      const transport = JSON.stringify({ data: delivery.data, options: delivery.opts, name: delivery.name });
      for (const forbidden of ["datasetId", "sourceConnectionId", "manifest", "token", "ciphertext", "storageKey", "input", "error", "repository"]) {
        assert.equal(transport.includes(forbidden), false, `transport must not contain ${forbidden}`);
      }
    } finally {
      await queue.close();
    }
  } finally {
    if (jobId) {
      const queue = safeQueueInspector();
      try { await queue.removeJob(jobId); } finally { await queue.close(); }
    }
    await cleanupRepositoryImportUser(actor.userId);
  }
});
