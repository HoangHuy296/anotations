import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { processBulkDeleteAssets } from "../../src/jobs/bulk-delete-assets.js";
import { claimJob } from "../../src/jobs/job-claim-lock.js";
import { createWorkerMinio } from "../../src/providers/minio.js";
import { createWorkerJobFixture, createWorkerMinioInspector } from "../queue/helpers.js";

const enabled = process.env.GARBAGE_COLLECTION_RUNTIME_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const skip = enabled ? false : "explicit GARBAGE_COLLECTION_RUNTIME_TESTS=1 + DATABASE_URL required (real MinIO deletes)";

/** T035 (022): the BULK_DELETE_ASSETS worker processor -- end-to-end completion, DB/MinIO independence, idempotent retry, and no-referenced-object-deleted safety. */

test("processes a QUEUED BULK_DELETE_ASSETS Job end-to-end: soft-deletes the resolved selection and completes with an accurate summary", { skip }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const marker = randomUUID();
    const assets = await Promise.all([0, 1, 2].map((index) =>
      fixture.db.asset.create({ data: { datasetId: fixture.datasetId, modality: "IMAGE", filename: `${marker}-${index}.png`, mimeType: "image/png", sourceFingerprint: `${marker}-${index}` }, select: { id: true } })));
    const job = await fixture.createJob({ type: "BULK_DELETE_ASSETS", input: { mode: "EXPLICIT", assetIds: assets.map((asset) => asset.id) } });
    const claim = await claimJob(fixture.db, { jobId: job.id, workerId: "bulk-delete-worker" });
    assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed") return;

    assert.equal(await processBulkDeleteAssets(fixture.db, job.id, claim.lockToken), "completed");

    const finished = await fixture.db.job.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, successItems: true, totalItems: true, processedItems: true, summary: true } });
    assert.equal(finished.status, "COMPLETED");
    assert.equal(finished.successItems, 3);
    assert.equal(finished.totalItems, 3);
    assert.equal(finished.processedItems, 3);

    for (const asset of assets) {
      const row = await fixture.db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { deletedAt: true } });
      assert.ok(row.deletedAt, "every selected asset is soft-deleted");
    }
  } finally { await fixture.cleanup(); }
});

test("DB deletion succeeds even when the per-asset MinIO cleanup call fails for one asset", { skip }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const marker = randomUUID();
    const asset = await fixture.db.asset.create({
      data: {
        datasetId: fixture.datasetId, modality: "IMAGE", filename: `${marker}.png`, mimeType: "image/png",
        sourceFingerprint: marker, storageProvider: "MINIO", storageBucket: "this-bucket-does-not-exist-and-will-error", storageKey: `${marker}/object.png`,
      },
      select: { id: true },
    });
    const job = await fixture.createJob({ type: "BULK_DELETE_ASSETS", input: { mode: "EXPLICIT", assetIds: [asset.id] } });
    const claim = await claimJob(fixture.db, { jobId: job.id, workerId: "bulk-delete-worker" });
    assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed") return;

    // FR-022: PostgreSQL deletion must not depend on MinIO availability --
    // the Job must still complete even though its (deliberately broken)
    // storage cleanup call cannot possibly succeed.
    assert.equal(await processBulkDeleteAssets(fixture.db, job.id, claim.lockToken), "completed");
    const row = await fixture.db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { deletedAt: true } });
    assert.ok(row.deletedAt, "the DB soft-delete still succeeds despite the storage cleanup failure");
  } finally { await fixture.cleanup(); }
});

test("retrying against an already-processed selection is idempotent: nothing left to delete, still completes cleanly", { skip }, async () => {
  const fixture = await createWorkerJobFixture();
  try {
    const marker = randomUUID();
    const asset = await fixture.db.asset.create({ data: { datasetId: fixture.datasetId, modality: "IMAGE", filename: `${marker}.png`, mimeType: "image/png", sourceFingerprint: marker }, select: { id: true } });
    const firstJob = await fixture.createJob({ type: "BULK_DELETE_ASSETS", input: { mode: "EXPLICIT", assetIds: [asset.id] } });
    const firstClaim = await claimJob(fixture.db, { jobId: firstJob.id, workerId: "bulk-delete-worker" });
    if (firstClaim.kind !== "claimed") { assert.fail("expected first claim to succeed"); return; }
    assert.equal(await processBulkDeleteAssets(fixture.db, firstJob.id, firstClaim.lockToken), "completed");

    // A second Job over the exact same (now already-deleted) selection --
    // simulates a retried submission. It must not error, double-delete, or
    // corrupt state; it simply finds nothing left to do.
    const retryJob = await fixture.createJob({ type: "BULK_DELETE_ASSETS", input: { mode: "EXPLICIT", assetIds: [asset.id] } });
    const retryClaim = await claimJob(fixture.db, { jobId: retryJob.id, workerId: "bulk-delete-worker-retry" });
    if (retryClaim.kind !== "claimed") { assert.fail("expected retry claim to succeed"); return; }
    assert.equal(await processBulkDeleteAssets(fixture.db, retryJob.id, retryClaim.lockToken), "completed");
    const retryFinished = await fixture.db.job.findUniqueOrThrow({ where: { id: retryJob.id }, select: { successItems: true, totalItems: true } });
    assert.equal(retryFinished.totalItems, 0, "the already-deleted asset no longer matches deletedAt: null, so nothing new is resolved");
    assert.equal(retryFinished.successItems, 0);
  } finally { await fixture.cleanup(); }
});

test("an asset outside the Job's selection, including its storage object, is never touched", { skip }, async () => {
  const fixture = await createWorkerJobFixture();
  const minio = createWorkerMinioInspector();
  const config = getWorkerConfig();
  const marker = randomUUID();
  const untouchedKey = `bulk-delete-test/${marker}/untouched-object`;
  try {
    const minioClient = createWorkerMinio(config);
    await minioClient.putObject(config.MINIO_BUCKET, untouchedKey, Buffer.from("keep-me"));
    const untouched = await fixture.db.asset.create({
      data: { datasetId: fixture.datasetId, modality: "IMAGE", filename: `${marker}-untouched.png`, mimeType: "image/png", sourceFingerprint: `${marker}-untouched`, storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET, storageKey: untouchedKey },
      select: { id: true },
    });
    const toDelete = await fixture.db.asset.create({ data: { datasetId: fixture.datasetId, modality: "IMAGE", filename: `${marker}-delete.png`, mimeType: "image/png", sourceFingerprint: `${marker}-delete` }, select: { id: true } });

    const job = await fixture.createJob({ type: "BULK_DELETE_ASSETS", input: { mode: "EXPLICIT", assetIds: [toDelete.id] } });
    const claim = await claimJob(fixture.db, { jobId: job.id, workerId: "bulk-delete-worker" });
    if (claim.kind !== "claimed") { assert.fail("expected claim to succeed"); return; }
    assert.equal(await processBulkDeleteAssets(fixture.db, job.id, claim.lockToken), "completed");

    const untouchedRow = await fixture.db.asset.findUniqueOrThrow({ where: { id: untouched.id }, select: { deletedAt: true } });
    assert.equal(untouchedRow.deletedAt, null, "an asset outside the selection is never soft-deleted");
    const stat = await minio.stat(untouchedKey);
    assert.ok(stat, "the untouched asset's storage object still exists");
  } finally {
    await minio.remove(untouchedKey).catch(() => undefined);
    await fixture.cleanup();
  }
});
