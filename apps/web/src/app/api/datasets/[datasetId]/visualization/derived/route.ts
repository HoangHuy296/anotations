import { readPublishedProfile } from "@/lib/visualization/snapshot-read";
import { visualizationRead, queryValues, type VisualizationContext } from "@/lib/visualization/http";
import { visualizationPageSchema } from "@/lib/validation/visualization";
import { apiError } from "@/lib/api-response";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: VisualizationContext) {
  return visualizationRead(request, context, async dataset => {
    const query = visualizationPageSchema.safeParse(queryValues(request));
    if (!query.success) return apiError(400, "INVALID_REQUEST", "Invalid pagination.");
    return readPublishedProfile(dataset.id);
  });
}
