import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { readAuthorizedAiTask } from "@/lib/ai/ai-task-read-service";

export const dynamic = "force-dynamic";

/**
 * Reads the current status of a previously submitted AI task. There is no
 * DELETE/cancel route here — cancelling an AI task is cancelling its Job via
 * the existing POST /api/jobs/{jobId}/cancel (contracts/ai-api.md).
 */
export async function GET(_request: Request, context: { params: Promise<{ aiTaskId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");

  const { aiTaskId } = await context.params;
  const result = await readAuthorizedAiTask(actor, aiTaskId);
  if (!result.ok) return apiError(404, "AI_TASK_NOT_FOUND", "The AI task was not found.");

  return apiSuccess(result.task);
}
