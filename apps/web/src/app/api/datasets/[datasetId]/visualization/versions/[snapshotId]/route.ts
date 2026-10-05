import { snapshotIdSchema } from "@annotationplatform/domain/visualization-processing";
import { readSnapshotContent } from "@/lib/visualization/snapshot-read";
import { visualizationRead, queryValues } from "@/lib/visualization/http";
import { visualizationPageSchema } from "@/lib/validation/visualization";
import { apiError } from "@/lib/api-response";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ datasetId: string; snapshotId: string }> }) {
  return visualizationRead(request, context, async dataset => {
    const id = snapshotIdSchema.safeParse((await context.params).snapshotId);
    const query = visualizationPageSchema.safeParse(queryValues(request));
    if (!id.success || !query.success) return apiError(400, "INVALID_REQUEST", "Invalid snapshot/artifact request.");
    return readSnapshotContent(dataset.id, id.data, query.data.page, query.data.pageSize);
  });
}
