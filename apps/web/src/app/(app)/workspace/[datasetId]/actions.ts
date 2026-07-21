"use server";
import { getRequestActor } from "@/lib/auth";
import { assertAnnotationPermission, validateAnnotationReferences } from "@/lib/authorization";
import { db } from "@/lib/db";
import { createAnnotationInputSchema, reviewAnnotationInputSchema, updateAnnotationInputSchema } from "@/lib/validation/annotation";

export async function createAnnotationAction(input: unknown) {
  const parsed = createAnnotationInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400 };
  const actor = await getRequestActor();
  if (!actor) return { ok: false, status: 401 };
  const access = await assertAnnotationPermission(actor, parsed.data.datasetId, "annotation.create");
  if (!access) return { ok: false, status: 404 };
  if (access.forbidden) return { ok: false, status: 403 };
  if (!(await validateAnnotationReferences(parsed.data.datasetId, parsed.data.assetId, parsed.data.assetVersionId, parsed.data.labelId))) return { ok: false, status: 404 };
  const annotation = await db.annotation.create({
    data: {
      datasetId: parsed.data.datasetId,
      assetId: parsed.data.assetId,
      assetVersionId: parsed.data.assetVersionId ?? null,
      labelId: parsed.data.labelId ?? null,
      createdById: actor.id,
      modality: parsed.data.modality,
      type: parsed.data.type,
      geometry: parsed.data.geometry,
      status: parsed.data.status,
    },
    select: { id: true, revision: true },
  });
  // Keep the action contract stable while mapping optimistic-concurrency
  // versioning to the schema's canonical `revision` field.
  return { ok: true, status: 201, annotation: { id: annotation.id, version: annotation.revision } };
}

export async function updateAnnotationAction(input: unknown) {
  const parsed = updateAnnotationInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400 };
  const actor = await getRequestActor();
  if (!actor) return { ok: false, status: 401 };
  const existing = await db.annotation.findFirst({ where: { id: parsed.data.annotationId, datasetId: parsed.data.datasetId }, select: { createdById: true, assetId: true, assetVersionId: true, labelId: true } });
  if (!existing) return { ok: false, status: 404 };
  const permission = existing.createdById === actor.id ? "annotation.updateOwn" : "annotation.updateAny";
  const access = await assertAnnotationPermission(actor, parsed.data.datasetId, permission);
  if (!access) return { ok: false, status: 404 };
  if (access.forbidden) return { ok: false, status: 403 };
  if (!(await validateAnnotationReferences(parsed.data.datasetId, existing.assetId, existing.assetVersionId, existing.labelId))) return { ok: false, status: 404 };
  const updated = await db.annotation.updateMany({ where: { id: parsed.data.annotationId, datasetId: parsed.data.datasetId, revision: parsed.data.version }, data: { geometry: parsed.data.geometry, revision: { increment: 1 }, updatedById: actor.id, ...(parsed.data.status ? { status: parsed.data.status } : {}) } });
  return updated.count === 1 ? { ok: true, status: 200 } : { ok: false, status: 409 };
}

export async function reviewAnnotationAction(input: unknown) {
  const parsed = reviewAnnotationInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400 };
  const actor = await getRequestActor();
  if (!actor) return { ok: false, status: 401 };
  const access = await assertAnnotationPermission(actor, parsed.data.datasetId, "annotation.review");
  if (!access) return { ok: false, status: 404 };
  if (access.forbidden) return { ok: false, status: 403 };
  const updated = await db.annotation.updateMany({ where: { id: parsed.data.annotationId, datasetId: parsed.data.datasetId, revision: parsed.data.version }, data: { status: parsed.data.status, reviewedById: actor.id, revision: { increment: 1 } } });
  return updated.count === 1 ? { ok: true, status: 200 } : { ok: false, status: 409 };
}
