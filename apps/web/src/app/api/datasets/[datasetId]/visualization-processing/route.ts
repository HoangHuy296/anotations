import { z } from "zod";
import { getRequestActor } from "@/lib/auth";
import { apiError, apiSuccess } from "@/lib/api-response";
import { datasetIdSchema } from "@/lib/validation/dataset";
import { requestVisualizationProcessing } from "@/lib/visualization/processing-service";
export async function POST(request: Request, context: { params: Promise<{ datasetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const { datasetId } = await context.params;
  if (!datasetIdSchema.safeParse(datasetId).success || !z.object({}).strict().safeParse(await request.json().catch(() => null)).success) return apiError(400, "INVALID_REQUEST", "Invalid processing request.");
  try {
  const result = await requestVisualizationProcessing(actor, datasetId);
  if (!result.ok) return apiError(result.status, result.status === 404 ? "DATASET_NOT_FOUND" : "DATASET_NOT_COMPLETED", "Processing cannot be requested for this dataset.");
  return apiSuccess({ ...result.job, deliveryPending: result.deliveryPending }, { status: result.status });
  } catch { return apiError(503, "INTERNAL_ERROR", "Processing is temporarily unavailable."); }
}
