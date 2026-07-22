import assert from "node:assert/strict";
import test from "node:test";

import { getQueueDeliveryId, jobQueuePayloadSchema, queueNameForJobType } from "@fieldframe/queue";
import { foundationJobInputSchema, safeJobSummarySchema } from "@/lib/validation/job";

test("queue payload remains exactly one durable job id", () => {
  assert.deepEqual(jobQueuePayloadSchema.parse({ jobId: "job_123" }), { jobId: "job_123" });
  assert.equal(jobQueuePayloadSchema.safeParse({ jobId: "job_123", input: {} }).success, false);
  assert.equal(jobQueuePayloadSchema.safeParse({ jobId: "job_123", datasetId: "dataset_123" }).success, false);
  assert.equal(getQueueDeliveryId("job_123"), "job_123");
});

test("only an allowlisted existing Job type maps to a queue", () => {
  assert.ok(queueNameForJobType("EXPORT_DATASET"));
  assert.ok(queueNameForJobType("IMPORT_DATASET"));
  assert.equal(queueNameForJobType("AI_TASK_SYNC"), null);
});

test("foundation submission rejects unsupported Job types before a durable write", () => {
  assert.equal(foundationJobInputSchema.safeParse({ datasetId: "ck012345678901234567890123", type: "AI_TASK_SYNC", input: {} }).success, true);
  assert.equal(queueNameForJobType("AI_TASK_SYNC"), null);
});

test("safe summary schema rejects unapproved keys", () => {
  assert.equal(safeJobSummarySchema.safeParse({ message: "Done", resultCount: 1 }).success, true);
  assert.equal(safeJobSummarySchema.safeParse({ input: { private: true } }).success, false);
});
