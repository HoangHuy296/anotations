import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { previewAiTarget } from "@/lib/ai/ai-target-service";

export const dynamic = "force-dynamic";

/**
 * Read-only target preview for the AI Detection panel. Creates no Job,
 * AiTask or external work; an ineligible target is a normal 200 with a safe
 * reason so the panel can explain why Run is disabled.
 */
export async function POST(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const result = await previewAiTarget(actor, await request.json().catch(() => null));
  if (!result.ok) {
    switch (result.code) {
      case "FORBIDDEN": return apiError(403, "FORBIDDEN", "You do not have permission to request AI pre-annotation for this dataset.");
      case "DATASET_NOT_FOUND": return apiError(404, "DATASET_NOT_FOUND", "The dataset was not found.");
      default: return apiError(400, "INVALID_REQUEST", "The preview request is invalid.");
    }
  }
  return apiSuccess(result.preview);
}
