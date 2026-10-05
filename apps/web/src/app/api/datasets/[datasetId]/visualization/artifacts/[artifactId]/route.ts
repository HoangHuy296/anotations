import { artifactIdSchema } from "@annotationplatform/domain/visualization-processing";
import { readSnapshotArtifact } from "@/lib/visualization/snapshot-read";
import { visualizationRead, queryValues } from "@/lib/visualization/http";
import { visualizationPageSchema } from "@/lib/validation/visualization";
import { apiError } from "@/lib/api-response";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ datasetId: string; artifactId: string }> }) {
  return visualizationRead(request, context, async dataset => {
    const id = artifactIdSchema.safeParse((await context.params).artifactId);
    const query = visualizationPageSchema.safeParse(queryValues(request));
    if (!id.success || !query.success) return apiError(400, "INVALID_REQUEST", "Invalid snapshot/artifact request.");
    return readSnapshotArtifact(dataset.id, id.data);
  });
}
