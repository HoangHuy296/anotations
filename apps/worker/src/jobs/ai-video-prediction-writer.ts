import { z } from "zod";
import type { AiTask, PrismaClient, Prisma } from "../../../../lib/generated/prisma/client.js";
import { normalizedVideoPredictionSchema } from "../providers/ai/aioz-video-normalization.js";
import { releaseLock } from "../queue/job-lock.js";

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
    const labels = await tx.label.findMany({ where: { datasetId: task.datasetId, OR: [{ modality: null }, { modality: "VIDEO" }] }, select: { id: true, normalizedName: true } });
    const labelsByName = new Map(labels.map((label) => [label.normalizedName, label.id]));
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
