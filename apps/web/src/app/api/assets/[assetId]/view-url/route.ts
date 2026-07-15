import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";
import { VIEW_CAPABILITY_TTL_SECONDS } from "@/lib/upload-capability";

export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ assetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const { assetId } = await context.params;
  const asset = await db.asset.findFirst({
    where: { id: assetId, deletedAt: null, archivedAt: null },
    select: { id: true, datasetId: true, storageProvider: true, storageBucket: true, storageKey: true },
  });
  if (!asset) return apiError(404, "GITEA_NOT_FOUND", "The asset was not found.");
  const access = await requireDatasetPermission(actor, asset.datasetId, "dataset.read");
  if (!access) return apiError(404, "GITEA_NOT_FOUND", "The asset was not found.");
  if (access.forbidden) return apiError(403, "FORBIDDEN", "You do not have permission to view this asset.");
  if (!asset.storageBucket || !asset.storageKey || asset.storageProvider !== "MINIO") return apiError(409, "ASSET_UNAVAILABLE", "The asset object is unavailable.");

  try {
    const { publicMinio, minio } = getDirectUploadProviders();
    await minio.statObject(asset.storageBucket, asset.storageKey);
    const viewUrl = await publicMinio.presignedGetObject(asset.storageBucket, asset.storageKey, VIEW_CAPABILITY_TTL_SECONDS);
    return apiSuccess({ viewUrl, expiresAt: new Date(Date.now() + VIEW_CAPABILITY_TTL_SECONDS * 1000).toISOString() });
  } catch {
    return apiError(409, "ASSET_UNAVAILABLE", "The asset object is unavailable.");
  }
}
