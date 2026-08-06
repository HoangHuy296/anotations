import "server-only";

import { AnnotationType, Modality } from "@internal/db";
import type { RequestActor } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveVideoAssetAccess } from "@/lib/annotations/video-authorization";
import { deriveInterpolationAt } from "@/lib/annotations/video-interpolation";
import { VIDEO_ANNOTATION_LIMITS } from "@/lib/annotations/video-limits";
import { toSafeVideoKeyframe, toSafeVideoTemporalLabel, toSafeVideoTrack } from "@/lib/annotations/video-projection";
import type { SafeVideoAnnotations } from "@/types/video-annotation";
import { videoReadQuerySchema } from "@/lib/validation/video-annotation";

function box(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (["x", "y", "width", "height"].every((key) => typeof candidate[key] === "number")) {
    return { kind: "BOUNDING_BOX" as const, x: candidate.x as number, y: candidate.y as number, width: candidate.width as number, height: candidate.height as number };
  }
  return null;
}

export async function readVideoAnnotations(actor: RequestActor, assetId: string, query: unknown = {}): Promise<SafeVideoAnnotations | null> {
  const parsed = videoReadQuerySchema.safeParse(query);
  if (!parsed.success) return null;
  const access = await resolveVideoAssetAccess(actor, assetId);
  if (!access) return null;
  const { asset } = access;
  const [tracks, annotations] = await Promise.all([
    db.videoObjectTrack.findMany({
      where: { videoAssetId: asset.videoAsset?.id ?? "" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: VIDEO_ANNOTATION_LIMITS.tracksPerRead,
      select: { id: true, videoAssetId: true, labelId: true, name: true, color: true, properties: true, status: true, revision: true, annotationType: true, interpolationMode: true, createdAt: true, updatedAt: true, label: { select: { id: true, name: true, color: true } } },
    }),
    db.annotation.findMany({
      // Keep the bounded persisted keyframe set available for interpolation.
      // Filtering before derivation would discard the bracketing keyframe just
      // outside a requested window and make an otherwise valid local preview
      // disappear. The returned DTO is filtered below.
      where: { assetId, datasetId: asset.datasetId, modality: Modality.VIDEO },
      orderBy: [{ timestampMs: "asc" }, { startMs: "asc" }, { createdAt: "asc" }],
      take: VIDEO_ANNOTATION_LIMITS.keyframesPerTrackRead + VIDEO_ANNOTATION_LIMITS.temporalLabelsPerRead,
      select: { id: true, assetId: true, labelId: true, type: true, geometry: true, properties: true, revision: true, timestampMs: true, trackId: true, isKeyframe: true, isInterpolated: true, startMs: true, endMs: true, createdAt: true, updatedAt: true },
    }),
  ]);
  const safeTracks = tracks.map((track) => toSafeVideoTrack(track));
  const safeKeyframes = annotations.flatMap((annotation) => {
    const geometry = box(annotation.geometry);
    return annotation.trackId && annotation.isKeyframe && !annotation.isInterpolated && annotation.timestampMs !== null && annotation.type === AnnotationType.BOUNDING_BOX && geometry
      ? [toSafeVideoKeyframe({ ...annotation, trackId: annotation.trackId, type: "BOUNDING_BOX", geometry, timestampMs: annotation.timestampMs })]
      : [];
  });
  const safeTemporalLabels = annotations.flatMap((annotation) => annotation.trackId === null && !annotation.isKeyframe && !annotation.isInterpolated && annotation.startMs !== null && annotation.endMs !== null && (annotation.type === AnnotationType.EVENT || annotation.type === AnnotationType.SCENE || annotation.type === AnnotationType.SHOT_BOUNDARY)
    ? [toSafeVideoTemporalLabel({ ...annotation, type: annotation.type, startMs: annotation.startMs, endMs: annotation.endMs })]
    : []);
  const interpolation = parsed.data.fromMs !== undefined && parsed.data.toMs !== undefined
    ? safeTracks.flatMap((track) => {
      const keyframes = safeKeyframes.filter((keyframe) => keyframe.trackId === track.id).map((keyframe) => ({ trackId: keyframe.trackId, timestampMs: keyframe.timestampMs, geometry: keyframe.geometry }));
      const value = deriveInterpolationAt(keyframes, parsed.data.fromMs as number, track.interpolationMode);
      return value ? [value] : [];
    })
    : [];
  const inWindow = (timestampMs: number) => (parsed.data.fromMs === undefined || timestampMs >= parsed.data.fromMs) && (parsed.data.toMs === undefined || timestampMs <= parsed.data.toMs);
  const intersectsWindow = (startMs: number, endMs: number) => (parsed.data.toMs === undefined || startMs <= parsed.data.toMs) && (parsed.data.fromMs === undefined || endMs >= parsed.data.fromMs);
  return {
    assetId,
    durationMs: asset.durationMs ?? null,
    fps: asset.videoAsset?.fps ?? null,
    tracks: safeTracks,
    keyframes: safeKeyframes.filter((keyframe) => inWindow(keyframe.timestampMs)),
    temporalLabels: safeTemporalLabels.filter((label) => intersectsWindow(label.startMs, label.endMs)),
    interpolation,
  };
}
