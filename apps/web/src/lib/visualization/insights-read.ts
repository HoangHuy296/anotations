import "server-only";
import { db } from "@/lib/db";
import { labelSelect, liveAssets } from "@/lib/visualization/asset-read";
import type { ViewerInsights } from "@/types/visualization";

export async function readVisualizationInsights(datasetId: string): Promise<ViewerInsights> {
  const assets = { datasetId, ...liveAssets };
  const annotations = { datasetId, asset: assets };
  const [assetCount, imageCount, annotationCount, grouped, dimensions] = await Promise.all([
    db.asset.count({ where: assets }), db.asset.count({ where: { ...assets, modality: "IMAGE" } }),
    db.annotation.count({ where: annotations }),
    db.annotation.groupBy({ by: ["labelId"], where: annotations, _count: { id: true }, orderBy: [{ _count: { id: "desc" } }, { labelId: "asc" }], take: 51 }),
    db.asset.aggregate({ where: { ...assets, modality: "IMAGE", width: { gt: 0 }, height: { gt: 0 } }, _count: { id: true }, _min: { width: true, height: true }, _max: { width: true, height: true } }),
  ]);
  const groups = grouped.slice(0, 50);
  const labels = await db.label.findMany({ where: { datasetId, id: { in: groups.flatMap(row => row.labelId ? [row.labelId] : []) } }, select: labelSelect });
  return { assetCount, imageCount, unsupportedCount: assetCount - imageCount, annotationCount,
    labelDistribution: groups.map(row => ({ label: labels.find(label => label.id === row.labelId) ?? null, count: row._count.id })), distributionTruncated: grouped.length > 50,
    dimensions: { count: dimensions._count.id, minWidth: dimensions._min.width, maxWidth: dimensions._max.width, minHeight: dimensions._min.height, maxHeight: dimensions._max.height } };
}
