import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { readAuthorizedExportJob } from "@/lib/exports/authorization";
import { createAuthorizedExportDownload } from "@/lib/exports/export-download";
import { readSafeExportJob } from "@/lib/exports/export-service";

export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ jobId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const { jobId } = await context.params;
  const access = await readAuthorizedExportJob(actor, jobId);
  if (!access.ok) return apiError(access.status, access.status === 403 ? "FORBIDDEN" : "JOB_NOT_FOUND", access.status === 403 ? "You do not have permission to read this export." : "The export was not found.");
  const job = await readSafeExportJob(jobId);
  if (!job) return apiError(404, "JOB_NOT_FOUND", "The export was not found.");
  const download = await createAuthorizedExportDownload(actor, jobId);
  if (!download.ok) return apiError(download.status, download.status === 403 ? "FORBIDDEN" : download.status === 404 ? "JOB_NOT_FOUND" : "JOB_CONFLICT", "The export artifact is unavailable.");
  return apiSuccess({ job, download: download.value });
}
