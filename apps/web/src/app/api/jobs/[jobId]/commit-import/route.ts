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
    if ("code" in result && result.code === "IMPORT_INCOMPLETE") return apiError(409, "IMPORT_INCOMPLETE", "All prepared files must complete before committing.");
    return apiError(409, "JOB_CONFLICT", "The import cannot be committed in its current state.");
  }
  return apiSuccess({ id: jobId, status: "COMPLETED", replayed: result.replayed, completed: result.completed, total: result.total });
}
