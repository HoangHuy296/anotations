import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { cancelAuthorizedAiTask } from "@/lib/ai/ai-task-service";

export const dynamic = "force-dynamic";

/**
 * Cancels an AI task by its own id -- the client only needs `taskId`, never
 * `jobId`. Still cancels the underlying `Job` (the durable source of truth);
 * this route is a `taskId`-scoped entry point onto the same cancellation the
 * platform already exposes at `POST /api/jobs/{jobId}/cancel`, not a second
 * cancellation mechanism.
 */
export async function POST(_request: Request, context: { params: Promise<{ aiTaskId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");

  const { aiTaskId } = await context.params;
  const result = await cancelAuthorizedAiTask(actor, aiTaskId);
  if (!result.ok) {
    switch (result.code) {
      case "AI_TASK_NOT_FOUND": return apiError(404, "AI_TASK_NOT_FOUND", "The AI task was not found.");
      case "FORBIDDEN": return apiError(403, "FORBIDDEN", "You do not have permission to cancel this AI task.");
      case "JOB_CONFLICT": return apiError(409, "JOB_CONFLICT", "This AI task cannot be canceled in its current state.");
    }
  }

  return apiSuccess({ taskId: result.taskId, jobId: result.jobId, status: result.jobStatus });
}
