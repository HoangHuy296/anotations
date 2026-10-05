import { readVisualizationSchema } from "@/lib/visualization/schema-read";
import { visualizationRead, type VisualizationContext, queryValues } from "@/lib/visualization/http";
import { visualizationPageSchema } from "@/lib/validation/visualization";
import { apiError } from "@/lib/api-response";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: VisualizationContext) {
  return visualizationRead(request, context, async (dataset) => {
    const query = visualizationPageSchema.safeParse(queryValues(request));
    if (!query.success) return apiError(400, "INVALID_REQUEST", "Invalid visualization query.");
    return readVisualizationSchema(dataset.id, query.data.page, query.data.pageSize);
  });
}
