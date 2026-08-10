"use server";

import { getRequestActor } from "@/lib/auth";
import { assertAnnotationPermission } from "@/lib/authorization";
import { mutateImageAnnotations } from "@/lib/annotations/annotation-service";
import { db } from "@/lib/db";
import {
  createBoundingBoxInputSchema,
  deleteBoundingBoxInputSchema,
  updateAssetDescriptionInputSchema,
  updateBoundingBoxGeometryInputSchema,
  updateBoundingBoxLabelInputSchema,
} from "@/lib/validation/image-workspace";
import { reviewAnnotationInputSchema } from "@/lib/validation/annotation";
import {
  updateImageDescription,
} from "@/lib/workspace/image-mutations";
import { updateVideoDescription } from "@/lib/workspace/video-mutations";
import { ensureDefaultImageLabels } from "@/lib/workspace/label-management";

type ActionFailure = { ok: false; status: 400 | 401 | 403 | 404 | 409; error: "INVALID_REQUEST" | "AUTH_REQUIRED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" };

function invalid(): ActionFailure { return { ok: false, status: 400, error: "INVALID_REQUEST" }; }
function unauthenticated(): ActionFailure { return { ok: false, status: 401, error: "AUTH_REQUIRED" }; }
function fromStatus(status: 400 | 403 | 404 | 409): ActionFailure {
  return { ok: false, status, error: status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "INVALID_REQUEST" };
}

function fromMutationReason(reason: "NOT_FOUND" | "FORBIDDEN" | "INVALID_REQUEST" | "CONFLICT" | "WRITE_UNSUPPORTED" | "CREATE_REPLAY_CONFLICT"): ActionFailure {
  return reason === "NOT_FOUND" ? fromStatus(404) : reason === "FORBIDDEN" ? fromStatus(403) : reason === "CONFLICT" || reason === "CREATE_REPLAY_CONFLICT" ? fromStatus(409) : fromStatus(400);
}

export async function createBoundingBoxAction(input: unknown) {
  const parsed = createBoundingBoxInputSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const actor = await getRequestActor();
  if (!actor) return unauthenticated();
  const id = crypto.randomUUID();
  const result = await mutateImageAnnotations(actor, parsed.data.assetId, { creates: [{ id, type: "BOUNDING_BOX", labelId: parsed.data.labelId, geometry: parsed.data.geometry }], updates: [], deletes: [] });
  if (!result.ok) return fromMutationReason(result.reason);
  const annotation = result.value.find((item) => item.id === id);
  return annotation ? { ok: true as const, status: 201 as const, annotation } : invalid();
}

export async function updateBoundingBoxGeometryAction(input: unknown) {
  const parsed = updateBoundingBoxGeometryInputSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const actor = await getRequestActor();
  if (!actor) return unauthenticated();
  const result = await mutateImageAnnotations(actor, parsed.data.assetId, { creates: [], updates: [{ id: parsed.data.annotationId, revision: parsed.data.revision, geometry: parsed.data.geometry }], deletes: [] });
  if (!result.ok) return fromMutationReason(result.reason);
  const annotation = result.value.find((item) => item.id === parsed.data.annotationId);
  return annotation ? { ok: true as const, status: 200 as const, annotation } : invalid();
}

export async function updateBoundingBoxLabelAction(input: unknown) {
  const parsed = updateBoundingBoxLabelInputSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const actor = await getRequestActor();
  if (!actor) return unauthenticated();
  const result = await mutateImageAnnotations(actor, parsed.data.assetId, { creates: [], updates: [{ id: parsed.data.annotationId, revision: parsed.data.revision, labelId: parsed.data.labelId }], deletes: [] });
  if (!result.ok) return fromMutationReason(result.reason);
  const annotation = result.value.find((item) => item.id === parsed.data.annotationId);
  return annotation ? { ok: true as const, status: 200 as const, annotation } : invalid();
}

export async function deleteBoundingBoxAction(input: unknown) {
  const parsed = deleteBoundingBoxInputSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const actor = await getRequestActor();
  if (!actor) return unauthenticated();
  const result = await mutateImageAnnotations(actor, parsed.data.assetId, { creates: [], updates: [], deletes: [{ id: parsed.data.annotationId, revision: parsed.data.revision }] });
  return result.ok ? { ok: true as const, status: 204 as const } : fromMutationReason(result.reason);
}

export async function updateImageDescriptionAction(input: unknown) {
  const parsed = updateAssetDescriptionInputSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const actor = await getRequestActor();
  if (!actor) return unauthenticated();
  const result = await updateImageDescription(actor, parsed.data);
  return result.ok ? { ok: true as const, status: 200 as const, asset: result.value } : fromStatus(result.status);
}

export async function updateVideoDescriptionAction(input: unknown) {
  const parsed = updateAssetDescriptionInputSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const actor = await getRequestActor();
  if (!actor) return unauthenticated();
  const result = await updateVideoDescription(actor, parsed.data);
  return result.ok ? { ok: true as const, status: 200 as const, asset: result.value } : fromStatus(result.status);
}

export async function ensureDefaultImageLabelsAction(datasetId: unknown) {
  if (typeof datasetId !== "string") return invalid();
  const actor = await getRequestActor();
  if (!actor) return unauthenticated();
  const result = await ensureDefaultImageLabels(actor, datasetId);
  return result.ok ? { ok: true as const, status: 200 as const, created: result.created } : fromStatus(result.status);
}

/** Compatibility export for existing callers. It deliberately remains geometry-only. */
export const createAnnotationAction = createBoundingBoxAction;
export const updateAnnotationAction = updateBoundingBoxGeometryAction;

/** Review remains deliberately separate from ordinary geometry/label editing. */
export async function reviewAnnotationAction(input: unknown) {
  const parsed = reviewAnnotationInputSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const actor = await getRequestActor();
  if (!actor) return unauthenticated();
  const access = await assertAnnotationPermission(actor, parsed.data.datasetId, "annotation.review");
  if (!access) return fromStatus(404);
  if (access.forbidden) return fromStatus(403);
  const result = await db.annotation.updateMany({
    where: { id: parsed.data.annotationId, datasetId: parsed.data.datasetId, revision: parsed.data.revision },
    data: { status: parsed.data.status, reviewedById: actor.id, revision: { increment: 1 } },
  });
  return result.count === 1 ? { ok: true as const, status: 200 as const } : fromStatus(409);
}
