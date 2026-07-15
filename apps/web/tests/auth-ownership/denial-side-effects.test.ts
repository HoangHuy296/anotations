import assert from "node:assert/strict";
import test from "node:test";

import { cleanJobPayload, createAuthorizedExportJob, jobQueuePayloadSchema } from "@/lib/jobs/authorization";
import { db } from "@/lib/db";
import { createFixture, hasIntegrationDatabase } from "./helpers";

test("a forbidden Job request writes no Job and never builds a queue payload", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createFixture();
  try {
    const before = await db.job.count({ where: { datasetId: fixture.datasetId } });
    const denied = await createAuthorizedExportJob(fixture.actors.labeler, { datasetId: fixture.datasetId, input: { format: "json" } });
    const after = await db.job.count({ where: { datasetId: fixture.datasetId } });
    assert.equal(denied.status, 403);
    assert.equal(after, before);
  } finally { await fixture.cleanup(); }
});

test("queue transport accepts only a durable job id", () => {
  assert.deepEqual(cleanJobPayload("job_123"), { jobId: "job_123" });
  assert.equal(jobQueuePayloadSchema.safeParse({ jobId: "job_123", input: { secret: "must-not-queue" } }).success, false);
});

test("a hidden cross-dataset Job request writes no Job", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createFixture();
  try {
    const before = await db.job.count({ where: { datasetId: fixture.otherDatasetId } });
    const denied = await createAuthorizedExportJob(fixture.actors.owner, { datasetId: fixture.otherDatasetId, input: { format: "json" } });
    const after = await db.job.count({ where: { datasetId: fixture.otherDatasetId } });
    assert.equal(denied.status, 404);
    assert.equal(after, before);
  } finally { await fixture.cleanup(); }
});
