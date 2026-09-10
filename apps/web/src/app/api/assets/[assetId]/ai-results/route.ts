import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { readAiPredictionResults } from "@/lib/ai/ai-prediction-results";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ assetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const result = await readAiPredictionResults(actor, (await context.params).assetId);
  return result ? apiSuccess(result) : apiError(404, "AI_TASK_NOT_FOUND", "AI results were not found.");
}
