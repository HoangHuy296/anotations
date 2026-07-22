import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

import { getWorkerConfig } from "../config.js";
import { createWorkerMinio, ensureBucket } from "../providers/minio.js";
import { cancelJob, completeJob, failJob, heartbeatJob, updateJobProgress } from "./job-claim-lock.js";
import { buildExportManifest } from "./export-manifest.js";

export type ExportProcessResult = "completed" | "canceled" | "failed" | "refused";

function artifactKey(datasetId: string, jobId: string) {
  return `exports/${datasetId}/${jobId}/manifest-v1.json`;
}

async function cancellationRequested(db: PrismaClient, jobId: string) {
  const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true, cancelRequestedAt: true } });
  return Boolean(job?.cancelRequestedAt || job?.status === "CANCELING");
}

async function setStage(db: PrismaClient, jobId: string, lockToken: string, stage: "EXPORTING_DATASET" | "WRITING_EXPORT_FILE") {
  const updated = await db.job.updateMany({
    where: { id: jobId, lockToken, lockedUntil: { gt: new Date() }, status: "RUNNING" },
    data: { stage },
  });
  return updated.count === 1;
}

/** Private worker processor. It receives no configuration through BullMQ. */
export async function processExportDataset(db: PrismaClient, jobId: string, lockToken: string): Promise<ExportProcessResult> {
  const job = await db.job.findFirst({
    where: { id: jobId, type: "EXPORT_DATASET", lockToken, status: { in: ["RUNNING", "CANCELING"] } },
    select: { id: true, datasetId: true, createdAt: true, input: true },
  });
  if (!job) return "refused";

  if (await cancellationRequested(db, jobId)) {
    return (await cancelJob(db, { jobId, lockToken })).kind === "updated" ? "canceled" : "refused";
  }

  const input = job.input as { format?: unknown; manifestSchemaVersion?: unknown };
  if (input.format !== "JSON" || input.manifestSchemaVersion !== "1") {
    await failJob(db, { jobId, lockToken });
    return "failed";
  }

  let artifact: { bucket: string; key: string; remove: () => Promise<void> } | null = null;
  const cleanupUnpublishedArtifact = async () => {
    if (!artifact) return;
    const published = await db.job.count({ where: { id: jobId, status: "COMPLETED", resultStorageKey: artifact.key } });
    if (!published) await artifact.remove().catch(() => undefined);
  };
  try {
    if (!(await setStage(db, jobId, lockToken, "EXPORTING_DATASET"))) return "refused";
    const manifest = await buildExportManifest(db, job.datasetId, job.createdAt);
    if (!manifest) {
      await failJob(db, { jobId, lockToken });
      return "failed";
    }
    const totalItems = manifest.assets.length + manifest.labels.length + manifest.annotations.length;
    if ((await updateJobProgress(db, { jobId, lockToken, progress: 40, totalItems, processedItems: 0, successItems: 0, failedItems: 0, skippedItems: 0 })).kind !== "updated") return "refused";
    if (await cancellationRequested(db, jobId)) return (await cancelJob(db, { jobId, lockToken })).kind === "updated" ? "canceled" : "refused";

    const body = Buffer.from(JSON.stringify(manifest));
    const checksum = createHash("sha256").update(body).digest("hex");
    const config = getWorkerConfig();
    const minio = createWorkerMinio(config);
    await ensureBucket(minio, config.MINIO_BUCKET);
    const key = artifactKey(job.datasetId, job.id);
    artifact = { bucket: config.MINIO_BUCKET, key, remove: () => minio.removeObject(config.MINIO_BUCKET, key) };
    await heartbeatJob(db, { jobId, lockToken });
    if (!(await setStage(db, jobId, lockToken, "WRITING_EXPORT_FILE"))) return "refused";

    let uploadRequired = true;
    try {
      const existing = await minio.statObject(config.MINIO_BUCKET, key);
      uploadRequired = existing.metaData?.["x-amz-meta-sha256"] !== checksum;
    } catch {
      uploadRequired = true;
    }
    if (uploadRequired) {
      await minio.putObject(config.MINIO_BUCKET, key, body, body.byteLength, {
        "Content-Type": "application/json",
        "x-amz-meta-sha256": checksum,
      });
    }

    if (await cancellationRequested(db, jobId)) {
      await cleanupUnpublishedArtifact();
      return (await cancelJob(db, { jobId, lockToken })).kind === "updated" ? "canceled" : "refused";
    }
    const completed = await completeJob(db, {
      jobId,
      lockToken,
      resultStorageKey: key,
      resultFilename: `dataset-${job.datasetId}-export.json`,
      stage: "FINISHED",
      summary: { message: "Dataset metadata export completed.", outcome: "completed", completedAt: new Date().toISOString(), resultCount: totalItems },
      progress: 100,
      totalItems,
      processedItems: totalItems,
      successItems: totalItems,
      failedItems: 0,
      skippedItems: 0,
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
