import assert from "node:assert/strict";
import test from "node:test";

import { createAuthorizedExportJob } from "@/lib/exports/export-service";
import { createJobQueueFixture, createQueueInspector, queueIntegrationSkipReason } from "./helpers";

test("controlled Redis stores only the canonical export delivery payload", { skip: queueIntegrationSkipReason }, async () => {
  const fixture = await createJobQueueFixture();
  const queue = createQueueInspector();
  let jobId = "";
  try {
    const created = await createAuthorizedExportJob(fixture.owner, { datasetId: fixture.datasetId, format: "JSON", manifestSchemaVersion: "1" });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    jobId = created.job.id;
    const delivery = await queue.find(jobId);
    assert.ok(delivery);
    assert.deepEqual(delivery.data, { jobId });
    const serialized = JSON.stringify(delivery.data).toLowerCase();
    for (const term of ["datasetid", "format", "manifest", "credential", "password", "secret", "token", "storage", "binary", "url"])
      assert.equal(serialized.includes(term), false);
  } finally {
    if (jobId) await queue.remove(jobId);
    await queue.close();
    await fixture.cleanup();
  }
});
