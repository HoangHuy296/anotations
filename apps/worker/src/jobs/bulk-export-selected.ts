import { createHash } from "node:crypto";
import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { bulkAssetJobInputSchema } from "@annotationplatform/domain/bulk-asset-job";

import { getWorkerConfig } from "../config.js";
import { createWorkerMinio, ensureBucket } from "../providers/minio.js";
import { buildBulkAssetWhere } from "./bulk-asset-selection.js";
import { buildExportSelectedManifest } from "./export-selected-manifest.js";
import { cancelJob, completeJob, failJob, heartbeatJob, updateJobProgress } from "./job-claim-lock.js";

export type BulkExportSelectedProcessResult = "completed" | "canceled" | "failed" | "refused";

/** Distinct prefix from Dataset Export's `exports/{datasetId}/{jobId}/manifest-v1.json` -- never the same key, never able to collide with or supersede it (FR-027). */
function artifactKey(datasetId: string, jobId: string) {
  return `exports/${datasetId}/selected/${jobId}/manifest-v1.json`;
}

async function cancellationRequested(db: PrismaClient, jobId: string) {
  const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true, cancelRequestedAt: true } });
  return Boolean(job?.cancelRequestedAt || job?.status === "CANCELING");
}

async function setStage(db: PrismaClient, jobId: string, lockToken: string, stage: "RESOLVING_SELECTION" | "EXPORTING_SELECTED_ASSETS") {
  const updated = await db.job.updateMany({ where: { id: jobId, lockToken, lockedUntil: { gt: new Date() }, status: "RUNNING" }, data: { stage } });
  return updated.count === 1;
}

/**
 * Private worker processor for `BULK_EXPORT_SELECTED` (022 User Story 4).
 * Re-resolves the selection server-side (never trusts a pre-materialized
 * list beyond what `EXPLICIT` mode already is), builds a metadata-only
 * manifest via `buildExportSelectedManifest`, and uploads it under a
 * selection-specific key -- entirely independent of the existing Dataset
 * Export artifact/idempotency key. Mirrors `export-dataset.ts`'s
 * checksum-skip-if-unchanged and cleanup-on-failure pattern exactly.
 */
export async function processBulkExportSelected(db: PrismaClient, jobId: string, lockToken: string): Promise<BulkExportSelectedProcessResult> {
  const job = await db.job.findFirst({
    where: { id: jobId, type: "BULK_EXPORT_SELECTED", lockToken, status: { in: ["RUNNING", "CANCELING"] } },
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

  let artifact: { key: string; remove: () => Promise<void> } | null = null;
  const cleanupUnpublishedArtifact = async () => {
    if (!artifact) return;
    const published = await db.job.count({ where: { id: jobId, status: "COMPLETED", resultStorageKey: artifact.key } });
    if (!published) await artifact.remove().catch(() => undefined);
  };

  try {
    if (!(await setStage(db, jobId, lockToken, "RESOLVING_SELECTION"))) return "refused";
    const where = buildBulkAssetWhere(job.datasetId, parsedInput.data);
    const resolved = await db.asset.findMany({ where, select: { id: true } });
    const assetIds = resolved.map((asset) => asset.id);

    if (await cancellationRequested(db, jobId)) return (await cancelJob(db, { jobId, lockToken })).kind === "updated" ? "canceled" : "refused";

    const manifest = await buildExportSelectedManifest(db, job.datasetId, assetIds, new Date());
    const totalItems = manifest.assets.length + manifest.labels.length + manifest.annotations.length;
    if ((await updateJobProgress(db, { jobId, lockToken, progress: 40, totalItems, processedItems: 0, successItems: 0, failedItems: 0, skippedItems: 0 })).kind !== "updated") return "refused";
    if (!(await setStage(db, jobId, lockToken, "EXPORTING_SELECTED_ASSETS"))) return "refused";

    const body = Buffer.from(JSON.stringify(manifest));
    const checksum = createHash("sha256").update(body).digest("hex");
    const config = getWorkerConfig();
    const minio = createWorkerMinio(config);
    await ensureBucket(minio, config.MINIO_BUCKET);
    const key = artifactKey(job.datasetId, job.id);
    artifact = { key, remove: () => minio.removeObject(config.MINIO_BUCKET, key) };
    await heartbeatJob(db, { jobId, lockToken });

    let uploadRequired = true;
    try {
      const existing = await minio.statObject(config.MINIO_BUCKET, key);
      uploadRequired = existing.metaData?.["x-amz-meta-sha256"] !== checksum;
    } catch {
      uploadRequired = true;
    }
    if (uploadRequired) {
      await minio.putObject(config.MINIO_BUCKET, key, body, body.byteLength, { "Content-Type": "application/json", "x-amz-meta-sha256": checksum });
    }

    if (await cancellationRequested(db, jobId)) {
      await cleanupUnpublishedArtifact();
      return (await cancelJob(db, { jobId, lockToken })).kind === "updated" ? "canceled" : "refused";
    }

    const completed = await completeJob(db, {
      jobId, lockToken,
      resultStorageKey: key,
      resultFilename: `dataset-${job.datasetId}-selected-export.json`,
      stage: "FINISHED",
      summary: { message: "Export Selected completed.", outcome: "completed", completedAt: new Date().toISOString(), resultCount: totalItems },
      progress: 100, totalItems, processedItems: totalItems, successItems: totalItems, failedItems: 0, skippedItems: 0,
    });
    if (completed.kind === "updated") return "completed";
    await cleanupUnpublishedArtifact();
    return "refused";
  } catch {
    await cleanupUnpublishedArtifact();
    await failJob(db, { jobId, lockToken });
    return "failed";
  }
}
