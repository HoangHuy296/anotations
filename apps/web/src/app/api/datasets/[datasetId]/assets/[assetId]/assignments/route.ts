import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { AssetAssignmentError, getAssetAssignments } from "@/lib/collaboration/asset-assignment-service";
import { collaborationRouteParamsSchema } from "@/lib/validation/collaboration";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ datasetId: string; assetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const parsed = collaborationRouteParamsSchema.pick({ datasetId: true, assetId: true }).safeParse(await context.params);
  if (!parsed.success || !parsed.data.assetId) return apiError(400, "INVALID_REQUEST", "Dataset or asset identifier is invalid.");
  try { return apiSuccess(await getAssetAssignments(actor, { datasetId: parsed.data.datasetId, assetId: parsed.data.assetId })); }
  catch (error) {
    if (error instanceof AssetAssignmentError) return error.code === "NOT_FOUND" ? apiError(404, "ASSET_NOT_IN_DATASET", "The asset was not found.") : apiError(403, "FORBIDDEN", error.message);
    throw error;
  }
}
