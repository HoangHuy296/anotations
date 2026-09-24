import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { requestTextSourcePreparation } from "@/lib/annotations/text-source-prepare-service";
import { mapTextSourcePrepareOutcomeToHttp } from "@/lib/annotations/text-source-http-mapping";

export const dynamic = "force-dynamic";

/**
 * Gated on `dataset.read` (T038) — independent of `annotation.create` and
 * any review-freeze workflow state, so a reviewer inspecting a frozen asset
 * can still trigger preparation of an unprepared source. Thin caller of the
 * T038 service; no authorization/idempotency logic duplicated here.
 */
export async function POST(_request: Request, context: { params: Promise<{ assetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const { assetId } = await context.params;
  const outcome = await requestTextSourcePreparation(actor, assetId);
  const mapped = mapTextSourcePrepareOutcomeToHttp(outcome);
  if (!outcome.ok) {
    return apiError(mapped.status, outcome.reason === "SOURCE_UNAVAILABLE" ? "MEDIA_SOURCE_MISSING" : "GITEA_NOT_FOUND", outcome.reason === "SOURCE_UNAVAILABLE" ? "This asset has no source object to prepare." : "The asset was not found.");
  }
  return apiSuccess({ jobId: outcome.job.id, status: outcome.job.status, created: outcome.created, ready: mapped.ready }, { status: mapped.status });
}
