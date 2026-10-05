import { aiBatchJobInputV1Schema } from "@annotationplatform/domain/ai-batch";

import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Finds the newest in-flight AI task that targets this authorized workspace asset. */
export async function GET(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const params = new URL(request.url).searchParams;
  const datasetId = params.get("datasetId");
  const assetId = params.get("assetId");
  if (!datasetId || !assetId || datasetId.length > 128 || assetId.length > 128) return apiError(400, "INVALID_REQUEST", "A dataset and asset are required.");
  const access = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!access) return apiError(404, "DATASET_NOT_FOUND", "The dataset was not found.");
  if (access.forbidden) return apiError(403, "FORBIDDEN", "You do not have permission to read this dataset.");
  const belongs = await db.asset.findFirst({ where: { id: assetId, datasetId, deletedAt: null, archivedAt: null }, select: { id: true } });
  if (!belongs) return apiError(404, "ASSET_NOT_IN_DATASET", "The asset was not found in this dataset.");
  const candidates = await db.aiTask.findMany({
    where: { datasetId, modality: { in: ["IMAGE", "VIDEO"] }, status: { in: ["QUEUED", "RUNNING"] }, job: { status: { in: ["QUEUED", "RUNNING"] } } },
    orderBy: { createdAt: "desc" }, take: 20,
    select: { id: true, job: { select: { input: true } } },
  });
  for (const candidate of candidates) {
    const input = aiBatchJobInputV1Schema.safeParse(candidate.job.input);
    if (input.success && input.data.datasetId === datasetId && input.data.targets.some((target) => target.assetId === assetId)) return apiSuccess({ taskId: candidate.id });
  }
  return apiSuccess({ taskId: null });
}
