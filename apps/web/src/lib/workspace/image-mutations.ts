import "server-only";

import { AnnotationSource, AnnotationType, Modality } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { assertAnnotationPermission, requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import type { NormalizedBoundingBox, SafeImageAnnotation } from "@/types/image-workspace";

type MutationResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404 | 409 };

function projectAnnotation(annotation: { id: string; assetId: string; labelId: string | null; type: AnnotationType; geometry: unknown; status: string; revision: number; updatedAt: Date }): SafeImageAnnotation | null {
  const geometry = annotation.geometry as Partial<NormalizedBoundingBox>;
  if (annotation.type !== AnnotationType.BOUNDING_BOX || !geometry || typeof geometry.x !== "number" || typeof geometry.y !== "number" || typeof geometry.width !== "number" || typeof geometry.height !== "number") return null;
  if (!["DRAFT", "IN_PROGRESS", "COMPLETED"].includes(annotation.status)) return null;
  return { id: annotation.id, assetId: annotation.assetId, labelId: annotation.labelId, type: "BOUNDING_BOX", geometry: geometry as NormalizedBoundingBox, status: annotation.status as SafeImageAnnotation["status"], version: annotation.revision, updatedAt: annotation.updatedAt.toISOString() };
}

async function resolveEditableAnnotation(actor: RequestActor, datasetId: string, assetId: string, annotationId: string) {
  const annotation = await db.annotation.findFirst({ where: { id: annotationId, datasetId, assetId, modality: Modality.IMAGE, type: AnnotationType.BOUNDING_BOX }, select: { id: true, createdById: true } });
  if (!annotation) return { status: 404 as const };
  const permission = annotation.createdById === actor.id ? "annotation.updateOwn" : "annotation.updateAny";
  const access = await assertAnnotationPermission(actor, datasetId, permission);
  if (!access) return { status: 404 as const };
  if (access.forbidden) return { status: 403 as const };
  return { annotation };
}

export async function createBoundingBox(actor: RequestActor, input: { datasetId: string; assetId: string; labelId?: string | null; geometry: NormalizedBoundingBox }): Promise<MutationResult<SafeImageAnnotation>> {
  const access = await assertAnnotationPermission(actor, input.datasetId, "annotation.create");
  if (!access) return { ok: false, status: 404 };
  if (access.forbidden) return { ok: false, status: 403 };
  const [asset, label] = await Promise.all([
    db.asset.findFirst({ where: { id: input.assetId, datasetId: input.datasetId, modality: Modality.IMAGE, deletedAt: null, archivedAt: null }, select: { id: true } }),
    input.labelId ? db.label.findFirst({ where: { id: input.labelId, datasetId: input.datasetId, OR: [{ modality: null }, { modality: Modality.IMAGE }] }, select: { id: true } }) : Promise.resolve(null),
  ]);
  if (!asset || (input.labelId && !label)) return { ok: false, status: 404 };
  const annotation = await db.annotation.create({ data: { datasetId: input.datasetId, assetId: input.assetId, labelId: input.labelId ?? null, createdById: actor.id, modality: Modality.IMAGE, type: AnnotationType.BOUNDING_BOX, source: AnnotationSource.MANUAL, geometry: input.geometry }, select: { id: true, assetId: true, labelId: true, type: true, geometry: true, status: true, revision: true, updatedAt: true } });
  const value = projectAnnotation(annotation);
  return value ? { ok: true, value } : { ok: false, status: 400 };
}

export async function updateBoundingBoxGeometry(actor: RequestActor, input: { datasetId: string; assetId: string; annotationId: string; version: number; geometry: NormalizedBoundingBox }): Promise<MutationResult<SafeImageAnnotation>> {
  const resolved = await resolveEditableAnnotation(actor, input.datasetId, input.assetId, input.annotationId);
  if ("status" in resolved) return { ok: false, status: resolved.status ?? 404 };
  const result = await db.annotation.updateMany({ where: { id: input.annotationId, datasetId: input.datasetId, assetId: input.assetId, revision: input.version }, data: { geometry: input.geometry, updatedById: actor.id, revision: { increment: 1 } } });
  if (result.count !== 1) return { ok: false, status: 409 };
  const annotation = await db.annotation.findUnique({ where: { id: input.annotationId }, select: { id: true, assetId: true, labelId: true, type: true, geometry: true, status: true, revision: true, updatedAt: true } });
  const value = annotation && projectAnnotation(annotation);
  return value ? { ok: true, value } : { ok: false, status: 404 };
}

export async function updateBoundingBoxLabel(actor: RequestActor, input: { datasetId: string; assetId: string; annotationId: string; version: number; labelId: string | null }): Promise<MutationResult<SafeImageAnnotation>> {
  const resolved = await resolveEditableAnnotation(actor, input.datasetId, input.assetId, input.annotationId);
  if ("status" in resolved) return { ok: false, status: resolved.status ?? 404 };
  if (input.labelId) {
    const label = await db.label.findFirst({ where: { id: input.labelId, datasetId: input.datasetId, OR: [{ modality: null }, { modality: Modality.IMAGE }] }, select: { id: true } });
    if (!label) return { ok: false, status: 404 };
  }
  const result = await db.annotation.updateMany({ where: { id: input.annotationId, datasetId: input.datasetId, assetId: input.assetId, revision: input.version }, data: { labelId: input.labelId, updatedById: actor.id, revision: { increment: 1 } } });
  if (result.count !== 1) return { ok: false, status: 409 };
  const annotation = await db.annotation.findUnique({ where: { id: input.annotationId }, select: { id: true, assetId: true, labelId: true, type: true, geometry: true, status: true, revision: true, updatedAt: true } });
  const value = annotation && projectAnnotation(annotation);
  return value ? { ok: true, value } : { ok: false, status: 404 };
}

export async function deleteBoundingBox(actor: RequestActor, input: { datasetId: string; assetId: string; annotationId: string; version: number }): Promise<MutationResult<null>> {
  const resolved = await resolveEditableAnnotation(actor, input.datasetId, input.assetId, input.annotationId);
  if ("status" in resolved) return { ok: false, status: resolved.status ?? 404 };
  const result = await db.annotation.deleteMany({ where: { id: input.annotationId, datasetId: input.datasetId, assetId: input.assetId, revision: input.version } });
  return result.count === 1 ? { ok: true, value: null } : { ok: false, status: 409 };
}

export async function updateImageDescription(actor: RequestActor, input: { datasetId: string; assetId: string; version: number; description: string | null }): Promise<MutationResult<{ id: string; description: string | null; version: number }>> {
  const access = await requireDatasetPermission(actor, input.datasetId, "dataset.update");
  if (!access) return { ok: false, status: 404 };
  if (access.forbidden) return { ok: false, status: 403 };
  const result = await db.asset.updateMany({ where: { id: input.assetId, datasetId: input.datasetId, modality: Modality.IMAGE, revision: input.version, deletedAt: null, archivedAt: null }, data: { description: input.description, revision: { increment: 1 } } });
  if (result.count !== 1) {
    const exists = await db.asset.findFirst({ where: { id: input.assetId, datasetId: input.datasetId, modality: Modality.IMAGE, deletedAt: null, archivedAt: null }, select: { id: true } });
    return { ok: false, status: exists ? 409 : 404 };
  }
  const asset = await db.asset.findUnique({ where: { id: input.assetId }, select: { id: true, description: true, revision: true } });
  return asset ? { ok: true, value: { id: asset.id, description: asset.description, version: asset.revision } } : { ok: false, status: 404 };
}
