import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { ensureMediaProcessingJob } from "@/lib/media-processing/ensure-media-processing-job";

export const dynamic = "force-dynamic";

/** Thin normal-cookie adapter over the canonical server-only scheduling service. */
export async function POST(request: Request, context: { params: Promise<{ assetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const { assetId } = await context.params;
  let body: unknown;
  try { body = await request.json(); } catch { return apiError(400, "MEDIA_REQUEST_INVALID", "The media processing request is invalid."); }
  const result = await ensureMediaProcessingJob(actor, { ...(body && typeof body === "object" && !Array.isArray(body) ? body : {}), assetId });
  if (!result.ok) {
    const concealed = result.status === 404 || result.code === "MEDIA_ASSET_NOT_FOUND";
    return apiError(result.status, concealed ? "MEDIA_ASSET_NOT_FOUND" : result.code as "MEDIA_REQUEST_INVALID", concealed ? "The asset was not found." : "The media processing request could not be accepted.");
  }
  return apiSuccess({ jobId: result.job.id, status: result.job.status, deliveryPending: result.deliveryPending, reused: result.reused }, { status: result.status });
}
