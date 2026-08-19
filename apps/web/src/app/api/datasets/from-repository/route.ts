import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { readBoundedJsonRequest } from "@/lib/gitea-route";
import { safePreflightFailure } from "@/lib/providers/provider-errors";
import { enforceRateLimit } from "@/lib/rate-limit/enforce";
import { acceptRepositoryImportRequest } from "@/lib/repository-import/acceptance";
import { repositoryImportRequestSchema } from "@/lib/validation/repository-import-request";

export const dynamic = "force-dynamic";

/**
 * Phase-015's only browser-facing durable repository-import boundary. The
 * coordinator repeats read-only preflight before its serializable transaction.
 * A Gitea one-time PAT is the sole narrow credential exception: it remains
 * transient request memory and may only be encrypted into an owned connection
 * inside the shared transaction. Ownership, queue, and storage fields remain
 * forbidden browser input.
 */
export async function POST(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const limited = await enforceRateLimit(actor.id, "import");
  if (limited) return limited;

  const body = await readBoundedJsonRequest(request);
  if (!body.success) return body.response;
  const parsed = repositoryImportRequestSchema.safeParse(body.data);
  if (!parsed.success) {
    return apiError(400, "INVALID_REQUEST", "The repository import request is invalid.");
  }

  try {
    const result = await acceptRepositoryImportRequest(actor, parsed.data);
    if (!result.ok) {
      if (result.code === "FORBIDDEN") return apiError(403, "FORBIDDEN", "You do not have permission to create a Dataset.");
      if (result.code === "SOURCE_CONNECTION_NOT_FOUND") return apiError(404, "SOURCE_CONNECTION_NOT_FOUND", "The source connection was not found.");
      if (result.code === "SOURCE_IMPORT_LIMIT_EXCEEDED") return apiError(422, "SOURCE_IMPORT_LIMIT_EXCEEDED", "The source request exceeds configured limits.");
      if (result.code === "ONE_TIME_PAT_REQUIRES_SAVE_FOR_ASYNC_IMPORT") {
        return apiError(422, "ONE_TIME_PAT_REQUIRES_SAVE_FOR_ASYNC_IMPORT", "A one-time token must be saved as a source connection before asynchronous import.");
      }
      if (result.code === "IDEMPOTENCY_KEY_CONFLICT") return apiError(409, "IDEMPOTENCY_KEY_CONFLICT", "This idempotency key was already used for a different request.");
      if (result.code === "INVALID_REQUEST") return apiError(400, "INVALID_REQUEST", "The repository import request is invalid.");
      return apiError(409, "JOB_CONFLICT", "The repository import could not be accepted.");
    }

    return apiSuccess(
      {
        dataset: result.acceptance.dataset,
        job: result.acceptance.job,
        progressPath: result.acceptance.progressPath,
      },
      // The durable Job is accepted asynchronously. A replay returns its
      // existing safe DTO, while every new acceptance has HTTP 202 semantics
      // even when its post-commit delivery was immediately successful.
      { status: result.acceptance.reused ? 200 : 202 },
    );
  } catch (error) {
    const safe = safePreflightFailure(error);
    return apiError(
      safe.status,
      safe.code === "PROVIDER_UNAVAILABLE" ? "SOURCE_PROVIDER_UNAVAILABLE" : safe.code,
      safe.message,
    );
  }
}
