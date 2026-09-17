import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { createAuthorizedExportJob, listSafeExportJobsForActor } from "@/lib/exports/export-service";
import { enforceRateLimit } from "@/lib/rate-limit/enforce";
import { exportListQuerySchema } from "@/lib/validation/export";

export const dynamic = "force-dynamic";

/** The signed-in user's own export history (Jobs they created), for the
 * account settings "Exports & downloads" panel -- not a dataset-scoped list. */
export async function GET(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const query = exportListQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return apiError(400, "INVALID_REQUEST", "Export list query is invalid.");
  return apiSuccess(await listSafeExportJobsForActor(actor, query.data));
}

export async function POST(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const limited = await enforceRateLimit(actor.id, "export");
  if (limited) return limited;
  const result = await createAuthorizedExportJob(actor, await request.json().catch(() => null));
  if (!result.ok) {
    const code = result.status === 403 ? "FORBIDDEN" : result.status === 404 ? "JOB_NOT_FOUND" : result.status === 409 ? "JOB_CONFLICT" : "INVALID_REQUEST";
    return apiError(result.status, code, result.status === 403 ? "You do not have permission to export this dataset." : result.status === 404 ? "The dataset was not found." : result.status === 409 ? "The export could not be started." : "The export request is invalid.");
  }
  return apiSuccess({ job: result.job, deliveryPending: result.deliveryPending }, { status: result.status });
}
