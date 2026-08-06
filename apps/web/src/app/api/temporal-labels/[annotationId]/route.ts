import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { deleteVideoTemporalLabel, updateVideoTemporalLabel } from "@/lib/annotations/video-temporal-label-service";

export const dynamic = "force-dynamic";

function failure(reason: "NOT_FOUND" | "FORBIDDEN" | "INVALID_REQUEST" | "CONFLICT") {
  if (reason === "FORBIDDEN") return apiError(403, "FORBIDDEN", "You do not have permission for this action.");
  if (reason === "INVALID_REQUEST") return apiError(400, "INVALID_REQUEST", "The temporal label request is invalid.");
  if (reason === "CONFLICT") return apiError(409, "ANNOTATION_REVISION_CONFLICT", "A temporal label changed. Reload before saving.");
  return apiError(404, "ANNOTATION_NOT_FOUND", "The annotation resource was not found.");
}

export async function PATCH(request: Request, context: { params: Promise<{ annotationId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const result = await updateVideoTemporalLabel(actor, (await context.params).annotationId, await request.json().catch(() => null));
  return result.ok ? apiSuccess({ temporalLabel: result.value }) : failure(result.reason);
}

export async function DELETE(request: Request, context: { params: Promise<{ annotationId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const result = await deleteVideoTemporalLabel(actor, (await context.params).annotationId, await request.json().catch(() => null));
  return result.ok ? apiSuccess({ deleted: true }) : failure(result.reason);
}
