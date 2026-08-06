import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { deleteVideoKeyframe, updateVideoKeyframe } from "@/lib/annotations/video-keyframe-service";
import { videoKeyframeDeleteSchema } from "@/lib/validation/video-annotation";

export const dynamic = "force-dynamic";

function failure(reason: "NOT_FOUND" | "FORBIDDEN" | "INVALID_REQUEST" | "CONFLICT" | "DUPLICATE_TIMESTAMP") {
  if (reason === "FORBIDDEN") return apiError(403, "FORBIDDEN", "You do not have permission for this action.");
  if (reason === "INVALID_REQUEST") return apiError(400, "INVALID_REQUEST", "The video keyframe request is invalid.");
  if (reason === "CONFLICT") return apiError(409, "VIDEO_TRACK_REVISION_CONFLICT", "A video track changed. Reload before saving.");
  if (reason === "DUPLICATE_TIMESTAMP") return apiError(409, "VIDEO_KEYFRAME_TIMESTAMP_CONFLICT", "A keyframe already exists at this timestamp.");
  return apiError(404, "ANNOTATION_NOT_FOUND", "The annotation resource was not found.");
}

export async function PATCH(request: Request, context: { params: Promise<{ annotationId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const result = await updateVideoKeyframe(actor, (await context.params).annotationId, await request.json().catch(() => null));
  return result.ok ? apiSuccess(result.value) : failure(result.reason);
}

export async function DELETE(request: Request, context: { params: Promise<{ annotationId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const parsed = videoKeyframeDeleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failure("INVALID_REQUEST");
  const result = await deleteVideoKeyframe(actor, (await context.params).annotationId, parsed.data.expectedTrackRevision);
  return result.ok ? apiSuccess(result.value) : failure(result.reason);
}
