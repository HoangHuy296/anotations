import "server-only";

import { AnnotationSource, AnnotationStatus, Modality, Prisma } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { assertAnnotationPermission, requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import type { AnnotationChangeSet } from "@/lib/validation/annotation-api";
import { isValidImageGeometryForType } from "@/lib/validation/annotation-api";
import { toSafeAnnotation, type SafeAnnotation } from "@/lib/annotations/safe-annotation";

export type AnnotationServiceFailure = "NOT_FOUND" | "FORBIDDEN" | "INVALID_REQUEST" | "CONFLICT" | "WRITE_UNSUPPORTED" | "CREATE_REPLAY_CONFLICT";
export type AnnotationServiceResult<T> = { ok: true; value: T } | { ok: false; reason: AnnotationServiceFailure };

// Defensive cap only -- not true pagination. `readAssetAnnotations` backs
// `image-engine.tsx`'s AI-detect-apply-results flow, which re-fetches every
// annotation on an asset and filters client-side for ones matching a given
// AI task id; truncating this into a real page/pageSize/total envelope
// would silently drop AI-detect results beyond the first page, a real
// correctness regression. The response shape (`{ annotations }`) is
// unchanged -- only an upper bound is added, at a magnitude far beyond any
// realistic single-asset annotation count (see VIDEO_ANNOTATION_LIMITS for
// the equivalent per-track/per-asset order of magnitude used elsewhere).
const ANNOTATIONS_PER_ASSET_READ_LIMIT = 5_000;

const annotationSelect = {
  id: true, assetId: true, labelId: true, modality: true, type: true, geometry: true,
  status: true, properties: true, revision: true, createdAt: true, updatedAt: true,
  label: { select: { id: true, name: true, color: true } },
} satisfies Prisma.AnnotationSelect;

class ServiceError extends Error {
  constructor(readonly reason: AnnotationServiceFailure) { super(reason); }
}

async function resolveAsset(actor: RequestActor, assetId: string) {
  const asset = await db.asset.findFirst({ where: { id: assetId, deletedAt: null, archivedAt: null }, select: { id: true, datasetId: true, modality: true } });
  if (!asset) return null;
  const access = await requireDatasetPermission(actor, asset.datasetId, "dataset.read");
  if (!access) return null;
  if (access.forbidden) return { asset, forbidden: true as const };
  return { asset, forbidden: false as const };
}

export async function readAssetAnnotations(actor: RequestActor, assetId: string): Promise<AnnotationServiceResult<SafeAnnotation[]>> {
  const resolved = await resolveAsset(actor, assetId);
  if (!resolved) return { ok: false, reason: "NOT_FOUND" };
  // An Asset outside the actor's Dataset scope is deliberately indistinguishable
  // from an unknown Asset at this resource boundary.
  if (resolved.forbidden) return { ok: false, reason: "NOT_FOUND" };
  const annotations = await db.annotation.findMany({
    where: { assetId: resolved.asset.id, datasetId: resolved.asset.datasetId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: annotationSelect,
    take: ANNOTATIONS_PER_ASSET_READ_LIMIT,
  });
  return { ok: true, value: annotations.map(toSafeAnnotation) };
}

async function verifyWritePermissions(actor: RequestActor, datasetId: string, updates: AnnotationChangeSet["updates"], deletes: AnnotationChangeSet["deletes"]) {
  for (const item of [...updates, ...deletes]) {
    const annotation = await db.annotation.findFirst({ where: { id: item.id, datasetId }, select: { createdById: true } });
    if (!annotation) throw new ServiceError("NOT_FOUND");
    const permission = annotation.createdById === actor.id ? "annotation.updateOwn" : "annotation.updateAny";
    const access = await assertAnnotationPermission(actor, datasetId, permission);
    if (!access) throw new ServiceError("NOT_FOUND");
    if (access.forbidden) throw new ServiceError("FORBIDDEN");
  }
}

export async function mutateImageAnnotations(actor: RequestActor, assetId: string, changeSet: AnnotationChangeSet): Promise<AnnotationServiceResult<SafeAnnotation[]>> {
  const resolved = await resolveAsset(actor, assetId);
  if (!resolved) return { ok: false, reason: "NOT_FOUND" };
  if (resolved.forbidden) return { ok: false, reason: "NOT_FOUND" };
  if (resolved.asset.modality !== Modality.IMAGE) return { ok: false, reason: "WRITE_UNSUPPORTED" };

  const createAccess = changeSet.creates.length ? await assertAnnotationPermission(actor, resolved.asset.datasetId, "annotation.create") : null;
  if (createAccess && !createAccess) return { ok: false, reason: "NOT_FOUND" };
  if (createAccess?.forbidden) return { ok: false, reason: "FORBIDDEN" };
  try {
    await verifyWritePermissions(actor, resolved.asset.datasetId, changeSet.updates, changeSet.deletes);
    const labelIds = [...changeSet.creates.flatMap((item) => item.labelId ? [item.labelId] : []), ...changeSet.updates.flatMap((item) => item.labelId ? [item.labelId] : [])];
    if (labelIds.length) {
      const labels = await db.label.findMany({ where: { id: { in: [...new Set(labelIds)] }, datasetId: resolved.asset.datasetId, OR: [{ modality: null }, { modality: Modality.IMAGE }] }, select: { id: true } });
      if (labels.length !== new Set(labelIds).size) return { ok: false, reason: "NOT_FOUND" };
    }

    const annotations = await db.$transaction(async (tx) => {
      for (const item of changeSet.creates) {
        const existing = await tx.annotation.findUnique({ where: { id: item.id }, select: { id: true, assetId: true, datasetId: true, createdById: true, type: true, geometry: true, labelId: true } });
        if (existing) {
          const isReplay = existing.assetId === resolved.asset.id && existing.datasetId === resolved.asset.datasetId && existing.createdById === actor.id && existing.type === item.type && existing.labelId === (item.labelId ?? null) && JSON.stringify(existing.geometry) === JSON.stringify(item.geometry);
          if (!isReplay) throw new ServiceError("CREATE_REPLAY_CONFLICT");
          continue;
        }
        await tx.annotation.create({ data: {
          id: item.id, datasetId: resolved.asset.datasetId, assetId: resolved.asset.id,
          labelId: item.labelId ?? null, createdById: actor.id, modality: Modality.IMAGE,
          type: item.type, source: AnnotationSource.MANUAL, geometry: item.geometry, properties: {}, status: AnnotationStatus.DRAFT,
        } });
      }
      for (const item of changeSet.updates) {
        const current = await tx.annotation.findFirst({ where: { id: item.id, datasetId: resolved.asset.datasetId, assetId: resolved.asset.id, modality: Modality.IMAGE }, select: { type: true } });
        if (!current) throw new ServiceError("NOT_FOUND");
        if (item.geometry && !isValidImageGeometryForType(current.type, item.geometry)) throw new ServiceError("INVALID_REQUEST");
        const data: Prisma.AnnotationUncheckedUpdateManyInput = { updatedById: actor.id, revision: { increment: 1 } };
        if (item.geometry !== undefined) data.geometry = item.geometry;
        if (item.labelId !== undefined) data.labelId = item.labelId;
        const changed = await tx.annotation.updateMany({ where: { id: item.id, datasetId: resolved.asset.datasetId, assetId: resolved.asset.id, revision: item.revision }, data });
        if (changed.count !== 1) throw new ServiceError("CONFLICT");
      }
      for (const item of changeSet.deletes) {
        const removed = await tx.annotation.deleteMany({ where: { id: item.id, datasetId: resolved.asset.datasetId, assetId: resolved.asset.id, revision: item.revision } });
        if (removed.count !== 1) throw new ServiceError("CONFLICT");
      }
      return tx.annotation.findMany({ where: { assetId: resolved.asset.id, datasetId: resolved.asset.datasetId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: annotationSelect });
    });
    return { ok: true, value: annotations.map(toSafeAnnotation) };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, reason: error.reason };
    throw error;
  }
}
