import assert from "node:assert/strict";
import test from "node:test";

import { Modality, UserRole } from "@internal/db";

import { deleteAssetsBulk, resolveBulkSelection } from "@/lib/assets/asset-bulk-service";
import { db } from "@/lib/db";
import { createAndEnqueueBulkAssetJob } from "@/lib/queue/enqueue-job";
import { cleanupWorkspaceFixture, createImageAsset, createWorkspaceDataset, createWorkspaceUser, workspaceUnique } from "../workspace/helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

/** T034 (022): small-batch synchronous delete is authorized, soft-deletes (never hard-deletes), and is idempotent. */
test("a small batch delete soft-deletes every selected asset and leaves out-of-selection assets untouched", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const toDelete = await createImageAsset(dataset.id, { filename: "delete-me.png" });
    const untouched = await createImageAsset(dataset.id, { filename: "keep-me.png" });

    const resolved = await resolveBulkSelection(dataset.id, { mode: "EXPLICIT", assetIds: [toDelete.id] });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    const result = await deleteAssetsBulk(dataset.id, resolved.assetIds, resolved.notFoundIds);
    assert.deepEqual(result, { processed: 1, succeeded: 1, failed: 0, skipped: 0, failures: [] });

    const deletedRow = await db.asset.findUniqueOrThrow({ where: { id: toDelete.id }, select: { deletedAt: true } });
    assert.ok(deletedRow.deletedAt, "the asset is soft-deleted (deletedAt set), not hard-deleted");
    const stillExists = await db.asset.count({ where: { id: toDelete.id } });
    assert.equal(stillExists, 1, "the row itself is never hard-deleted -- only marked deletedAt for the async cleanup path");

    const untouchedRow = await db.asset.findUniqueOrThrow({ where: { id: untouched.id }, select: { deletedAt: true } });
    assert.equal(untouchedRow.deletedAt, null, "an asset outside the selection is completely unaffected");
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("deleting an already-deleted asset is idempotent -- reported skipped, never failed, never re-processed", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const asset = await createImageAsset(dataset.id);
    const first = await deleteAssetsBulk(dataset.id, [asset.id], []);
    assert.deepEqual(first, { processed: 1, succeeded: 1, failed: 0, skipped: 0, failures: [] });

    // A second attempt against the exact same already-deleted id (simulating
    // a retried request) must not error and must not re-set deletedAt.
    const deletedAtAfterFirst = (await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { deletedAt: true } })).deletedAt;
    const replay = await deleteAssetsBulk(dataset.id, [asset.id], []);
    assert.deepEqual(replay, { processed: 1, succeeded: 0, failed: 0, skipped: 1, failures: [] });
    const deletedAtAfterReplay = (await db.asset.findUniqueOrThrow({ where: { id: asset.id }, select: { deletedAt: true } })).deletedAt;
    assert.deepEqual(deletedAtAfterFirst, deletedAtAfterReplay, "the original deletedAt timestamp is untouched by the retry");
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("a deleted asset excluded from resolution can no longer be re-selected by a later filtered query", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const marker = workspaceUnique("delete-then-reselect");
    const asset = await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: `${marker}.png`, mimeType: "image/png", sourceFingerprint: marker } });
    await deleteAssetsBulk(dataset.id, [asset.id], []);

    const reResolved = await resolveBulkSelection(dataset.id, { mode: "FILTERED", query: { q: marker } });
    assert.equal(reResolved.ok, true);
    if (!reResolved.ok) return;
    assert.deepEqual(reResolved.assetIds, [], "a deleted asset never matches a subsequent query -- readWorkspacePage/buildAssetListWhere both filter deletedAt: null");
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

/**
 * The background path's real enqueue delivery, not just its DB-only
 * building blocks -- `resolveQueueName("BULK_DELETE_ASSETS")` must actually
 * resolve to a supported queue (i.e. `@annotationplatform/queue`'s built
 * `dist/` output must reflect the T007 schema change), or `queue.add()` is
 * silently never reachable and every large delete would fail at the
 * `enqueueExistingJob` step despite the Job row being created successfully.
 */
test("a large delete's background Job is actually enqueued via the {jobId}-only funnel, not just created", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const asset = await createImageAsset(dataset.id);
    const created = await createAndEnqueueBulkAssetJob(owner, {
      datasetId: dataset.id, type: "BULK_DELETE_ASSETS", permission: "asset.delete",
      selection: { mode: "EXPLICIT", assetIds: [asset.id] }, resolvedCount: 1,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const job = await db.job.findUniqueOrThrow({ where: { id: created.job.id }, select: { type: true, queueName: true } });
    assert.equal(job.type, "BULK_DELETE_ASSETS");
    assert.ok(job.queueName, "the Job was actually handed to a real queue, not left stuck at 400/queue-resolution-failure");
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("an asset outside the dataset is never resolved into a delete selection, regardless of what the client claims", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const otherDataset = await createWorkspaceDataset(owner.id);
  try {
    const outsideScope = await createImageAsset(otherDataset.id);
    const resolved = await resolveBulkSelection(dataset.id, { mode: "EXPLICIT", assetIds: [outsideScope.id] });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.deepEqual(resolved.assetIds, []);
    assert.deepEqual(resolved.notFoundIds, [outsideScope.id]);
    const result = await deleteAssetsBulk(dataset.id, resolved.assetIds, resolved.notFoundIds);
    assert.deepEqual(result, { processed: 1, succeeded: 0, failed: 0, skipped: 1, failures: [{ assetId: outsideScope.id, reason: "not_in_dataset" }] });
    assert.equal((await db.asset.findUniqueOrThrow({ where: { id: outsideScope.id }, select: { deletedAt: true } })).deletedAt, null, "the out-of-scope asset is never touched");
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id, otherDataset.id]); }
});
