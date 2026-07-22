import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { retryAuthorizedJob } from "@/lib/jobs/retry-job";
import { jobIdSchema } from "@/lib/validation/job";

export const dynamic = "force-dynamic";

export async function POST(_: Request, context: { params: Promise<{ jobId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const { jobId } = await context.params;
  if (!jobIdSchema.safeParse(jobId).success) return apiError(400, "INVALID_REQUEST", "The job id is invalid.");

  const result = await retryAuthorizedJob(actor, jobId);
  if (!result.ok) {
    if (result.status === 403) return apiError(403, "FORBIDDEN", "You do not have permission to retry this job.");
    if (result.status === 404) return apiError(404, "JOB_NOT_FOUND", "The job was not found.");
    return apiError(409, "JOB_CONFLICT", "This job is not eligible for retry.");
  }
  return apiSuccess({ id: result.job.id, datasetId: result.job.datasetId, type: result.job.type, status: result.job.status }, { status: result.status });
}
