import { readVisualizationInsights } from "@/lib/visualization/insights-read";
import { visualizationRead, type VisualizationContext } from "@/lib/visualization/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: VisualizationContext) {
  return visualizationRead(request, context, async (dataset) => {
    return readVisualizationInsights(dataset.id);
  });
}
