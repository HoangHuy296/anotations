import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { db } from "@/lib/db";
import { readSafeMediaReadiness } from "@/lib/media-processing/safe-media-readiness";

export const dynamic = "force-dynamic";

/** Thin normal-cookie adapter; the readiness service owns authorization and DTO projection. */
export async function GET(_: Request, context: { params: Promise<{ assetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const { assetId } = await context.params;
  // Resolve the Dataset internally; never accept it from a browser query/body.
  const asset = await db.asset.findFirst({ where: { id: assetId, deletedAt: null, archivedAt: null }, select: { datasetId: true } });
  if (!asset) return apiError(404, "MEDIA_ASSET_NOT_FOUND", "The asset was not found.");
  const readiness = await readSafeMediaReadiness(actor, asset.datasetId, assetId);
  if (!readiness) return apiError(404, "MEDIA_ASSET_NOT_FOUND", "The asset was not found.");
  return apiSuccess(readiness);
}
