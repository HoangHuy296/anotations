import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { createAndEnqueueSourceImportJob } from "@/lib/queue/enqueue-job";
import { normalizeSourceRootPath } from "@/lib/source-access-policy";
import { createSourceImportJobSchema } from "@/lib/validation/source-connection";

export const dynamic = "force-dynamic";

/**
 * Creates the existing durable source-backed Job through an opaque-session
 * HTTP boundary. It never accepts a provider URL, token, queue field, or
 * storage reference from the browser.
 */
export async function POST(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "INVALID_REQUEST", "The request body must contain valid JSON.");
  }
  const parsed = createSourceImportJobSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(
      400,
      "INVALID_REQUEST",
      "The source Job request is invalid.",
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  const rootPath = normalizeSourceRootPath(parsed.data.repository.rootPath);
  if (!rootPath.ok) return apiError(400, rootPath.code, "The source root path is not allowed.");

  const result = await createAndEnqueueSourceImportJob(actor, {
    datasetId: parsed.data.datasetId,
    sourceConnectionId: parsed.data.sourceConnectionId,
    repository: {
      provider: parsed.data.repository.provider,
      owner: parsed.data.repository.owner,
      repo: parsed.data.repository.repo,
      branch: parsed.data.repository.branch,
      normalizedRootPath: rootPath.value,
      visibility: parsed.data.repository.visibility,
    },
    manifest: parsed.data.manifest,
    retryOfJobId: parsed.data.retryOfJobId,
  });
  if (!result.ok) {
    if (result.status === 403) return apiError(403, "FORBIDDEN", "You do not have permission to create source work for this Dataset.");
    if (result.status === 404) return apiError(404, "SOURCE_CONNECTION_NOT_FOUND", "The source connection was not found.");
    if (result.status === 422) return apiError(422, "SOURCE_IMPORT_LIMIT_EXCEEDED", "The source request exceeds configured limits.");
    // A private connection that becomes inactive/deleted between validation
    // and the serializable transaction follows concealed source semantics.
    if (parsed.data.sourceConnectionId) return apiError(404, "SOURCE_CONNECTION_NOT_FOUND", "The source connection was not found.");
    return apiError(409, "JOB_CONFLICT", "The source Job could not be created.");
  }

  return apiSuccess({
    job: {
      id: result.job.id,
      datasetId: result.job.datasetId,
      type: "IMPORT_DATASET",
      status: result.job.status,
    },
  }, { status: result.status });
}
