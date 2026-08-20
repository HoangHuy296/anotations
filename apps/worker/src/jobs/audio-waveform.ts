import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { mediaProcessingJobInputSchema } from "@annotationplatform/domain/media-processing";
import { defaultMediaProcessingPolicy, assertMediaSourceWithinPolicy } from "../media/policy.js";
import { materializePrivateSource } from "../media/source-materialization.js";
import { withJobTempWorkspace } from "../media/temp-workspace.js";
import { runBoundedMediaProcess } from "../media/subprocess.js";
import { buildWaveformArtifactFromPcm, parseFfprobeAudioMetadata } from "../media/waveform.js";
import { createWorkerMinio } from "../providers/minio.js";
import { safeCleanupAudioDerivative } from "../media/audio-derivative.js";
import { cancelJob, completeJob, failJob, heartbeatJob, updateJobProgress } from "./job-claim-lock.js";

export type AudioWaveformProcessResult = "completed" | "canceled" | "failed" | "refused";

async function canceled(db: PrismaClient, jobId: string, lockToken: string) {
  const job = await db.job.findFirst({ where: { id: jobId, lockToken, status: { in: ["RUNNING", "CANCELING"] } }, select: { cancelRequestedAt: true, status: true } });
  return Boolean(job?.cancelRequestedAt || job?.status === "CANCELING");
}

