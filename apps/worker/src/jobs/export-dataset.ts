import { createHash } from "node:crypto";
import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { EXPORT_FORMAT_CAPABILITY, isFormatSelectable, type ExportFormat } from "@annotationplatform/domain/export-format-capability";

import { getWorkerConfig } from "../config.js";
import { createWorkerMinio, ensureBucket } from "../providers/minio.js";
import { cancelJob, completeJob, failJob, heartbeatJob, updateJobProgress } from "./job-claim-lock.js";
import { buildExportManifest } from "./export-manifest.js";
import { getExportArtifactBuilder, type ExportArtifactResult } from "./export-format-registry.js";

export type ExportProcessResult = "completed" | "canceled" | "failed" | "refused";

/**
 * specs/028-multi-format-export §5/§9 -- dispatch is driven by the shared
 * capability matrix and the format registry, never a per-format
 * `if (format === "yolo")` branch here. JSON is the one deliberate,
 * architecturally-justified exception: it is the lossless NATIVE manifest
 * (`buildExportManifest`), reading a fundamentally different, whole-dataset
 * shape than every interoperable image format's shared bbox-eligibility
 * path -- not a special case invented to avoid using the registry.
 *
 * Artifact keys for JSON/COCO are preserved exactly as they were before
 * this refactor (existing completed Jobs' `resultStorageKey` must keep
 * resolving); every format after COCO gets one generic, format-name-driven
 * key, never a new per-format branch.
 */
function artifactKey(datasetId: string, jobId: string, format: ExportFormat, kind: ExportArtifactResult["kind"]) {
  if (format === "JSON") return `exports/${datasetId}/${jobId}/manifest-v1.json`;
  if (format === "COCO") return `exports/${datasetId}/${jobId}/coco.json`;
  const extension = kind === "archive" ? "zip" : "json";
  return `exports/${datasetId}/${jobId}/${format.toLowerCase()}.${extension}`;
}

function resultFilename(datasetId: string, format: ExportFormat, kind: ExportArtifactResult["kind"]) {
  if (format === "JSON") return `dataset-${datasetId}-export.json`;
  if (format === "COCO") return `dataset-${datasetId}-coco.json`;
  const extension = kind === "archive" ? "zip" : "json";
  return `dataset-${datasetId}-${format.toLowerCase()}.${extension}`;
}

function contentTypeFor(kind: ExportArtifactResult["kind"]) {
  return kind === "archive" ? "application/zip" : "application/json";
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
  const requestedFormat = typeof input.format === "string" && input.format in EXPORT_FORMAT_CAPABILITY ? input.format as ExportFormat : null;
  // JSON's manifestSchemaVersion is checked here (a JSON-specific input
  // detail, not part of the shared capability contract), everything else
  // is checked purely against the matrix.
  const format = requestedFormat && isFormatSelectable(requestedFormat) && (requestedFormat !== "JSON" || input.manifestSchemaVersion === "1")
    ? requestedFormat
    : null;
  if (!format) {
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

    let body: Buffer;
    let kind: ExportArtifactResult["kind"];
    let totalItems: number;
    let summaryMessage: string;
    let skippedItems = 0;

    if (format === "JSON") {
      const manifest = await buildExportManifest(db, job.datasetId, job.createdAt);
      if (!manifest) {
        await failJob(db, { jobId, lockToken });
        return "failed";
      }
      body = Buffer.from(JSON.stringify(manifest));
      kind = "single-file";
      totalItems = manifest.assets.length + manifest.labels.length + manifest.annotations.length;
      summaryMessage = "Dataset metadata export completed.";
    } else {
      const builder = getExportArtifactBuilder(format);
      if (!builder) {
        // Unreachable given API validation is driven by the same matrix,
        // but never silently falls back to a different format if it happens.
        await failJob(db, { jobId, lockToken });
        return "failed";
      }
      const result = await builder(db, job.datasetId);
      if (!result) {
        await failJob(db, { jobId, lockToken });
        return "failed";
      }
      kind = result.kind;
      body = result.kind === "archive" ? result.archive : Buffer.from(JSON.stringify(result.document));
      skippedItems = Object.values(result.skipped).reduce((sum, count) => sum + count, 0);
      totalItems = result.totalItems;
      // Matches the exact pre-registry COCO message
      // ("Dataset COCO export completed. N annotation(s) exported, M skipped.")
      // -- this refactor changes no observable COCO behavior.
      summaryMessage = `Dataset ${format} export completed. ${result.exportedAnnotationCount} annotation(s) exported, ${skippedItems} skipped.`;
    }

    if ((await updateJobProgress(db, { jobId, lockToken, progress: 40, totalItems, processedItems: 0, successItems: 0, failedItems: 0, skippedItems: 0 })).kind !== "updated") return "refused";
    if (await cancellationRequested(db, jobId)) return (await cancelJob(db, { jobId, lockToken })).kind === "updated" ? "canceled" : "refused";

    const checksum = createHash("sha256").update(body).digest("hex");
    const config = getWorkerConfig();
    const minio = createWorkerMinio(config);
    await ensureBucket(minio, config.MINIO_BUCKET);
    const key = artifactKey(job.datasetId, job.id, format, kind);
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
        "Content-Type": contentTypeFor(kind),
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
      resultFilename: resultFilename(job.datasetId, format, kind),
      stage: "FINISHED",
      summary: { message: summaryMessage, outcome: "completed", completedAt: new Date().toISOString(), resultCount: totalItems },
      progress: 100,
      totalItems,
      processedItems: totalItems,
      successItems: totalItems,
      failedItems: 0,
      skippedItems,
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
