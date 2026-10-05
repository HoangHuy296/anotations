import { z } from "zod";
import { apiError } from "@/lib/api-response";
import { readVisualizationMedia } from "@/lib/visualization/media-read";
import { visualizationRead, type VisualizationContext } from "@/lib/visualization/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: VisualizationContext) {
  return visualizationRead(request, context, async (dataset, params) => {
    const variant = z.enum(["THUMBNAIL", "PREVIEW"]).default("PREVIEW").safeParse(new URL(request.url).searchParams.get("variant") ?? undefined);
    if (!variant.success) return apiError(400, "INVALID_REQUEST", "Invalid preview variant.");
    return readVisualizationMedia(dataset.id, params.assetId!, variant.data);
  });
}
