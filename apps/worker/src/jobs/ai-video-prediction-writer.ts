import { z } from "zod";
import type { AiTask, PrismaClient, Prisma } from "../../../../lib/generated/prisma/client.js";
import { normalizedVideoPredictionSchema } from "../providers/ai/aioz-video-normalization.js";
import { releaseLock } from "../queue/job-lock.js";

const LABEL_PALETTE = ["#38bdf8", "#f97316", "#22c55e", "#e11d48", "#a855f7", "#eab308", "#14b8a6", "#ec4899"];
/** Deterministic color so a class keeps one color across tasks. */
function labelColor(normalizedName: string) {
  let hash = 0;
  for (const char of normalizedName) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return LABEL_PALETTE[hash % LABEL_PALETTE.length];
}

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
    // Provider classes become Dataset labels: reuse an existing label by
    // normalized name, otherwise create it so tracks are never left unlabeled.
    // "unknown" stays unlabeled. Names are unique per Dataset across modalities.
    const classNames = new Map<string, string>();
    for (const p of predictions) {
      const key = p.labelKey.trim().toLocaleLowerCase("en-US");
      if (key !== "unknown" && !classNames.has(key)) classNames.set(key, p.labelKey.trim());
    }
    const existing = await tx.label.findMany({ where: { datasetId: task.datasetId, normalizedName: { in: [...classNames.keys()] } }, select: { id: true, normalizedName: true, modality: true } });
    const labelsByName = new Map(existing.filter((label) => label.modality === null || label.modality === "VIDEO").map((label) => [label.normalizedName, label.id]));
    const taken = new Set(existing.map((label) => label.normalizedName));
    for (const [normalizedName, name] of classNames) {
      if (taken.has(normalizedName)) continue;
      const created = await tx.label.create({ data: { datasetId: task.datasetId, modality: "VIDEO", name, normalizedName, color: labelColor(normalizedName) }, select: { id: true } });
      labelsByName.set(normalizedName, created.id);
    }
    let tracksCreated = 0;
    let keyframesCreated = 0;
    for (const [assetId, observations] of grouped) {
      const assetClaim = await tx.asset.updateMany({
        where: { id: assetId, datasetId: task.datasetId, modality: "VIDEO", deletedAt: null, archivedAt: null, status: { notIn: ["NEEDS_REVIEW", "REVIEWED", "REJECTED"] } },
        data: { revision: { increment: 1 } },
      });
      if (assetClaim.count !== 1) continue;
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
      const tracks = new Map<number, typeof observations>();
      for (const observation of observations) {
        const items = tracks.get(observation.video.trackId) ?? [];
        items.push(observation);
        tracks.set(observation.video.trackId, items);
      }
      for (const [providerTrackId, items] of tracks) {
        const first = items[0];
        const timestamps = new Set(items.map((p) => p.video.timestampMs));
        if (timestamps.size !== items.length || items.some((p) => p.video.classId !== first.video.classId || p.video.fps !== first.video.fps)) throw new Error("AI_VIDEO_RESULT_INVALID");
        const labelName = first.labelKey.trim().toLocaleLowerCase("en-US");
        const labelId = labelName === "unknown" ? null : labelsByName.get(labelName) ?? null;
        const provenance = { aiTaskId: task.id, modelKey: task.modelKeySnapshot, providerTrackId, objectId: String(providerTrackId), predictedClass: first.labelKey, providerClassId: first.video.classId };
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
      }
    }
    await tx.aiTask.update({ where: { id: task.id }, data: { status: "SUCCEEDED", output: { tracksCreated, keyframesCreated } } });
  }, { timeout: 30_000 });
  await releaseLock(db, jobId, lockToken, workerId);
}
