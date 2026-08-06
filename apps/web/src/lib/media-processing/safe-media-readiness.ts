import "server-only";

import { JobType, Modality } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { toSafeJobStage } from "@/lib/jobs/safe-job-stage";
import { mediaProcessingJobInputSchema, type SafeMediaErrorCode } from "@/lib/media-processing/contracts";
import type { SafeMediaReadiness } from "@/types/media-processing";

export type { SafeMediaReadiness } from "@/types/media-processing";

const mediaErrorCodes = new Set<SafeMediaErrorCode>([
  "MEDIA_ASSET_INELIGIBLE",
  "MEDIA_SOURCE_STALE",
  "MEDIA_SOURCE_MISSING",
  "MEDIA_POLICY_REJECTED",
  "MEDIA_PROBE_FAILED",
  "MEDIA_WAVEFORM_FAILED",
  "MEDIA_PROCESSING_CANCELED",
]);

function toSafeOutcome(errorCode: string | null): SafeMediaReadiness["outcome"] {
  if (!errorCode || !mediaErrorCodes.has(errorCode as SafeMediaErrorCode)) return null;
  const code = errorCode as SafeMediaErrorCode;
  return {
    code,
    message: code === "MEDIA_PROCESSING_CANCELED"
      ? "Media processing was canceled."
      : code === "MEDIA_SOURCE_STALE"
        ? "The media source changed before processing completed."
        : "Media processing could not complete safely.",
  };
}

/**
 * Canonical server-only projection. It reads the durable Job only after the
 * Dataset/Asset relationship and dataset.read permission have been resolved.
 * Browser adapters and workspace engines must delegate here rather than
 * selecting raw Job input/state or private media storage fields themselves.
 */
export async function readSafeMediaReadiness(
  actor: RequestActor,
  datasetId: string,
  assetId: string,
): Promise<SafeMediaReadiness | null> {
  const access = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!access || access.forbidden) return null;

  const asset = await db.asset.findFirst({
    where: { id: assetId, datasetId, deletedAt: null, archivedAt: null, modality: { in: [Modality.VIDEO, Modality.AUDIO] } },
    select: {
      id: true,
      modality: true,
      durationMs: true,
      videoAsset: { select: { fps: true, totalFrames: true, codec: true } },
      audioAsset: { select: { sampleRate: true, channels: true, codec: true, bitRate: true, waveformKey: true } },
    },
  });
  if (!asset || (asset.modality !== Modality.VIDEO && asset.modality !== Modality.AUDIO)) return null;

  const type = asset.modality === Modality.VIDEO ? JobType.EXTRACT_VIDEO_METADATA : JobType.GENERATE_AUDIO_WAVEFORM;
  // The schema has no assetId column on Job by design. Read raw input only
  // server-side, validate its strict safe shape, then project no input fields.
  const candidates = await db.job.findMany({
    where: { datasetId, type },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      status: true, stage: true, progress: true, totalItems: true, processedItems: true,
      successItems: true, failedItems: true, skippedItems: true, errorCode: true, input: true,
    },
  });
  const job = candidates.find((candidate) => mediaProcessingJobInputSchema.safeParse(candidate.input).data?.assetId === asset.id);
  const base: Omit<SafeMediaReadiness, "assetId" | "modality" | "video" | "audio"> = {
    state: job?.status ?? "NOT_REQUESTED",
    stage: job ? toSafeJobStage(job.stage) : null,
    progress: job?.progress ?? null,
    counters: {
      total: job?.totalItems ?? null,
      processed: job?.processedItems ?? null,
      succeeded: job?.successItems ?? null,
      failed: job?.failedItems ?? null,
      skipped: job?.skippedItems ?? null,
    },
    outcome: toSafeOutcome(job?.errorCode ?? null),
  };

  if (asset.modality === Modality.VIDEO) {
    return {
      assetId: asset.id, modality: "VIDEO", ...base,
      video: { durationMs: asset.durationMs, fps: asset.videoAsset?.fps ?? null, totalFrames: asset.videoAsset?.totalFrames ?? null, codec: asset.videoAsset?.codec ?? null },
    };
  }
  return {
    assetId: asset.id, modality: "AUDIO", ...base,
    audio: {
      durationMs: asset.durationMs,
      sampleRate: asset.audioAsset?.sampleRate ?? null,
      channels: asset.audioAsset?.channels ?? null,
      codec: asset.audioAsset?.codec ?? null,
      bitRate: asset.audioAsset?.bitRate ?? null,
      waveformReady: Boolean(asset.audioAsset?.waveformKey),
    },
  };
}
