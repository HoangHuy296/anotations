import { z } from "zod";
import type { AiTask, PrismaClient, Prisma } from "../../../../lib/generated/prisma/client.js";
import { normalizedVideoPredictionSchema } from "../providers/ai/aioz-video-normalization.js";
import { canonicalAiLabelKey, matchAiClassLabels } from "@annotationplatform/domain/ai-label-resolution";
import { releaseLock } from "../queue/job-lock.js";
import { resolveAiBatchInput } from "./ai-batch-state.js";
import type { AiPerAssetOutcome } from "@annotationplatform/domain/ai-batch";
import { aiResultFingerprint } from "./ai-result-fingerprint.js";

/** Append video tracks and their observed keyframes atomically with Job completion. */
export async function handleVideoAiTaskCompleted(
  db: PrismaClient, jobId: string,
  task: Pick<AiTask, "id" | "datasetId" | "createdById" | "modality" | "type" | "modelKeySnapshot" | "input">,
  raw: unknown, lockToken: string, workerId: string,
): Promise<void> {
  const predictions = z.array(normalizedVideoPredictionSchema).parse(raw);
  const scope = new Set(z.object({ assetIds: z.array(z.string()) }).parse(task.input).assetIds);
  if (task.modality !== "VIDEO" || !["TRACKING", "DETECT_OBJECTS"].includes(task.type) || predictions.some((p) => !scope.has(p.assetId))) throw new Error("AI_VIDEO_RESULT_INVALID");
  const grouped = new Map<string, typeof predictions>();
  for (const prediction of predictions) {
    const items = grouped.get(prediction.assetId) ?? [];
    items.push(prediction);
    grouped.set(prediction.assetId, items);
  }
  await db.$transaction(async (tx) => {
    const claimed = await tx.job.updateMany({
      where: { id: jobId, status: "RUNNING", cancelRequestedAt: null, lockToken, lockedBy: workerId },
      data: { status: "COMPLETED", stage: "FINISHED", finishedAt: new Date() },
    });
    if (claimed.count !== 1) return;
    // A Label row is never created for a predicted class. A track links to an existing compatible Dataset label only when one matches by the canonical key;
    // otherwise labelId stays null and `properties.predictedClass` (the exact class the AI Service returned) is what the workspace displays. A malformed class
    // throws and rolls the whole result back; an incompatible same-key label is reported, never reused or modified.
    const match = await matchAiClassLabels(tx, task.datasetId, "VIDEO", predictions.map((p) => p.labelKey));
    let tracksCreated = 0;
    let tracksSkippedAsDuplicate = 0;
    let keyframesCreated = 0;
    // Per-Asset accounting. Every prediction carries the assetId the provider echoed for its own file (matched by URL digest), so this is never positional.
    const perAssetKeyframes = new Map<string, number>();
    const notEditable = new Set<string>();
    for (const [assetId, observations] of grouped) {
      const assetClaim = await tx.asset.updateMany({
        where: { id: assetId, datasetId: task.datasetId, modality: "VIDEO", deletedAt: null, archivedAt: null, status: { notIn: ["NEEDS_REVIEW", "REVIEWED", "REJECTED"] } },
        data: { revision: { increment: 1 } },
      });
      if (assetClaim.count !== 1) { notEditable.add(assetId); continue; }
      const video = await tx.videoAsset.upsert({
        where: { assetId }, update: {},
        create: { assetId, fps: observations[0].video.fps, totalFrames: observations[0].video.totalFrames }, select: { id: true },
      });
      // A pre-existing VideoAsset row (created by the normal import/probe
      // pipeline before this AI task ran) can still be missing fps/totalFrames
      // if that pipeline step never completed for it. The AI provider's own
      // report is an authoritative source for both, so backfill only the
      // still-null columns -- never overwrite a value ffprobe already set.
      await tx.videoAsset.updateMany({
        where: { assetId, OR: [{ fps: null }, { totalFrames: null }] },
        data: { fps: observations[0].video.fps, totalFrames: observations[0].video.totalFrames },
      });
      const durationMs = Math.round((observations[0].video.totalFrames / observations[0].video.fps) * 1000);
      if (Number.isFinite(durationMs) && durationMs > 0) {
        await tx.asset.updateMany({ where: { id: assetId, durationMs: null }, data: { durationMs } });
      }
      // Identical results already persisted for this asset (any earlier task, whatever a human did to them since) are skipped, not duplicated.
      const knownFingerprints = new Set(
        (await tx.videoObjectTrack.findMany({ where: { videoAssetId: video.id }, select: { properties: true } }))
          .map((row) => (row.properties as { resultFingerprint?: unknown } | null)?.resultFingerprint).filter((value): value is string => typeof value === "string"),
      );
      const tracks = new Map<number, typeof observations>();
      for (const observation of observations) {
        const items = tracks.get(observation.video.trackId) ?? [];
        items.push(observation);
        tracks.set(observation.video.trackId, items);
      }
      for (const [providerTrackId, items] of tracks) {
        const first = items[0];
        const timestamps = new Set(items.map((p) => p.video.timestampMs));
        if (timestamps.size !== items.length || items.some((p) => p.video.classId !== first.video.classId || p.video.fps !== first.video.fps || canonicalAiLabelKey(p.labelKey)?.key !== canonicalAiLabelKey(first.labelKey)?.key)) throw new Error("AI_VIDEO_RESULT_INVALID");
        const canonical = canonicalAiLabelKey(first.labelKey);
        const labelId = canonical ? match.labelIds.get(canonical.key) ?? null : null;
        const resultFingerprint = aiResultFingerprint({
          modelKey: task.modelKeySnapshot, assetId, classKey: canonical ? canonical.key : "unknown", providerTrackId,
          frames: items.map((p) => ({ frameIndex: p.video.frameIndex, box: p.boundingBoxes as never })),
        });
        if (knownFingerprints.has(resultFingerprint)) { tracksSkippedAsDuplicate++; continue; }
        knownFingerprints.add(resultFingerprint);
        const provenance = { resultFingerprint, aiTaskId: task.id, modelKey: task.modelKeySnapshot, providerTrackId, objectId: String(providerTrackId), predictedClass: first.labelKey, providerClassId: first.video.classId };
        const track = await tx.videoObjectTrack.create({ data: {
          videoAssetId: video.id, createdById: task.createdById, labelId,
          name: `AI track ${providerTrackId}`, status: "DRAFT", annotationType: "BOUNDING_BOX",
          // Empty provider frames must stay empty; humans may opt into interpolation.
          interpolationMode: "NONE", properties: provenance,
        }, select: { id: true } });
        const rows: Prisma.AnnotationCreateManyInput[] = items.map((p) => ({
          datasetId: task.datasetId, assetId, createdById: task.createdById, labelId, trackId: track.id,
          modality: "VIDEO", type: "BOUNDING_BOX", source: "AI", status: "DRAFT", revision: 1,
          isKeyframe: true, isInterpolated: false, frameIndex: p.video.frameIndex, timestampMs: p.video.timestampMs,
          geometry: p.boundingBoxes,
          properties: { ...provenance, predictedClass: p.labelKey, confidence: p.confidence, providerFps: p.video.fps },
        }));
        for (let offset = 0; offset < rows.length; offset += 500) await tx.annotation.createMany({ data: rows.slice(offset, offset + 500) });
        tracksCreated++;
        keyframesCreated += rows.length;
        perAssetKeyframes.set(assetId, (perAssetKeyframes.get(assetId) ?? 0) + rows.length);
      }
    }
    // A versioned operation reports one outcome per accepted target (an Asset with no detections is an explicit zero-count success); historical tasks keep their summary only.
    const batch = resolveAiBatchInput((await tx.job.findUniqueOrThrow({ where: { id: jobId }, select: { input: true } })).input);
    const perAsset: AiPerAssetOutcome[] | null = batch.kind === "v1"
      ? batch.input.targets.map((target) => notEditable.has(target.assetId)
        ? { assetId: target.assetId, inputIndex: target.inputIndex, outcome: "SKIPPED" as const, predictionCount: 0, reason: "ASSET_NOT_EDITABLE" }
        : { assetId: target.assetId, inputIndex: target.inputIndex, outcome: "SUCCEEDED" as const, predictionCount: perAssetKeyframes.get(target.assetId) ?? 0 })
      : null;
    await tx.aiTask.update({ where: { id: task.id }, data: { status: "SUCCEEDED", output: { tracksCreated, keyframesCreated, labelConflicts: match.conflicts, tracksSkippedAsDuplicate, ...(perAsset ? { perAsset } : {}) } } });
  }, { timeout: 120_000, maxWait: 10_000 });
  await releaseLock(db, jobId, lockToken, workerId);
}
