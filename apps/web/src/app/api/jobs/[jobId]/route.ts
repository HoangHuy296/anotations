import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { readAuthorizedJob } from "@/lib/jobs/authorization";
import { toSafeJobStatus } from "@/lib/jobs/safe-job-status";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ jobId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const { jobId } = await context.params;
  const access = await readAuthorizedJob(actor, jobId);
  if (!access.ok) return apiError(access.status, access.status === 403 ? "FORBIDDEN" : "GITEA_NOT_FOUND", "The job was not found.");
  const job = await db.job.findUnique({ where: { id: access.job.id }, select: {
    id: true, datasetId: true, type: true, status: true, stage: true, progress: true, totalItems: true,
    processedItems: true, successItems: true, failedItems: true, skippedItems: true, createdAt: true, updatedAt: true,
  } });
  if (!job) return apiError(404, "GITEA_NOT_FOUND", "The job was not found.");
  return apiSuccess(toSafeJobStatus(job));
}
