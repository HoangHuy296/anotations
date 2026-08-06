import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { createVideoKeyframe } from "@/lib/annotations/video-keyframe-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ trackId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const result = await createVideoKeyframe(actor, (await context.params).trackId, await request.json().catch(() => null));
  if (result.ok) return apiSuccess(result.value, { status: 201 });
  if (result.reason === "FORBIDDEN") return apiError(403, "FORBIDDEN", "You do not have permission for this action.");
  if (result.reason === "INVALID_REQUEST") return apiError(400, "INVALID_REQUEST", "The video keyframe request is invalid.");
  if (result.reason === "CONFLICT") return apiError(409, "VIDEO_TRACK_REVISION_CONFLICT", "A video track changed. Reload before saving.");
  if (result.reason === "DUPLICATE_TIMESTAMP") return apiError(409, "VIDEO_KEYFRAME_TIMESTAMP_CONFLICT", "A keyframe already exists at this timestamp.");
  return apiError(404, "ANNOTATION_NOT_FOUND", "The annotation resource was not found.");
}