export async function processAudioWaveform(db: PrismaClient, jobId: string, lockToken: string): Promise<AudioWaveformProcessResult> {
  const job = await db.job.findFirst({ where: { id: jobId, type: "GENERATE_AUDIO_WAVEFORM", lockToken, status: { in: ["RUNNING", "CANCELING"] } }, select: { id: true, datasetId: true, input: true } });
  if (!job) return "refused";
  const input = mediaProcessingJobInputSchema.safeParse(job.input);
  if (!input.success) { await failJob(db, { jobId, lockToken }); return "failed"; }
  const asset = await db.asset.findFirst({ where: { id: input.data.assetId, datasetId: job.datasetId, modality: "AUDIO", deletedAt: null, archivedAt: null }, select: { id: true, sizeBytes: true, checksum: true, sourceFingerprint: true, sourceRevision: true, storageBucket: true, storageKey: true } });
  if (!asset?.storageBucket || !asset.storageKey || asset.sourceFingerprint !== input.data.source.sourceFingerprint || asset.checksum !== input.data.source.checksum || asset.sourceRevision !== input.data.source.sourceRevision || !assertMediaSourceWithinPolicy({ sizeBytes: asset.sizeBytes }).ok) { await failJob(db, { jobId, lockToken }); return "failed"; }
  if ((await updateJobProgress(db, { jobId, lockToken, stage: "VALIDATING_INPUT", progress: 1, totalItems: 1, processedItems: 0, successItems: 0, failedItems: 0, skippedItems: 0 })).kind !== "updated") return "refused";
  let uploadedBucket: string | undefined;
  let uploadedObjectKey: string | undefined;
  try {
    return await withJobTempWorkspace(job.id, async (workspace) => {
      const minio = createWorkerMinio((await import("../config.js")).getWorkerConfig());
      if (await canceled(db, job.id, lockToken)) return "canceled";
      const source = await materializePrivateSource({ minio, bucket: asset.storageBucket!, objectKey: asset.storageKey!, destinationPath: `${workspace.path}/source`, expectedSizeBytes: asset.sizeBytes, maxSourceBytes: defaultMediaProcessingPolicy.maxSourceBytes });
      if (source.kind !== "materialized") { await failJob(db, { jobId, lockToken }); return "failed"; }
      await heartbeatJob(db, { jobId, lockToken });
      const probe = await runBoundedMediaProcess({ command: "ffprobe", args: ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,sample_rate,channels,bit_rate", "-of", "json", source.path], cwd: workspace.path, timeoutMs: defaultMediaProcessingPolicy.maxProcessMs, maxOutputBytes: defaultMediaProcessingPolicy.maxProcessOutputBytes, isCancellationRequested: () => canceled(db, job.id, lockToken) });
      if (probe.kind === "canceled") { await cancelJob(db, { jobId, lockToken }); return "canceled"; }
      const metadata = probe.kind === "completed" ? parseFfprobeAudioMetadata(probe.stdout) : null;
      if (!metadata) { await db.job.updateMany({ where: { id: jobId, lockToken }, data: { errorCode: "MEDIA_WAVEFORM_FAILED" } }); await failJob(db, { jobId, lockToken }); return "failed"; }
      // Decode once through the bounded ffmpeg runner before publishing the
      // derivative. This validates the source is actually decodable without
      // persisting raw PCM or unbounded command output.
      const decode = await runBoundedMediaProcess({ command: "ffmpeg", args: ["-v", "error", "-i", source.path, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], cwd: workspace.path, timeoutMs: defaultMediaProcessingPolicy.maxProcessMs, maxOutputBytes: Math.min(32 * 1024 * 1024, defaultMediaProcessingPolicy.maxWaveformPeaks * 2), isCancellationRequested: () => canceled(db, job.id, lockToken) });
      if (decode.kind === "canceled") { await cancelJob(db, { jobId, lockToken }); return "canceled"; }
      if (decode.kind !== "completed") { await db.job.updateMany({ where: { id: jobId, lockToken }, data: { errorCode: "MEDIA_WAVEFORM_FAILED" } }); await failJob(db, { jobId, lockToken }); return "failed"; }
      const artifact = buildWaveformArtifactFromPcm({ pcm: decode.stdout, sampleRate: 8_000, maxPeaks: defaultMediaProcessingPolicy.maxWaveformPeaks });
      if (!artifact) { await db.job.updateMany({ where: { id: jobId, lockToken }, data: { errorCode: "MEDIA_WAVEFORM_FAILED" } }); await failJob(db, { jobId, lockToken }); return "failed"; }
      const config = (await import("../config.js")).getWorkerConfig();
      const waveformKey = `audio-waveforms/${job.datasetId}/${asset.id}/${input.data.source.sourceFingerprint}.fieldframe-audio-waveform.v1.json`;
      await minio.putObject(config.MINIO_BUCKET, waveformKey, artifact, artifact.length, { "Content-Type": "application/json" });
      uploadedBucket = config.MINIO_BUCKET;
      uploadedObjectKey = waveformKey;
      if (await canceled(db, job.id, lockToken)) {
        await safeCleanupAudioDerivative(db, { bucket: config.MINIO_BUCKET, objectKey: waveformKey, assetId: asset.id });
        await cancelJob(db, { jobId, lockToken });
        return "canceled";
      }
      const reconciled = await db.$transaction(async (tx) => {
        const live = await tx.job.findFirst({ where: { id: jobId, lockToken, status: "RUNNING", lockedUntil: { gt: new Date() } }, select: { id: true } });
        if (!live) return false;
        await tx.asset.update({ where: { id: asset.id }, data: { durationMs: metadata.durationMs } });
        await tx.audioAsset.upsert({ where: { assetId: asset.id }, create: { assetId: asset.id, sampleRate: metadata.sampleRate, channels: metadata.channels, codec: metadata.codec, bitRate: metadata.bitRate, waveformKey, metadata: { processorVersion: input.data.processorVersion } }, update: { sampleRate: metadata.sampleRate, channels: metadata.channels, codec: metadata.codec, bitRate: metadata.bitRate, waveformKey, metadata: { processorVersion: input.data.processorVersion } } });
        return true;
      });
      if (!reconciled) { await safeCleanupAudioDerivative(db, { bucket: config.MINIO_BUCKET, objectKey: waveformKey, assetId: asset.id }); await failJob(db, { jobId, lockToken }); return "failed"; }
      const done = await completeJob(db, { jobId, lockToken, stage: "FINISHED", progress: 100, totalItems: 1, processedItems: 1, successItems: 1, failedItems: 0, skippedItems: 0, summary: { message: "Audio waveform processing completed.", outcome: "completed", resultCount: 1 } });
      return done.kind === "updated" ? "completed" : "refused";
    });
  } catch {
    const cleanupBucket = uploadedBucket as string | undefined;
    const cleanupObjectKey = uploadedObjectKey as string | undefined;
    if (cleanupBucket && cleanupObjectKey) await safeCleanupAudioDerivative(db, { bucket: cleanupBucket, objectKey: cleanupObjectKey, assetId: asset.id });
    await db.job.updateMany({ where: { id: jobId, lockToken }, data: { errorCode: "MEDIA_WAVEFORM_FAILED" } });
    await failJob(db, { jobId, lockToken });
    return "failed";
  }
}
