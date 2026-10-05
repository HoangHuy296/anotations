import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { createAiTask } from "@/lib/ai/ai-task-service";
import { enforceRateLimit } from "@/lib/rate-limit/enforce";

export const dynamic = "force-dynamic";

/**
 * Creates a Job + AiTask in one transaction and enqueues { jobId } strictly
 * after commit. 202, not 201/200 — AI processing is asynchronous; this route
 * never waits on the provider (FR-006).
 */
export async function POST(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");

  const limited = await enforceRateLimit(actor.id, "ai-task");
  if (limited) return limited;

  const result = await createAiTask(actor, await request.json().catch(() => null));
  if (!result.ok) {
    switch (result.code) {
      case "AI_MODEL_LABELS_UNAVAILABLE":
        return apiError(502, "AI_MODEL_LABELS_UNAVAILABLE", "Could not validate model classes. Try again.");
      case "INVALID_REQUEST":
        return apiError(400, "INVALID_REQUEST", "The AI pre-annotation request is invalid.");
      case "FORBIDDEN":
        return apiError(403, "FORBIDDEN", "You do not have permission to request AI pre-annotation for this dataset.");
      case "DATASET_NOT_FOUND":
        return apiError(404, "DATASET_NOT_FOUND", "The dataset was not found.");
      case "AI_MODEL_NOT_FOUND":
        return apiError(404, "AI_MODEL_NOT_FOUND", "The AI model was not found.");
      case "AI_MODEL_INACTIVE":
        return apiError(409, "AI_MODEL_INACTIVE", "The selected AI model is not active.");
      case "ASSET_NOT_IN_DATASET":
        return apiError(409, "ASSET_NOT_IN_DATASET", "One or more assets do not belong to this dataset.");
      case "AI_MODEL_CATALOG_UNAVAILABLE":
        return apiError(502, "AI_MODEL_CATALOG_UNAVAILABLE", "The AI model catalog is unavailable. Try again.");
      case "TARGET_EMPTY":
        return apiError(400, "TARGET_EMPTY", "Select at least one asset.");
      case "TARGET_TOO_LARGE":
        return apiError(422, "TARGET_TOO_LARGE", "The selection exceeds the maximum number of assets for one AI run.");
      case "TARGET_MIXED_MODALITY":
        return apiError(422, "TARGET_MIXED_MODALITY", "The selected assets must all have the same type.");
      case "TARGET_INELIGIBLE":
        return apiError(422, "TARGET_INELIGIBLE", "One or more selected assets cannot be processed.");
      case "TARGET_CHANGED":
        return apiError(409, "TARGET_CHANGED", "The selection changed. Review it and run again.");
      case "AI_CAPABILITY_UNVERIFIED":
        return apiError(409, "AI_CAPABILITY_UNVERIFIED", "AI is not available for this asset type or batch size yet.");
      case "JOB_CONFLICT":
        return apiError(409, "JOB_CONFLICT", "The AI task could not be enqueued.");
    }
  }

  return apiSuccess({ taskId: result.taskId, jobId: result.jobId, target: result.target }, { status: 202 });
}
