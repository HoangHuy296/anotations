import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { listActiveAiModels, loadModelClasses } from "@/lib/ai/ai-model-service";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ modelId: string }> }) {
  if (!await getRequestActor()) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const { modelId } = await context.params;
  if (!z.string().min(1).max(128).safeParse(modelId).success) return apiError(400, "INVALID_REQUEST", "Invalid model.");
  try {
    const model = (await listActiveAiModels()).find((item) => item.id === modelId);
    if (!model) return apiError(404, "AI_MODEL_NOT_FOUND", "The AI model was not found.");
    return apiSuccess({ classes: await loadModelClasses(model.key) });
  } catch {
    return apiError(502, "AI_MODEL_LABELS_UNAVAILABLE", "Could not load model classes. Try again.");
  }
}
