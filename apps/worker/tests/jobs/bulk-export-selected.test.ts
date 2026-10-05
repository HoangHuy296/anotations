import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { processBulkExportSelected } from "../../src/jobs/bulk-export-selected.js";
import { processExportDataset } from "../../src/jobs/export-dataset.js";
import { claimJob } from "../../src/jobs/job-claim-lock.js";
import { createWorkerJobFixture, createWorkerMinioInspector } from "../queue/helpers.js";

const enabled = process.env.GARBAGE_COLLECTION_RUNTIME_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const skip = enabled ? false : "explicit GARBAGE_COLLECTION_RUNTIME_TESTS=1 + DATABASE_URL required (real MinIO uploads)";

/** T043/T044 (022): the BULK_EXPORT_SELECTED worker processor, and its independence from the existing Dataset Export path. */

test("processes a QUEUED BULK_EXPORT_SELECTED Job end-to-end: uploads a selection-scoped manifest and completes with resultStorageKey set", { skip }, async () => {
  const fixture = await createWorkerJobFixture();
  const minio = createWorkerMinioInspector();
  let key = "";
  try {
    const marker = randomUUID();
    const asset = await fixture.db.asset.create({ data: { datasetId: fixture.datasetId, modality: "IMAGE", filename: `${marker}.png`, mimeType: "image/png", sourceFingerprint: marker }, select: { id: true } });
    const job = await fixture.createJob({ type: "BULK_EXPORT_SELECTED", input: { mode: "EXPLICIT", assetIds: [asset.id] } });
    const claim = await claimJob(fixture.db, { jobId: job.id, workerId: "bulk-export-worker" });
    assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed") return;

    assert.equal(await processBulkExportSelected(fixture.db, job.id, claim.lockToken), "completed");
    const finished = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, resultStorageKey: true, resultFilename: true } });
    assert.equal(finished.status, "COMPLETED");
    assert.ok(finished.resultStorageKey);
    key = finished.resultStorageKey;
    assert.match(key, new RegExp(`^exports/${fixture.datasetId}/selected/${job.id}/`), "Export Selected uses its own selection-scoped prefix, distinct from Dataset Export's exports/{datasetId}/{jobId}/ prefix");
    assert.ok(finished.resultFilename);

    const stored = await minio.read(key);
    const manifest = JSON.parse(await streamToString(stored)) as { selectedAssetCount: number; assets: { id: string }[] };
    assert.equal(manifest.selectedAssetCount, 1);
    assert.deepEqual(manifest.assets.map((item) => item.id), [asset.id]);
  } finally {
    if (key) await minio.remove(key).catch(() => undefined);
    await fixture.cleanup();
  }
});

test("Export Selected and Dataset Export produce fully independent artifacts for the same dataset -- neither affects the other", { skip }, async () => {
  const fixture = await createWorkerJobFixture();
  const minio = createWorkerMinioInspector();
  let selectedKey = "";
  let datasetKey = "";
  try {
    const marker = randomUUID();
    const label = await fixture.db.label.create({ data: { datasetId: fixture.datasetId, name: "object", normalizedName: `object-${marker}`, color: "#000000", modality: "IMAGE" }, select: { id: true } });
    const asset = await fixture.db.asset.create({
      data: { datasetId: fixture.datasetId, modality: "IMAGE", filename: `${marker}.png`, mimeType: "image/png", sourceFingerprint: marker, status: "COMPLETED" },
      select: { id: true },
    });
    await fixture.db.annotation.create({ data: { datasetId: fixture.datasetId, assetId: asset.id, labelId: label.id, createdById: fixture.ownerId, modality: "IMAGE", type: "BOUNDING_BOX", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } } });

    const datasetExportJob = await fixture.createJob({ type: "EXPORT_DATASET", input: { format: "JSON", manifestSchemaVersion: "1" } });
    const datasetClaim = await claimJob(fixture.db, { jobId: datasetExportJob.id, workerId: "dataset-export-worker" });
    if (datasetClaim.kind !== "claimed") { assert.fail("expected Dataset Export claim to succeed"); return; }
    assert.equal(await processExportDataset(fixture.db, datasetExportJob.id, datasetClaim.lockToken), "completed");
    const datasetExportFinished = await fixture.db.job.findUniqueOrThrow({ where: { id: datasetExportJob.id }, select: { resultStorageKey: true } });
    datasetKey = datasetExportFinished.resultStorageKey!;

    const selectedJob = await fixture.createJob({ type: "BULK_EXPORT_SELECTED", input: { mode: "EXPLICIT", assetIds: [asset.id] } });
    const selectedClaim = await claimJob(fixture.db, { jobId: selectedJob.id, workerId: "bulk-export-worker" });
    if (selectedClaim.kind !== "claimed") { assert.fail("expected Export Selected claim to succeed"); return; }
    assert.equal(await processBulkExportSelected(fixture.db, selectedJob.id, selectedClaim.lockToken), "completed");
    const selectedFinished = await fixture.db.job.findUniqueOrThrow({ where: { id: selectedJob.id }, select: { resultStorageKey: true, idempotencyKey: true } });
    selectedKey = selectedFinished.resultStorageKey!;

    assert.notEqual(selectedKey, datasetKey, "the two artifacts live at different storage keys");
    // Re-run Dataset Export's own idempotent creation logic conceptually by
    // confirming its Job row (and artifact) are untouched by the Export
    // Selected run that happened afterward.
    const datasetExportStillFinished = await fixture.db.job.findUniqueOrThrow({ where: { id: datasetExportJob.id }, select: { resultStorageKey: true, status: true } });
    assert.equal(datasetExportStillFinished.resultStorageKey, datasetKey);
    assert.equal(datasetExportStillFinished.status, "COMPLETED");
    await minio.stat(datasetKey); // still present, untouched
    await minio.stat(selectedKey);
  } finally {
    if (selectedKey) await minio.remove(selectedKey).catch(() => undefined);
    if (datasetKey) await minio.remove(datasetKey).catch(() => undefined);
    await fixture.cleanup();
  }
});

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}
