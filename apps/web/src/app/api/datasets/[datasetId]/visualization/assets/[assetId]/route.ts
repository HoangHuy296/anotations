import { readVisualizationAsset } from "@/lib/visualization/asset-read";
import { visualizationRead, type VisualizationContext } from "@/lib/visualization/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: VisualizationContext) {
  return visualizationRead(request, context, async (dataset, params) => {
    return readVisualizationAsset(dataset.id, params.assetId!);
  });
}
