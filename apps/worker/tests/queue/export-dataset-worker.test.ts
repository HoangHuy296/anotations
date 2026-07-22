import assert from "node:assert/strict";
import test from "node:test";

import { claimJob } from "../../src/jobs/job-claim-lock.js";
import { processExportDataset } from "../../src/jobs/export-dataset.js";
import { exportManifestSchema } from "../../src/jobs/export-manifest.js";
import { routeQueueDelivery } from "../../src/queue/queue-router.js";
import { createExportMetadataFixture, createWorkerJobFixture, createWorkerMinioInspector } from "./helpers.js";

const enabled = process.env.EXPORT_INTEGRATION_TESTS === "1"
  && Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT && process.env.MINIO_ACCESS_KEY && process.env.MINIO_SECRET_KEY && process.env.MINIO_BUCKET);

async function readStream(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("EXPORT_DATASET claims, writes PostgreSQL progress, and produces one private metadata manifest", { skip: !enabled }, async () => {
  const fixture = await createWorkerJobFixture();
  const minio = createWorkerMinioInspector();
  let artifactKey = "";
  try {
    await createExportMetadataFixture(fixture);
    const job = await fixture.createJob({ type: "EXPORT_DATASET", input: { format: "JSON", manifestSchemaVersion: "1" } });
    assert.deepEqual(await routeQueueDelivery({ db: fixture.db, payload: { jobId: job.id }, workerId: "phase012-export-worker" }), { kind: "claimed", jobId: job.id });
    const stored = await fixture.db.job.findUniqueOrThrow({
      where: { id: job.id },
      select: { status: true, stage: true, progress: true, processedItems: true, successItems: true, resultStorageKey: true, resultFilename: true, lockToken: true },
    });
    assert.equal(stored.status, "COMPLETED");
    assert.equal(stored.stage, "FINISHED");
    assert.equal(stored.progress, 100);
    assert.equal(stored.processedItems, stored.successItems);
    assert.equal(stored.lockToken, null);
    assert.ok(stored.resultStorageKey);
    artifactKey = stored.resultStorageKey;
    assert.ok(await minio.stat(artifactKey));
    const body = await readStream(await minio.read(artifactKey));
    const manifest = exportManifestSchema.parse(JSON.parse(body.toString("utf8")));
    assert.equal(manifest.dataset.id, fixture.datasetId);
    assert.equal(manifest.assets.length, 1);
    assert.equal(manifest.annotations.length, 1);
    assert.equal(await fixture.db.jobEvent.count({ where: { jobId: job.id, message: { in: ["QUEUE_RECEIVED", "JOB_CLAIMED", "JOB_PROGRESS", "JOB_COMPLETED"] } } }), 4);
    for (const prohibited of ["storageBucket", "storageKey", "private/source.jpg", "lockToken", "MINIO_SECRET_KEY"])
      assert.equal(body.includes(prohibited), false);
  } finally {
    if (artifactKey) await minio.remove(artifactKey).catch(() => undefined);
    await fixture.cleanup();
  }
});

test("EXPORT_DATASET acknowledges an already requested cancellation under its current lock", { skip: !enabled }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const job = await fixture.createJob({ type: "EXPORT_DATASET", input: { format: "JSON", manifestSchemaVersion: "1" } });
    const claim = await claimJob(fixture.db, { jobId: job.id, workerId: "phase012-cancel-worker" });
    assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed") return;
    await fixture.db.job.update({ where: { id: job.id }, data: { status: "CANCELING", cancelRequestedAt: new Date() } });
    assert.equal(await processExportDataset(fixture.db, job.id, claim.lockToken), "canceled");
    assert.equal((await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true } })).status, "CANCELED");
  } finally { await fixture.cleanup(); }
});
