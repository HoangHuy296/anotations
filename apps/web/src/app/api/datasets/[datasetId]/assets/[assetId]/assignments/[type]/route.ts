import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { AssetAssignmentError, enqueueAssignmentDispatches, removeAssetAssignment, upsertAssetAssignment } from "@/lib/collaboration/asset-assignment-service";
import { assetAssignmentTypeSchema, assetAssignmentWriteSchema, collaborationRouteParamsSchema } from "@/lib/validation/collaboration";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ datasetId: string; assetId: string; type: string }> };
async function input(context: Context) {
  const actor = await getRequestActor();
  if (!actor) return { response: apiError(401, "AUTH_REQUIRED", "Authentication is required.") } as const;
  const params = await context.params;
  const ids = collaborationRouteParamsSchema.pick({ datasetId: true, assetId: true }).safeParse({ datasetId: params.datasetId, assetId: params.assetId });
  const type = assetAssignmentTypeSchema.safeParse(params.type);
  if (!ids.success || !ids.data.assetId || !type.success) return { response: apiError(400, "INVALID_REQUEST", "Dataset, asset, or assignment type is invalid.") } as const;
  return { actor, datasetId: ids.data.datasetId, assetId: ids.data.assetId, type: type.data } as const;
}
function errorResponse(error: unknown) {
  if (!(error instanceof AssetAssignmentError)) throw error;
  if (error.code === "NOT_FOUND") return apiError(404, "ASSET_NOT_IN_DATASET", "The asset was not found.");
  if (error.code === "FORBIDDEN") return apiError(403, "FORBIDDEN", error.message);
  return apiError(409, "INVALID_ASSIGNEE", error.message);
}
export async function PUT(request: Request, context: Context) {
  const result = await input(context); if ("response" in result) return result.response;
  const body = assetAssignmentWriteSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError(400, "INVALID_REQUEST", "Assignment input is invalid.", body.error.flatten().fieldErrors);
  try {
    const assignment = await upsertAssetAssignment(result.actor, { ...result, userId: body.data.userId });
    await enqueueAssignmentDispatches(assignment);
    return apiSuccess({ assignmentId: assignment.assignmentId, type: assignment.type, userId: assignment.userId }, { status: assignment.reused ? 200 : 201 });
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(_request: Request, context: Context) {
  const result = await input(context); if ("response" in result) return result.response;
  try {
    const removed = await removeAssetAssignment(result.actor, result);
    await enqueueAssignmentDispatches(removed);
    return apiSuccess({ removed: removed.removed });
  } catch (error) { return errorResponse(error); }
}
