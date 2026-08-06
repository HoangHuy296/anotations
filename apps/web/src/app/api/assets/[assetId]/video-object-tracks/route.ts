import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { createVideoObjectTrack } from "@/lib/annotations/video-track-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ assetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const result = await createVideoObjectTrack(actor, (await context.params).assetId, await request.json().catch(() => null));
  if (result.ok) return apiSuccess({ track: result.value }, { status: 201 });
  if (result.reason === "FORBIDDEN") return apiError(403, "FORBIDDEN", "You do not have permission for this action.");
  if (result.reason === "INVALID_REQUEST") return apiError(400, "INVALID_REQUEST", "The video track request is invalid.");
  return apiError(404, "ANNOTATION_NOT_FOUND", "The annotation resource was not found.");
}
