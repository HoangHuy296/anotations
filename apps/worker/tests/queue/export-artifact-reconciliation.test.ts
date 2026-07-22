import assert from "node:assert/strict";
import test from "node:test";

import { processExportDataset } from "../../src/jobs/export-dataset.js";
import { claimJob } from "../../src/jobs/job-claim-lock.js";
import { routeQueueDelivery } from "../../src/queue/queue-router.js";
import { createExportMetadataFixture, createWorkerJobFixture, createWorkerMinioInspector } from "./helpers.js";

const enabled = process.env.EXPORT_INTEGRATION_TESTS === "1"
  && Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT && process.env.MINIO_ACCESS_KEY && process.env.MINIO_SECRET_KEY && process.env.MINIO_BUCKET);

test("repeat delivery reconciles to one deterministic private artifact", { skip: !enabled }, async () => {
  const fixture = await createWorkerJobFixture();
  const minio = createWorkerMinioInspector();
  let key = "";
  try {
    await createExportMetadataFixture(fixture);
    const job = await fixture.createJob({ input: { format: "JSON", manifestSchemaVersion: "1" } });
    const claim = await claimJob(fixture.db, { jobId: job.id, workerId: "artifact-worker" });
    assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed") return;
    assert.equal(await processExportDataset(fixture.db, job.id, claim.lockToken), "completed");
    const stored = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { resultStorageKey: true } });
    assert.ok(stored.resultStorageKey);
    key = stored.resultStorageKey;
    const before = await minio.stat(key);
    assert.deepEqual(await routeQueueDelivery({ db: fixture.db, payload: { jobId: job.id }, workerId: "duplicate-worker" }), { kind: "skipped", reason: "NOT_QUEUED" });
    assert.equal(await processExportDataset(fixture.db, job.id, claim.lockToken), "refused");
    const after = await minio.stat(key);
    assert.equal(after.etag, before.etag);
    assert.deepEqual(await minio.list(`exports/${fixture.datasetId}/${job.id}/`), [key]);
  } finally {
    if (key) await minio.remove(key).catch(() => undefined);
    await fixture.cleanup();
  }
});
