import assert from "node:assert/strict";
import test from "node:test";

import { UserRole } from "@internal/db";

import { createAndEnqueueBulkAssetJob } from "@/lib/queue/enqueue-job";
import { db } from "@/lib/db";
import { cleanupWorkspaceFixture, createImageAsset, createWorkspaceDataset, createWorkspaceUser } from "../workspace/helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

/**
 * T042 (022): Export Selected always creates/enqueues a `BULK_EXPORT_SELECTED`
 * Job (the manifest itself is built and validated worker-side --
 * apps/worker/tests/jobs/export-selected-manifest.test.ts -- since the web
 * app never imports worker code; see research.md/route decision to always
 * run Export Selected in the background rather than duplicate a sync
 * manifest builder in apps/web).
 */
test("creates a BULK_EXPORT_SELECTED Job carrying only the selection, and enqueues it via the {jobId}-only funnel", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const asset = await createImageAsset(dataset.id);
    const created = await createAndEnqueueBulkAssetJob(owner, {
      datasetId: dataset.id, type: "BULK_EXPORT_SELECTED", permission: "job.createExport",
      selection: { mode: "EXPLICIT", assetIds: [asset.id] }, resolvedCount: 1,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const job = await db.job.findUniqueOrThrow({ where: { id: created.job.id }, select: { type: true, datasetId: true, input: true, totalItems: true } });
    assert.equal(job.type, "BULK_EXPORT_SELECTED");
    assert.equal(job.datasetId, dataset.id);
    assert.deepEqual(job.input, { mode: "EXPLICIT", assetIds: [asset.id] }, "Job.input carries only the selection, never a pre-fetched asset list beyond what EXPLICIT mode already is");
    assert.equal(job.totalItems, 1);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("a user without job.createExport permission cannot create an Export Selected Job", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const created = await createAndEnqueueBulkAssetJob(labeler, {
      datasetId: dataset.id, type: "BULK_EXPORT_SELECTED", permission: "job.createExport",
      selection: { mode: "EXPLICIT", assetIds: [] }, resolvedCount: 0,
    });
    assert.equal(created.ok, false);
    if (created.ok) return;
    assert.equal(created.status, 404, "a non-member sees 404, not 403, concealing the dataset's existence");
  } finally { await cleanupWorkspaceFixture([owner.id, labeler.id], [dataset.id]); }
});

test("resubmitting the identical selection reuses the existing Job rather than creating a duplicate", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const asset = await createImageAsset(dataset.id);
    const first = await createAndEnqueueBulkAssetJob(owner, { datasetId: dataset.id, type: "BULK_EXPORT_SELECTED", permission: "job.createExport", selection: { mode: "EXPLICIT", assetIds: [asset.id] }, resolvedCount: 1 });
    const second = await createAndEnqueueBulkAssetJob(owner, { datasetId: dataset.id, type: "BULK_EXPORT_SELECTED", permission: "job.createExport", selection: { mode: "EXPLICIT", assetIds: [asset.id] }, resolvedCount: 1 });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.job.id, second.job.id, "an exact-duplicate concurrent submission collides on the same idempotency key");
    const count = await db.job.count({ where: { datasetId: dataset.id, type: "BULK_EXPORT_SELECTED" } });
    assert.equal(count, 1, "no duplicate Job row was created");
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});
