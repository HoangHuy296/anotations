import { readVisualizationAssets } from "@/lib/visualization/asset-read";
import { visualizationRead, type VisualizationContext, queryValues } from "@/lib/visualization/http";
import { visualizationAssetsQuerySchema } from "@/lib/validation/visualization";
import { apiError } from "@/lib/api-response";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: VisualizationContext) {
  return visualizationRead(request, context, async (dataset) => {
    const query = visualizationAssetsQuerySchema.safeParse(queryValues(request));
    if (!query.success) return apiError(400, "INVALID_REQUEST", "Invalid visualization query.");
    return readVisualizationAssets(dataset.id, query.data);
  });
}
