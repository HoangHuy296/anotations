import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { createVideoTemporalLabel } from "@/lib/annotations/video-temporal-label-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ assetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const body = await request.json().catch(() => null);
  const result = await createVideoTemporalLabel(actor, (await context.params).assetId, body);
  if (result.ok) return apiSuccess({ temporalLabel: result.value }, { status: 201 });
  if (result.reason === "FORBIDDEN") return apiError(403, "FORBIDDEN", "You do not have permission for this action.");
  if (result.reason === "INVALID_REQUEST") return apiError(400, "INVALID_REQUEST", "The temporal label request is invalid.");
  return apiError(404, "ANNOTATION_NOT_FOUND", "The annotation resource was not found.");
}
