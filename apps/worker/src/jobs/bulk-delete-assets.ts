import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { bulkAssetJobInputSchema } from "@annotationplatform/domain/bulk-asset-job";

import { getWorkerConfig } from "../config.js";
import { createWorkerMinio } from "../providers/minio.js";
import { cleanupDeletedAssetObject } from "../queue/deleted-asset-cleanup.js";
import { buildBulkAssetWhere } from "./bulk-asset-selection.js";
import { cancelJob, completeJob, failJob, heartbeatJob, updateJobProgress } from "./job-claim-lock.js";

export type BulkDeleteProcessResult = "completed" | "canceled" | "failed" | "refused";

/** Bounded per-batch soft-delete pass -- large enough to make real progress, small enough to heartbeat/cancel-check regularly on a huge selection. */
const BATCH_SIZE = 200;

async function cancellationRequested(db: PrismaClient, jobId: string) {
  const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true, cancelRequestedAt: true } });
  return Boolean(job?.cancelRequestedAt || job?.status === "CANCELING");
}

async function setStage(db: PrismaClient, jobId: string, lockToken: string, stage: "RESOLVING_SELECTION" | "DELETING_ASSETS") {
  const updated = await db.job.updateMany({ where: { id: jobId, lockToken, lockedUntil: { gt: new Date() }, status: "RUNNING" }, data: { stage } });
  return updated.count === 1;
}

/**
 * Private worker processor for `BULK_DELETE_ASSETS` (022 User Story 3).
 *
 * Re-resolves the selection server-side from `Job.input` (never trusts a
 * pre-materialized list beyond what `EXPLICIT` mode already is --
 * research.md §4/§12), soft-deletes in bounded batches, and stops at the
 * database boundary: no synchronous MinIO call blocks or gates the delete
 * itself (FR-022). A best-effort *targeted* storage cleanup runs per batch
 * after the DB update, using the existing, already-tested
 * `cleanupDeletedAssetObject` primitive -- its failure is swallowed and
 * never affects Job outcome, because the periodic orphan scanner is the
 * guaranteed secondary layer for anything this targeted pass misses
 * (FR-023, consistent with Phase 21's invariants).
 *
 * Idempotent/retry-safe: each batch's `where` always carries `deletedAt:
 * null`, so an asset already soft-deleted by an earlier attempt simply stops
 * matching -- a full retry of the same Job (or the same selection resolving
 * to fewer/zero assets) converges to "nothing left to do" rather than
 * erroring or double-deleting.
 */
export async function processBulkDeleteAssets(db: PrismaClient, jobId: string, lockToken: string): Promise<BulkDeleteProcessResult> {
  const job = await db.job.findFirst({
    where: { id: jobId, type: "BULK_DELETE_ASSETS", lockToken, status: { in: ["RUNNING", "CANCELING"] } },
    select: { id: true, datasetId: true, input: true },
  });
  if (!job) return "refused";

  if (await cancellationRequested(db, jobId)) {
    return (await cancelJob(db, { jobId, lockToken })).kind === "updated" ? "canceled" : "refused";
  }

  const parsedInput = bulkAssetJobInputSchema.safeParse(job.input);
  if (!parsedInput.success) {
    await failJob(db, { jobId, lockToken });
    return "failed";
  }

  try {
    if (!(await setStage(db, jobId, lockToken, "RESOLVING_SELECTION"))) return "refused";
    const where = buildBulkAssetWhere(job.datasetId, parsedInput.data);
    const totalItems = await db.asset.count({ where });
    if ((await updateJobProgress(db, { jobId, lockToken, totalItems, processedItems: 0, successItems: 0, failedItems: 0, skippedItems: 0 })).kind !== "updated") return "refused";

    if (await cancellationRequested(db, jobId)) return (await cancelJob(db, { jobId, lockToken })).kind === "updated" ? "canceled" : "refused";

    const config = getWorkerConfig();
    const minio = createWorkerMinio(config);
    if (!(await setStage(db, jobId, lockToken, "DELETING_ASSETS"))) return "refused";

    let processed = 0;
    let succeeded = 0;
    for (;;) {
      if (await cancellationRequested(db, jobId)) return (await cancelJob(db, { jobId, lockToken })).kind === "updated" ? "canceled" : "refused";
      // `where` always filters `deletedAt: null`, so this naturally
      // converges: every batch consumes assets this pass hasn't deleted yet.
      const batch = await db.asset.findMany({ where, select: { id: true, storageBucket: true, storageKey: true }, take: BATCH_SIZE });
      if (batch.length === 0) break;
      const ids = batch.map((asset) => asset.id);
      const deleted = await db.asset.updateMany({ where: { id: { in: ids }, deletedAt: null }, data: { deletedAt: new Date() } });
      succeeded += deleted.count;
      processed += batch.length;

      for (const asset of batch) {
        if (asset.storageBucket && asset.storageKey) {
          await cleanupDeletedAssetObject({ db, minio, bucket: asset.storageBucket, key: asset.storageKey }).catch(() => undefined);
        }
      }

      const progressResult = await updateJobProgress(db, {
        jobId, lockToken, processedItems: processed, successItems: succeeded, failedItems: 0, skippedItems: processed - succeeded,
        progress: totalItems > 0 ? Math.min(100, Math.round((processed / totalItems) * 100)) : 100,
      });
      if (progressResult.kind !== "updated") return "refused";
      if ((await heartbeatJob(db, { jobId, lockToken })).kind !== "updated") return "refused";
    }

    const completed = await completeJob(db, {
      jobId, lockToken, stage: "FINISHED",
      summary: { message: "Bulk delete completed.", outcome: "completed", completedAt: new Date().toISOString(), resultCount: succeeded, skipped: processed - succeeded, failed: 0 },
      progress: 100, totalItems, processedItems: processed, successItems: succeeded, failedItems: 0, skippedItems: processed - succeeded,
    });
    return completed.kind === "updated" ? "completed" : "refused";
  } catch {
    await failJob(db, { jobId, lockToken });
    return "failed";
  }
}
