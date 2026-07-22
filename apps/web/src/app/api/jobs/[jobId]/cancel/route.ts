import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { cancelAuthorizedJob } from "@/lib/jobs/authorization";
import { jobIdSchema } from "@/lib/validation/job";

export const dynamic = "force-dynamic";

/**
 * Requests cancellation through the Dataset authorization boundary. This route
 * accepts neither a lock token nor queue data: only the worker that owns a
 * current lease may acknowledge a running cancellation.
 */
export async function POST(_: Request, context: { params: Promise<{ jobId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");

  const { jobId } = await context.params;
  if (!jobIdSchema.safeParse(jobId).success) return apiError(400, "INVALID_REQUEST", "The job id is invalid.");

  const result = await cancelAuthorizedJob(actor, jobId);
  if (!result.ok) {
    if (result.status === 403) return apiError(403, "FORBIDDEN", "You do not have permission to cancel this job.");
    if (result.status === 404) return apiError(404, "JOB_NOT_FOUND", "The job was not found.");
    return apiError(409, "JOB_CONFLICT", "This job cannot be canceled in its current state.");
  }
  return apiSuccess({ id: jobId, status: result.cancellationStatus });
}
