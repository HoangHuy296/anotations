import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { deleteVideoObjectTrack, updateVideoObjectTrack } from "@/lib/annotations/video-track-service";
import { videoTrackDeleteSchema } from "@/lib/validation/video-annotation";

export const dynamic = "force-dynamic";

function failure(reason: "NOT_FOUND" | "FORBIDDEN" | "INVALID_REQUEST" | "CONFLICT") {
  if (reason === "FORBIDDEN") return apiError(403, "FORBIDDEN", "You do not have permission for this action.");
  if (reason === "INVALID_REQUEST") return apiError(400, "INVALID_REQUEST", "The video track request is invalid.");
  if (reason === "CONFLICT") return apiError(409, "VIDEO_TRACK_REVISION_CONFLICT", "A video track changed. Reload before saving.");
  return apiError(404, "ANNOTATION_NOT_FOUND", "The annotation resource was not found.");
}

export async function PATCH(request: Request, context: { params: Promise<{ trackId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const result = await updateVideoObjectTrack(actor, (await context.params).trackId, await request.json().catch(() => null));
  return result.ok ? apiSuccess({ track: result.value }) : failure(result.reason);
}

export async function DELETE(request: Request, context: { params: Promise<{ trackId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const parsed = videoTrackDeleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return failure("INVALID_REQUEST");
  const result = await deleteVideoObjectTrack(actor, (await context.params).trackId, parsed.data.expectedTrackRevision);
  return result.ok ? apiSuccess({ deleted: true }) : failure(result.reason);
}
