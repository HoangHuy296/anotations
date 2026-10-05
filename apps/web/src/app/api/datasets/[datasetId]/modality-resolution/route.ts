import { datasetModalityResolutionInputSchema, isModalityTransactionConflict } from "@annotationplatform/domain";
import { getRequestActor } from "@/lib/auth";
import { apiError, apiSuccess } from "@/lib/api-response";
import { datasetIdSchema } from "@/lib/validation/dataset";
import { resolveEmptyDataset } from "@/lib/datasets/modality";

export const dynamic = "force-dynamic";
const bodySchema = datasetModalityResolutionInputSchema;
export async function POST(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const { datasetId } = await context.params;
  const input = bodySchema.safeParse(await request.json().catch(() => null));
  if (!datasetIdSchema.safeParse(datasetId).success || !input.success) return apiError(400, "INVALID_REQUEST", "Choose a valid dataset modality.");
  try {
    const result = await resolveEmptyDataset(actor, datasetId, input.data.modality);
    return result.ok ? apiSuccess(result.data) : apiError(result.status, result.code, "The dataset modality could not be resolved.");
  } catch (error) {
    return isModalityTransactionConflict(error)
      ? apiError(409, "DATASET_MODALITY_CONFLICT", "Dataset changed during resolution. Please retry.")
      : apiError(500, "INTERNAL_ERROR", "The dataset modality could not be resolved.");
  }
}
