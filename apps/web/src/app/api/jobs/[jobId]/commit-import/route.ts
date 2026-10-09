import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { commitLocalFolderImport } from "@/lib/imports/commit-local-folder-import";
import { jobIdSchema } from "@/lib/validation/job";

export const dynamic = "force-dynamic";
export async function POST(_: Request, context: { params: Promise<{ jobId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const { jobId } = await context.params;
  if (!jobIdSchema.safeParse(jobId).success) return apiError(400, "INVALID_REQUEST", "The job id is invalid.");
  const result = await commitLocalFolderImport(actor, jobId);
  if (!result.ok) {
    if (result.status === 404) return apiError(404, "JOB_NOT_FOUND", "The import job was not found.");
    // A2 (D9): a pending verification blocks the commit; the import Job is NOT failed and the same commit may be repeated once the verifications settle.
    if ("code" in result && result.code === "UPLOAD_VERIFICATION_PENDING") return apiError(409, "UPLOAD_VERIFICATION_PENDING", "Some uploads are still being verified. Commit again once verification finishes.", undefined, { "Retry-After": "2" }, { outcome: "pending", accepted: result.accepted, unchanged: result.unchanged, rejected: result.rejected, retryable: result.retryable, unprocessed: result.unprocessed, verifying: result.verifying });
    if ("code" in result && result.code === "IMPORT_INCOMPLETE") return apiError(409, "IMPORT_INCOMPLETE", "The import finished with rejected, retryable, or unprocessed files. Valid Assets were retained.", undefined, undefined, { outcome: "incomplete", accepted: result.accepted, unchanged: result.unchanged, rejected: result.rejected, retryable: result.retryable, unprocessed: result.unprocessed });
    return apiError(409, "JOB_CONFLICT", "The import cannot be committed in its current state.");
  }
  return apiSuccess({ id: jobId, status: "COMPLETED", replayed: result.replayed, accepted: result.accepted, unchanged: result.unchanged, completed: result.completed, total: result.total });
}
