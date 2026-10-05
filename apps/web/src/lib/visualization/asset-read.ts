import "server-only";
import { db } from "@/lib/db";
import type { VisualizationAssetsQuery } from "@/lib/validation/visualization";
import { projectAnnotation } from "@/lib/visualization/annotation-adapter";
import { VisualizationReadError } from "@/lib/visualization/dataset-read";
import type { ViewerAsset, ViewerAssetDetail } from "@/types/visualization";

export const liveAssets = { deletedAt: null, archivedAt: null } as const;
export const labelSelect = { id: true, name: true, color: true } as const;
const assetSelect = { id: true, filename: true, modality: true, width: true, height: true,
  mimeType: true, storageProvider: true, storageBucket: true, storageKey: true } as const;
export const supportedImageMimeTypes = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
function projectAsset(row: Awaited<ReturnType<typeof findAsset>> & {}) : ViewerAsset {
  return { row_id: row.id, filename: row.filename, modality: row.modality, width: row.width, height: row.height,
    mediaAvailable: row.modality === "IMAGE" && supportedImageMimeTypes.includes(row.mimeType) && row.storageProvider === "MINIO" && Boolean(row.storageBucket && row.storageKey) };
}
export async function findAsset(datasetId: string, assetId: string) {
  return db.asset.findFirst({ where: { datasetId, id: assetId, ...liveAssets }, select: assetSelect });
}
/** Internal reads: callers must pass the fresh endpoint guard before use. */
export async function readVisualizationAssets(datasetId: string, query: VisualizationAssetsQuery) {
  const where = { datasetId, ...liveAssets,
    ...(query.modality === "ALL" ? {} : { modality: query.modality }),
    ...(query.q ? { filename: { contains: query.q, mode: "insensitive" as const } } : {}),
    ...(query.labelId ? { annotations: { some: { datasetId, labelId: query.labelId } } } : {}),
  };
  const [rows, total] = await Promise.all([
    db.asset.findMany({ where, select: assetSelect, orderBy: [{ [query.sort]: query.order }, { id: "asc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    db.asset.count({ where }),
  ]);
  return { items: rows.map(projectAsset), total, page: query.page, pageSize: query.pageSize };
}
export async function readVisualizationAsset(datasetId: string, assetId: string): Promise<ViewerAssetDetail> {
  const asset = await findAsset(datasetId, assetId);
  if (!asset) throw new VisualizationReadError(404, "ASSET_NOT_IN_DATASET", "Asset not found in this dataset.");
  const where = { datasetId, assetId };
  const [annotations, annotationCount] = await Promise.all([
    db.annotation.findMany({ where, select: { id: true, type: true, revision: true, geometry: true, label: { select: labelSelect } }, orderBy: { id: "asc" }, take: 500 }),
    db.annotation.count({ where }),
  ]);
  return { ...projectAsset(asset), annotations: annotations.map(row => projectAnnotation(row, asset.width, asset.height)), annotationCount, annotationsTruncated: annotationCount > annotations.length };
}
