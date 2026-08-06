import "server-only";

import { AnnotationSource, AnnotationStatus, AnnotationType, Modality, Prisma } from "@internal/db";
import type { RequestActor } from "@/lib/auth";
import { assertAnnotationPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { resolveVideoTrackAccess } from "@/lib/annotations/video-authorization";
import { toSafeVideoKeyframe, toSafeVideoTrack } from "@/lib/annotations/video-projection";
import { videoKeyframeCreateSchema, videoKeyframeUpdateSchema } from "@/lib/validation/video-annotation";

export type VideoKeyframeFailure = "NOT_FOUND" | "FORBIDDEN" | "INVALID_REQUEST" | "CONFLICT" | "DUPLICATE_TIMESTAMP";
export type VideoKeyframeResult<T> = { ok: true; value: T } | { ok: false; reason: VideoKeyframeFailure };

const keyframeSelect = { id: true, assetId: true, trackId: true, labelId: true, type: true, geometry: true, timestampMs: true, revision: true, createdAt: true, updatedAt: true } satisfies Prisma.AnnotationSelect;
const trackSelect: Prisma.VideoObjectTrackSelect = { id: true, videoAssetId: true, labelId: true, name: true, properties: true, status: true, revision: true, annotationType: true, interpolationMode: true, createdAt: true, updatedAt: true, label: { select: { id: true, name: true, color: true } } };

async function track(actor: RequestActor, trackId: string) {
  const access = await resolveVideoTrackAccess(actor, trackId, "dataset.read");
  if (!access) return null;
  const full = await db.videoObjectTrack.findUnique({ where: { id: trackId }, select: { ...trackSelect, videoAsset: { select: { assetId: true, asset: { select: { datasetId: true, durationMs: true } } } } } });
  return full ? { ...access, full } : null;
}

export async function createVideoKeyframe(actor: RequestActor, trackId: string, input: unknown): Promise<VideoKeyframeResult<{ keyframe: ReturnType<typeof toSafeVideoKeyframe>; track: ReturnType<typeof toSafeVideoTrack> }>> {
  const parsed = videoKeyframeCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_REQUEST" };
  const resolved = await track(actor, trackId);
  if (!resolved) return { ok: false, reason: "NOT_FOUND" };
  if (resolved.access.forbidden) return { ok: false, reason: "FORBIDDEN" };
  const permission = await assertAnnotationPermission(actor, resolved.datasetId, "annotation.create");
  if (!permission || permission.forbidden) return { ok: false, reason: permission ? "FORBIDDEN" : "NOT_FOUND" };
  if (resolved.full.videoAsset.asset.durationMs !== null && parsed.data.timestampMs > resolved.full.videoAsset.asset.durationMs) return { ok: false, reason: "INVALID_REQUEST" };
  try {
    const value = await db.$transaction(async (tx) => {
      const claimed = await tx.videoObjectTrack.updateMany({ where: { id: trackId, revision: parsed.data.expectedTrackRevision }, data: { revision: { increment: 1 } } });
      if (claimed.count !== 1) throw new Error("CONFLICT");
      const keyframe = await tx.annotation.create({ data: { datasetId: resolved.datasetId, assetId: resolved.full.videoAsset.assetId, trackId, labelId: resolved.full.labelId, createdById: actor.id, modality: Modality.VIDEO, type: AnnotationType.BOUNDING_BOX, source: AnnotationSource.MANUAL, geometry: parsed.data.geometry, properties: parsed.data.properties as Prisma.InputJsonValue, status: AnnotationStatus.DRAFT, isKeyframe: true, isInterpolated: false, timestampMs: parsed.data.timestampMs }, select: keyframeSelect });
      const updatedTrack = await tx.videoObjectTrack.findUniqueOrThrow({ where: { id: trackId }, select: trackSelect });
      return { keyframe, updatedTrack };
    });
    return { ok: true, value: { keyframe: toSafeVideoKeyframe({ ...value.keyframe, type: "BOUNDING_BOX", geometry: { kind: "BOUNDING_BOX", ...(value.keyframe.geometry as object) } as ReturnType<typeof toSafeVideoKeyframe>["geometry"], timestampMs: value.keyframe.timestampMs as number, trackId }), track: toSafeVideoTrack(value.updatedTrack) } };
  } catch (error) {
    if (error instanceof Error && error.message === "CONFLICT") return { ok: false, reason: "CONFLICT" };
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { ok: false, reason: "DUPLICATE_TIMESTAMP" };
    throw error;
  }
}

export async function updateVideoKeyframe(actor: RequestActor, annotationId: string, input: unknown): Promise<VideoKeyframeResult<{ keyframe: ReturnType<typeof toSafeVideoKeyframe>; track: ReturnType<typeof toSafeVideoTrack> }>> {
  const parsed = videoKeyframeUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_REQUEST" };
  const annotation = await db.annotation.findFirst({ where: { id: annotationId, modality: Modality.VIDEO, type: AnnotationType.BOUNDING_BOX, trackId: { not: null }, isKeyframe: true, isInterpolated: false, timestampMs: { not: null } }, select: { id: true, trackId: true, assetId: true, datasetId: true, labelId: true, type: true, geometry: true, timestampMs: true, revision: true, createdAt: true, updatedAt: true } });
  if (!annotation?.trackId) return { ok: false, reason: "NOT_FOUND" };
  const trackId = annotation.trackId;
  const resolved = await track(actor, trackId);
  if (!resolved || resolved.full.videoAsset.assetId !== annotation.assetId) return { ok: false, reason: "NOT_FOUND" };
  if (resolved.access.forbidden) return { ok: false, reason: "FORBIDDEN" };
  const permission = await assertAnnotationPermission(actor, resolved.datasetId, "annotation.updateAny");
  if (!permission || permission.forbidden) return { ok: false, reason: permission ? "FORBIDDEN" : "NOT_FOUND" };
  const nextTimestamp = parsed.data.timestampMs ?? annotation.timestampMs;
  if (nextTimestamp === null || (resolved.full.videoAsset.asset.durationMs !== null && nextTimestamp > resolved.full.videoAsset.asset.durationMs)) return { ok: false, reason: "INVALID_REQUEST" };
  try {
    const value = await db.$transaction(async (tx) => {
      const claimed = await tx.videoObjectTrack.updateMany({ where: { id: trackId, revision: parsed.data.expectedTrackRevision }, data: { revision: { increment: 1 } } });
      if (claimed.count !== 1) throw new Error("CONFLICT");
      const updated = await tx.annotation.update({ where: { id: annotationId }, data: { timestampMs: nextTimestamp, ...(parsed.data.geometry ? { geometry: parsed.data.geometry } : {}), ...(parsed.data.properties ? { properties: parsed.data.properties as Prisma.InputJsonValue } : {}), updatedById: actor.id }, select: keyframeSelect });
      const updatedTrack = await tx.videoObjectTrack.findUniqueOrThrow({ where: { id: trackId }, select: trackSelect });
      return { keyframe: updated, updatedTrack };
    });
    return { ok: true, value: { keyframe: toSafeVideoKeyframe({ ...value.keyframe, type: "BOUNDING_BOX", geometry: { kind: "BOUNDING_BOX", ...(value.keyframe.geometry as object) } as ReturnType<typeof toSafeVideoKeyframe>["geometry"], timestampMs: value.keyframe.timestampMs as number, trackId }), track: toSafeVideoTrack(value.updatedTrack) } };
  } catch (error) {
    if (error instanceof Error && error.message === "CONFLICT") return { ok: false, reason: "CONFLICT" };
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { ok: false, reason: "DUPLICATE_TIMESTAMP" };
    throw error;
  }
}

export async function deleteVideoKeyframe(actor: RequestActor, annotationId: string, expectedTrackRevision: number): Promise<VideoKeyframeResult<{ track: ReturnType<typeof toSafeVideoTrack> }>> {
  const annotation = await db.annotation.findFirst({ where: { id: annotationId, modality: Modality.VIDEO, type: AnnotationType.BOUNDING_BOX, trackId: { not: null }, isKeyframe: true, isInterpolated: false, timestampMs: { not: null } }, select: { id: true, trackId: true, assetId: true } });
  if (!annotation?.trackId) return { ok: false, reason: "NOT_FOUND" };
  const trackId = annotation.trackId;
  const resolved = await track(actor, trackId);
  if (!resolved || resolved.full.videoAsset.assetId !== annotation.assetId) return { ok: false, reason: "NOT_FOUND" };
  if (resolved.access.forbidden) return { ok: false, reason: "FORBIDDEN" };
  const permission = await assertAnnotationPermission(actor, resolved.datasetId, "annotation.updateAny");
  if (!permission || permission.forbidden) return { ok: false, reason: permission ? "FORBIDDEN" : "NOT_FOUND" };
  const value = await db.$transaction(async (tx) => {
    const claimed = await tx.videoObjectTrack.updateMany({ where: { id: trackId, revision: expectedTrackRevision }, data: { revision: { increment: 1 } } });
    if (claimed.count !== 1) return null;
    await tx.annotation.delete({ where: { id: annotationId } });
    return tx.videoObjectTrack.findUniqueOrThrow({ where: { id: trackId }, select: trackSelect });
  });
  return value ? { ok: true, value: { track: toSafeVideoTrack(value) } } : { ok: false, reason: "CONFLICT" };
}
