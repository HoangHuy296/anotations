import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { PredictionSaveError, readAiPredictionResults, saveAiPrediction, savePredictionSchema } from "@/lib/ai/ai-prediction-results";

export async function POST(request: Request, context: { params: Promise<{ aiTaskId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const input = savePredictionSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return apiError(400, "INVALID_REQUEST", "Select a valid prediction.");
  try {
    return apiSuccess({ annotation: await saveAiPrediction(actor, (await context.params).aiTaskId, input.data) });
  } catch (error) {
    if (!(error instanceof PredictionSaveError)) return apiError(500, "INTERNAL_ERROR", "Could not save this prediction. Try again.");
    if (error.code === "WORKFLOW_LOCKED") return apiError(409, "INVALID_TRANSITION", "This asset is locked for review.");
    if (error.code === "CONFLICT") return apiError(409, "ANNOTATION_CREATE_REPLAY_CONFLICT", "This prediction was already saved with another label. Reload the results.");
    return apiError(404, "AI_TASK_NOT_FOUND", "The prediction was not found.");
  }
}

/** Returns only this completed task's safe, normalized predictions for an authorized asset. */
export async function GET(request: Request, context: { params: Promise<{ aiTaskId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const assetId = z.string().min(1).max(128).safeParse(new URL(request.url).searchParams.get("assetId"));
  if (!assetId.success) return apiError(400, "INVALID_REQUEST", "An asset is required.");
  const result = await readAiPredictionResults(actor, assetId.data, (await context.params).aiTaskId);
  return result ? apiSuccess(result) : apiError(404, "AI_TASK_NOT_FOUND", "Completed predictions were not found.");
}
