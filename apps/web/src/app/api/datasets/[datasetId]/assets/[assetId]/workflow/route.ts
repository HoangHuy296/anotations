import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { datasetIdSchema } from "@/lib/validation/dataset";
import { assetWorkflowActionRequestSchema } from "@/lib/validation/asset-workflow";
import { applyAssetWorkflowAction, enqueueWorkflowDispatches, getAssetWorkflow, type WorkflowFailure } from "@/lib/workflow/asset-workflow-service";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ datasetId: string; assetId: string }> };

function failureResponse(failure: WorkflowFailure) {
  switch (failure.kind) {
    case "NOT_FOUND": return apiError(404, "ASSET_NOT_IN_DATASET", "The asset was not found.");
    case "FORBIDDEN": return apiError(403, "FORBIDDEN", "You do not have permission for this action.");
    case "INVALID_TRANSITION": return apiError(409, "INVALID_TRANSITION", "This action is not valid for the asset's current workflow state.");
    case "STALE_REVISION": return apiError(409, "STALE_REVISION", "This asset changed after you loaded it. Reload before making a review decision.", undefined, undefined, { currentRevision: failure.currentRevision });
  }
}

async function ids(context: Context) {
  const { datasetId, assetId } = await context.params;
  const parsedDataset = datasetIdSchema.safeParse(datasetId);
  if (!parsedDataset.success || !assetId) return null;
  return { datasetId: parsedDataset.data, assetId };
}

export async function GET(_request: Request, context: Context) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const routeIds = await ids(context);
  if (!routeIds) return apiError(400, "INVALID_REQUEST", "Dataset or asset identifier is invalid.");
  const result = await getAssetWorkflow(actor, routeIds.datasetId, routeIds.assetId);
  return result.ok ? apiSuccess({ asset: result.asset, history: result.history }) : failureResponse(result.failure);
}

export async function POST(request: Request, context: Context) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const routeIds = await ids(context);
  if (!routeIds) return apiError(400, "INVALID_REQUEST", "Dataset or asset identifier is invalid.");
  const parsed = assetWorkflowActionRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "Workflow action input is invalid.", parsed.error.flatten().fieldErrors);
  const result = await applyAssetWorkflowAction(actor, routeIds.datasetId, routeIds.assetId, parsed.data);
  if (!result.ok) return failureResponse(result.failure);
  await enqueueWorkflowDispatches(result);
  return apiSuccess({ asset: result.asset, event: result.event });
}
