import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { readAssetActivity } from "@/lib/collaboration/activity-projection-service";

export async function GET(_request: Request, context: { params: Promise<{ datasetId: string; assetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const { datasetId, assetId } = await context.params;
  const items = await readAssetActivity(actor, datasetId, assetId);
  return items ? apiSuccess({ items }) : apiError(404, "ASSET_NOT_IN_DATASET", "The asset was not found.");
}
