import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { createAndEnqueueNewDatasetSourceImportJob, createAndEnqueueSourceImportJob } from "@/lib/queue/enqueue-job";
import { readBoundedJsonRequest } from "@/lib/gitea-route";
import { safePreflightFailure } from "@/lib/providers/provider-errors";
import { preflightSourceImport } from "@/lib/source-import/preflight";
import { normalizeSourceRootPath } from "@/lib/source-access-policy";
import { createSourceImportJobSchema, sourceImportStartSchema } from "@/lib/validation/source-connection";

export const dynamic = "force-dynamic";

/**
 * Creates the existing durable source-backed Job through an opaque-session
 * HTTP boundary. It never accepts a provider URL, token, queue field, or
 * storage reference from the browser.
 */
export async function POST(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");

  const bodyResult = await readBoundedJsonRequest(request);
  if (!bodyResult.success) return bodyResult.response;
  const body = bodyResult.data;

  // The repository-import UI uses the new-Dataset contract distinguished by
  // `credentialMode`; the existing-dataset source Job contract below remains
  // intact for approved dataset-scoped callers.
  const start = sourceImportStartSchema.safeParse(body);
  if (start.success) return startNewDatasetImport(actor, start.data);
  if (body && typeof body === "object" && !Array.isArray(body) && "credentialMode" in body) {
    return apiError(
      400,
      "INVALID_REQUEST",
      "The source import request is invalid.",
      start.error.flatten().fieldErrors as Record<string, string[]>,
    );
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

async function startNewDatasetImport(actor: NonNullable<Awaited<ReturnType<typeof getRequestActor>>>, input: import("@/lib/validation/source-connection").SourceImportRequest) {
  if (input.credentialMode === "ONE_TIME_PAT" && !input.saveAsSourceConnection) {
    return apiError(422, "ONE_TIME_PAT_REQUIRES_SAVE_FOR_ASYNC_IMPORT", "A one-time token must be saved as a source connection before asynchronous import.");
  }

  let preflight;
  try {
    // Re-run preflight before the transaction. It is still read-only and the
    // PAT remains transient process memory only.
    preflight = await preflightSourceImport(actor, input);
  } catch (error) {
    const safe = safePreflightFailure(error);
    return apiError(safe.status, safe.code === "PROVIDER_UNAVAILABLE" ? "SOURCE_PROVIDER_UNAVAILABLE" : safe.code, safe.message);
  }
  if (preflight.result.visibility !== input.repository.expectedVisibility) {
    return apiError(422, "INVALID_REQUEST", "The selected repository visibility does not match the provider response.");
  }

  const result = await createAndEnqueueNewDatasetSourceImportJob(actor, {
    datasetName: input.datasetName,
    sourceConnection: input.credentialMode === "EXISTING_SOURCE_CONNECTION" && preflight.sourceConnectionId
      ? { id: preflight.sourceConnectionId, baseUrl: preflight.baseUrl }
      : null,
    createSourceConnection: input.credentialMode === "ONE_TIME_PAT"
      ? { name: input.sourceConnectionName!, baseUrl: preflight.baseUrl, token: input.token! }
      : null,
    repository: {
      provider: "GITEA",
      baseUrl: preflight.baseUrl,
      owner: input.repository.owner,
      repo: input.repository.repo,
      ref: preflight.result.ref.resolved,
      normalizedRootPath: preflight.result.rootPath.normalized ?? "",
      visibility: preflight.result.visibility,
    },
    // Phase 014 preflight intentionally has no full manifest. Keep only a
    // bounded empty manifest until the future import processor expands it.
    manifest: { itemCount: 0, declaredBytes: 0 },
  });
  if (!result.ok) {
    if (result.status === 422) return apiError(422, "SOURCE_IMPORT_LIMIT_EXCEEDED", "The source request exceeds configured limits.");
    if (result.status === 404) return apiError(404, "SOURCE_CONNECTION_NOT_FOUND", "The source connection was not found.");
    return apiError(409, "JOB_CONFLICT", "The source import could not be created.");
  }
  return apiSuccess({
    dataset: { id: result.datasetId },
    job: { id: result.job.id, datasetId: result.datasetId, type: "IMPORT_DATASET", status: result.job.status },
  }, { status: result.status });
}
