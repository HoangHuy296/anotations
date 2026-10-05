import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { readDatasetModality } from "@/lib/datasets/modality";
import { datasetIdSchema } from "@/lib/validation/dataset";

export const dynamic = "force-dynamic";

/** A safe, authorized Dataset projection; no Asset/query can select an engine. */
export async function GET(_request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const id = datasetIdSchema.safeParse((await context.params).datasetId);
  if (!id.success) return apiError(400, "INVALID_REQUEST", "Dataset identifier is invalid.");
  try {
    const dataset = await readDatasetModality(actor, id.data);
    if (!dataset) return apiError(404, "GITEA_NOT_FOUND", "The dataset was not found.");
    if (dataset.modality === null) return apiError(409, "DATASET_MODALITY_UNRESOLVED", "The dataset modality has not been resolved.", undefined, undefined, { details: { dataset } });
    return apiSuccess(dataset);
  } catch {
    return apiError(500, "INTERNAL_ERROR", "Dataset workspace state is unavailable.");
  }
}
