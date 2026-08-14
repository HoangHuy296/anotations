import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { createAiTask } from "@/lib/ai/ai-task-service";

export const dynamic = "force-dynamic";

/**
 * Creates a Job + AiTask in one transaction and enqueues { jobId } strictly
 * after commit. 202, not 201/200 — AI processing is asynchronous; this route
 * never waits on the provider (FR-006).
 */
export async function POST(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");

  const result = await createAiTask(actor, await request.json().catch(() => null));
  if (!result.ok) {
    switch (result.code) {
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
      case "JOB_CONFLICT":
        return apiError(409, "JOB_CONFLICT", "The AI task could not be enqueued.");
    }
  }

  return apiSuccess({ taskId: result.taskId, jobId: result.jobId }, { status: 202 });
}
