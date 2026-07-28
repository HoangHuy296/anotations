import assert from "node:assert/strict";
import test from "node:test";

import { getQueueDeliveryId, jobQueuePayloadSchema } from "@fieldframe/queue";

test("repository import queue transport admits only the durable Job reference", () => {
  const jobId = "job-phase016-queue-redaction";
  assert.deepEqual(jobQueuePayloadSchema.parse({ jobId }), { jobId });
  assert.equal(getQueueDeliveryId(jobId), jobId);

  for (const unsafe of [
    { jobId, datasetId: "dataset" },
    { jobId, sourceConnectionId: "connection" },
    { jobId, input: { source: { token: "never-queue" } } },
    { jobId, manifest: [{ path: "private/file" }] },
    { jobId, storageKey: "repository-imports/private" },
    { jobId, error: "provider diagnostic" },
  ]) {
    assert.equal(jobQueuePayloadSchema.safeParse(unsafe).success, false);
  }
});
