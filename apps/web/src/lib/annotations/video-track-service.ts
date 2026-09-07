import "server-only";

import { AnnotationStatus, AnnotationType, Prisma } from "@internal/db";
import type { RequestActor } from "@/lib/auth";
import { assertAnnotationPermission } from "@/lib/authorization";
import { resolveVideoAssetAccess, requireSameDatasetLabel } from "@/lib/annotations/video-authorization";
import { toSafeVideoTrack } from "@/lib/annotations/video-projection";
import { videoTrackCreateSchema, videoTrackUpdateSchema } from "@/lib/validation/video-annotation";
import { AssetContentWriteConflict, isAssetContentWriteConflict, mutateEditableAssetContent } from "@/lib/workflow/asset-workflow-service";

export type VideoTrackFailure = "NOT_FOUND" | "FORBIDDEN" | "INVALID_REQUEST" | "CONFLICT";
export type VideoTrackResult<T> = { ok: true; value: T } | { ok: false; reason: VideoTrackFailure };

const trackSelect = {
  id: true, videoAssetId: true, labelId: true, name: true, properties: true, status: true,
  revision: true, annotationType: true, interpolationMode: true, createdAt: true, updatedAt: true,
  label: { select: { id: true, name: true, color: true } },
} satisfies Prisma.VideoObjectTrackSelect;

export async function createVideoObjectTrack(actor: RequestActor, assetId: string, input: unknown): Promise<VideoTrackResult<ReturnType<typeof toSafeVideoTrack>>> {
  const parsed = videoTrackCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_REQUEST" };
  const resolved = await resolveVideoAssetAccess(actor, assetId, "annotation.create");
  if (!resolved) return { ok: false, reason: "NOT_FOUND" };
  if (resolved.access.forbidden) return { ok: false, reason: "FORBIDDEN" };
  if (!(await requireSameDatasetLabel(parsed.data.labelId, resolved.asset.datasetId))) return { ok: false, reason: "INVALID_REQUEST" };
  try {
    const track = await mutateEditableAssetContent(resolved.asset.id, resolved.asset.datasetId, (tx) => tx.videoObjectTrack.create({ data: { videoAssetId: resolved.asset.videoAsset?.id as string, labelId: parsed.data.labelId ?? null, createdById: actor.id, name: parsed.data.name ?? null, properties: parsed.data.properties as Prisma.InputJsonValue, status: AnnotationStatus.DRAFT, annotationType: AnnotationType.BOUNDING_BOX, interpolationMode: parsed.data.interpolationMode }, select: trackSelect }));
    return { ok: true, value: toSafeVideoTrack(track) };
  } catch (error) {
    if (isAssetContentWriteConflict(error)) return { ok: false, reason: "CONFLICT" };
    throw error;
  }
}

export async function updateVideoObjectTrack(actor: RequestActor, trackId: string, input: unknown): Promise<VideoTrackResult<ReturnType<typeof toSafeVideoTrack>>> {
  const parsed = videoTrackUpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID_REQUEST" };
  const access = await import("@/lib/annotations/video-authorization").then(({ resolveVideoTrackAccess }) => resolveVideoTrackAccess(actor, trackId, "dataset.read"));
  if (!access) return { ok: false, reason: "NOT_FOUND" };
  if (access.access.forbidden) return { ok: false, reason: "FORBIDDEN" };
  if (!(await requireSameDatasetLabel(parsed.data.labelId, access.datasetId))) return { ok: false, reason: "INVALID_REQUEST" };
  const permission = await assertAnnotationPermission(actor, access.datasetId, "annotation.updateAny");
  if (!permission || permission.forbidden) return { ok: false, reason: permission ? "FORBIDDEN" : "NOT_FOUND" };
  const { expectedTrackRevision, ...changes } = parsed.data;
  try {
    const track = await mutateEditableAssetContent(access.assetId, access.datasetId, async (tx) => {
      const claimed = await tx.videoObjectTrack.updateMany({ where: { id: trackId, revision: expectedTrackRevision }, data: { revision: { increment: 1 } } });
      if (claimed.count !== 1) throw new AssetContentWriteConflict();
      return tx.videoObjectTrack.update({ where: { id: trackId }, data: { ...changes, properties: changes.properties as Prisma.InputJsonValue | undefined }, select: trackSelect });
    });
    return { ok: true, value: toSafeVideoTrack(track) };
  } catch (error) {
    if (isAssetContentWriteConflict(error)) return { ok: false, reason: "CONFLICT" };
    throw error;
  }
}

export async function deleteVideoObjectTrack(actor: RequestActor, trackId: string, expectedTrackRevision: number): Promise<VideoTrackResult<null>> {
  const access = await import("@/lib/annotations/video-authorization").then(({ resolveVideoTrackAccess }) => resolveVideoTrackAccess(actor, trackId, "dataset.read"));
  if (!access) return { ok: false, reason: "NOT_FOUND" };
  if (access.access.forbidden) return { ok: false, reason: "FORBIDDEN" };
  const permission = await assertAnnotationPermission(actor, access.datasetId, "annotation.updateAny");
  if (!permission || permission.forbidden) return { ok: false, reason: permission ? "FORBIDDEN" : "NOT_FOUND" };
  try {
    const result = await mutateEditableAssetContent(access.assetId, access.datasetId, async (tx) => {
    const claimed = await tx.videoObjectTrack.updateMany({ where: { id: trackId, revision: expectedTrackRevision }, data: { revision: { increment: 1 } } });
    if (claimed.count !== 1) throw new AssetContentWriteConflict();
    await tx.videoObjectTrack.delete({ where: { id: trackId } });
    return true;
    });
    return result ? { ok: true, value: null } : { ok: false, reason: "CONFLICT" };
  } catch (error) {
    if (isAssetContentWriteConflict(error)) return { ok: false, reason: "CONFLICT" };
    throw error;
  }
}
