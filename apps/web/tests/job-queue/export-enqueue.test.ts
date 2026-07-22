import assert from "node:assert/strict";
import test from "node:test";

import { createAuthorizedExportJob } from "@/lib/exports/export-service";
import { db } from "@/lib/db";
import { createJobQueueFixture, createQueueInspector, queueIntegrationSkipReason } from "./helpers";

test("export submission persists canonical input and transports exactly jobId", { skip: queueIntegrationSkipReason }, async () => {
  const fixture = await createJobQueueFixture();
  const queue = createQueueInspector();
  let jobId = "";
  try {
    const result = await createAuthorizedExportJob(fixture.owner, { datasetId: fixture.datasetId });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    jobId = result.job.id;
    const stored = await db.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { type: true, status: true, input: true, queueName: true, queueJobId: true, enqueuedAt: true },
    });
    assert.equal(stored.type, "EXPORT_DATASET");
    assert.equal(stored.status, "QUEUED");
    assert.deepEqual(stored.input, { format: "JSON", manifestSchemaVersion: "1" });
    assert.ok(stored.queueName && stored.queueJobId && stored.enqueuedAt);
    const delivery = await queue.find(jobId);
    assert.ok(delivery);
    assert.deepEqual(delivery.data, { jobId });
    assert.deepEqual(Object.keys(delivery.data), ["jobId"]);
    const serialized = JSON.stringify(delivery.data);
    for (const prohibited of ["format", "manifest", "credential", "storage", "url", "token", "password"])
      assert.equal(serialized.toLowerCase().includes(prohibited), false);
  } finally {
    if (jobId) await queue.remove(jobId);
    await queue.close();
    await fixture.cleanup();
  }
});
