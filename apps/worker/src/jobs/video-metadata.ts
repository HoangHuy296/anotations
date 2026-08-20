import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { mediaProcessingJobInputSchema } from "@annotationplatform/domain/media-processing";

import { getWorkerConfig } from "../config.js";
import { defaultMediaProcessingPolicy, assertMediaSourceWithinPolicy } from "../media/policy.js";
import { materializePrivateSource } from "../media/source-materialization.js";
import { runBoundedMediaProcess } from "../media/subprocess.js";
import { withJobTempWorkspace } from "../media/temp-workspace.js";
import { createWorkerMinio } from "../providers/minio.js";
import { cancelJob, completeJob, failJob, heartbeatJob, updateJobProgress } from "./job-claim-lock.js";

export type VideoMetadata = { durationMs: number | null; fps: number | null; totalFrames: number | null; codec: string | null };
export type VideoMetadataProcessResult = "completed" | "canceled" | "failed" | "refused";

function finiteInt(value: unknown, max: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

function parseFrameRate(value: unknown) {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,9})\/(\d{1,9})$/.exec(value);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (denominator === 0) return null;
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 && fps <= 1_000 ? fps : null;
}

/** Parses only the small ffprobe subset that is safe and useful to persist. */
export function parseFfprobeVideoMetadata(raw: Buffer, maxDurationMs = defaultMediaProcessingPolicy.maxDurationMs): VideoMetadata | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as { format?: { duration?: unknown }; streams?: unknown };
  const durationSeconds = typeof root.format?.duration === "string" ? Number(root.format.duration) : null;
  const durationMs = durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds >= 0
    ? Math.round(durationSeconds * 1_000)
    : null;
  if (durationMs !== null && durationMs > maxDurationMs) return null;
  const stream = Array.isArray(root.streams)
    ? root.streams.find((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : null;
  if (!stream) return null;
  const codec = typeof stream.codec_name === "string" && /^[a-z0-9._-]{1,120}$/i.test(stream.codec_name) ? stream.codec_name : null;
  const totalFrames = typeof stream.nb_frames === "string" && /^\d+$/.test(stream.nb_frames)
    ? finiteInt(Number(stream.nb_frames), 2_000_000_000)
    : finiteInt(stream.nb_frames, 2_000_000_000);
  return { durationMs, fps: parseFrameRate(stream.avg_frame_rate), totalFrames, codec };
}

async function cancellationRequested(db: PrismaClient, jobId: string, lockToken: string) {
  const job = await db.job.findFirst({ where: { id: jobId, lockToken, status: { in: ["RUNNING", "CANCELING"] } }, select: { cancelRequestedAt: true, status: true } });
  return Boolean(job?.cancelRequestedAt || job?.status === "CANCELING");
}

async function failSafely(db: PrismaClient, jobId: string, lockToken: string, errorCode: string) {
  await db.job.updateMany({ where: { id: jobId, lockToken, status: "RUNNING", lockedUntil: { gt: new Date() } }, data: { errorCode } });
  await failJob(db, { jobId, lockToken });
}

async function cancelIfRequested(db: PrismaClient, jobId: string, lockToken: string) {
  if (!(await cancellationRequested(db, jobId, lockToken))) return false;
  return (await cancelJob(db, { jobId, lockToken })).kind === "updated";
}

/**
 * Private VIDEO processor. It receives only the durable Job id and lock token
 * from the queue route; the Asset source location is reloaded internally from
 * PostgreSQL and never copied to Job input/events/public responses.
 */
export async function processVideoMetadata(db: PrismaClient, jobId: string, lockToken: string): Promise<VideoMetadataProcessResult> {
  const job = await db.job.findFirst({
    where: { id: jobId, type: "EXTRACT_VIDEO_METADATA", lockToken, status: { in: ["RUNNING", "CANCELING"] } },
    select: { id: true, datasetId: true, input: true },
  });
  if (!job) return "refused";
  if (await cancelIfRequested(db, job.id, lockToken)) return "canceled";

  const input = mediaProcessingJobInputSchema.safeParse(job.input);
  if (!input.success) {
    await failSafely(db, job.id, lockToken, "MEDIA_ASSET_INELIGIBLE");
    return "failed";
  }
  const asset = await db.asset.findFirst({
    where: { id: input.data.assetId, datasetId: job.datasetId, modality: "VIDEO", deletedAt: null, archivedAt: null },
    select: { id: true, sourceFingerprint: true, checksum: true, sizeBytes: true, sourceRevision: true, storageBucket: true, storageKey: true },
  });
  if (!asset || !asset.storageBucket || !asset.storageKey) {
    await failSafely(db, job.id, lockToken, "MEDIA_SOURCE_MISSING");
    return "failed";
  }
  const sourceBucket = asset.storageBucket;
  const sourceKey = asset.storageKey;
  const sourceMatches = asset.sourceFingerprint === input.data.source.sourceFingerprint
    && asset.checksum === input.data.source.checksum
    && asset.sizeBytes?.toString() === input.data.source.sizeBytes
    && asset.sourceRevision === input.data.source.sourceRevision;
  if (!sourceMatches) {
    await failSafely(db, job.id, lockToken, "MEDIA_SOURCE_STALE");
    return "failed";
  }
  if (!assertMediaSourceWithinPolicy({ sizeBytes: asset.sizeBytes }).ok) {
    await failSafely(db, job.id, lockToken, "MEDIA_POLICY_REJECTED");
    return "failed";
  }
  if ((await updateJobProgress(db, { jobId: job.id, lockToken, stage: "VALIDATING_INPUT", progress: 1, totalItems: 1, processedItems: 0, successItems: 0, failedItems: 0, skippedItems: 0 })).kind !== "updated") return "refused";

  try {
    return await withJobTempWorkspace(job.id, async (workspace) => {
      const config = getWorkerConfig();
      const minio = createWorkerMinio(config);
      if (await cancelIfRequested(db, job.id, lockToken)) return "canceled";
      if ((await updateJobProgress(db, { jobId: job.id, lockToken, stage: "PREPARING_WORKSPACE", progress: 10 })).kind !== "updated") return "refused";
      const source = await materializePrivateSource({
        minio,
        bucket: sourceBucket,
        objectKey: sourceKey,
        destinationPath: `${workspace.path}/source`,
        expectedSizeBytes: asset.sizeBytes,
        maxSourceBytes: defaultMediaProcessingPolicy.maxSourceBytes,
      });
      if (source.kind !== "materialized") {
        await failSafely(db, job.id, lockToken, source.kind === "policy_rejected" ? "MEDIA_POLICY_REJECTED" : "MEDIA_SOURCE_MISSING");
        return "failed";
      }
      if (await cancelIfRequested(db, job.id, lockToken)) return "canceled";
      if ((await heartbeatJob(db, { jobId: job.id, lockToken })).kind !== "updated") return "refused";
      if ((await updateJobProgress(db, { jobId: job.id, lockToken, stage: "EXTRACTING_METADATA", progress: 50 })).kind !== "updated") return "refused";
      const probe = await runBoundedMediaProcess({
        command: "ffprobe",
        args: ["-v", "error", "-show_entries", "format=duration:stream=codec_name,avg_frame_rate,nb_frames", "-of", "json", source.path],
        cwd: workspace.path,
        timeoutMs: defaultMediaProcessingPolicy.maxProcessMs,
        maxOutputBytes: defaultMediaProcessingPolicy.maxProcessOutputBytes,
        isCancellationRequested: () => cancellationRequested(db, job.id, lockToken),
      });
      if (probe.kind === "canceled") return (await cancelJob(db, { jobId: job.id, lockToken })).kind === "updated" ? "canceled" : "refused";
      if (probe.kind !== "completed") {
        await failSafely(db, job.id, lockToken, probe.kind === "timed_out" || probe.kind === "output_limit_exceeded" ? "MEDIA_POLICY_REJECTED" : "MEDIA_PROBE_FAILED");
        return "failed";
      }
      const metadata = parseFfprobeVideoMetadata(probe.stdout);
      if (!metadata || !assertMediaSourceWithinPolicy({ sizeBytes: asset.sizeBytes, durationMs: metadata.durationMs }).ok) {
        await failSafely(db, job.id, lockToken, metadata ? "MEDIA_POLICY_REJECTED" : "MEDIA_PROBE_FAILED");
        return "failed";
      }
      if (await cancelIfRequested(db, job.id, lockToken)) return "canceled";
      if ((await heartbeatJob(db, { jobId: job.id, lockToken })).kind !== "updated") return "refused";
      if ((await updateJobProgress(db, { jobId: job.id, lockToken, stage: "WRITING_METADATA", progress: 85 })).kind !== "updated") return "refused";
      const reconciled = await db.$transaction(async (tx) => {
        const liveJob = await tx.job.findFirst({ where: { id: job.id, lockToken, status: "RUNNING", lockedUntil: { gt: new Date() } }, select: { id: true } });
        const liveAsset = await tx.asset.findFirst({ where: { id: asset.id, datasetId: job.datasetId, modality: "VIDEO", sourceFingerprint: input.data.source.sourceFingerprint, checksum: input.data.source.checksum, sourceRevision: input.data.source.sourceRevision }, select: { id: true } });
        if (!liveJob || !liveAsset) return false;
        await tx.asset.update({ where: { id: liveAsset.id }, data: { durationMs: metadata.durationMs } });
        await tx.videoAsset.upsert({ where: { assetId: liveAsset.id }, create: { assetId: liveAsset.id, fps: metadata.fps, totalFrames: metadata.totalFrames, codec: metadata.codec, metadata: { processorVersion: input.data.processorVersion } }, update: { fps: metadata.fps, totalFrames: metadata.totalFrames, codec: metadata.codec, metadata: { processorVersion: input.data.processorVersion } } });
        return true;
      });
      if (!reconciled) {
        await failSafely(db, job.id, lockToken, "MEDIA_SOURCE_STALE");
        return "failed";
      }
      if (await cancelIfRequested(db, job.id, lockToken)) return "canceled";
      const completed = await completeJob(db, { jobId: job.id, lockToken, stage: "FINISHED", progress: 100, totalItems: 1, processedItems: 1, successItems: 1, failedItems: 0, skippedItems: 0, summary: { message: "Video metadata processing completed.", outcome: "completed", resultCount: 1 } });
      return completed.kind === "updated" ? "completed" : "refused";
    });
  } catch {
    await failSafely(db, job.id, lockToken, "MEDIA_PROBE_FAILED");
    return "failed";
  }
}
