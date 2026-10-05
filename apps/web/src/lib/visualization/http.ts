import "server-only";
import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { visualizationIdsSchema } from "@/lib/validation/visualization";
import { readVisualizationDataset, VisualizationReadError } from "@/lib/visualization/dataset-read";

export type VisualizationContext = { params: Promise<{ datasetId: string; assetId?: string }> };
export async function visualizationRead(request: Request, context: VisualizationContext,
  read: (dataset: { id: string; name: string }, params: { datasetId: string; assetId?: string }) => Promise<unknown>) {
  const params = visualizationIdsSchema.safeParse(await context.params);
  if (!params.success) return apiError(400, "INVALID_REQUEST", "Invalid dataset or asset ID.");
  try {
    const actor = await getRequestActor();
    const dataset = await readVisualizationDataset(actor, params.data.datasetId);
    const result = await read(dataset, params.data);
    // Recheck after reading/issuing a stream so reopening during I/O fails closed.
    try { await readVisualizationDataset(actor, params.data.datasetId); }
    catch (error) { if (result instanceof Response) await result.body?.cancel(); throw error; }
    return result instanceof Response ? result : apiSuccess(result);
  } catch (error) {
    if (error instanceof VisualizationReadError) return apiError(error.status, error.code, error.message);
    return apiError(503, "INTERNAL_ERROR", "Visualization is temporarily unavailable.");
  }
}
export function queryValues(request: Request) {
  const params = new URL(request.url).searchParams;
  // Reject repeated parameters rather than silently accepting the last one.
  return Object.fromEntries([...params.keys()].map(key => [key, params.getAll(key).length === 1 ? params.get(key) : params.getAll(key)]));
}
