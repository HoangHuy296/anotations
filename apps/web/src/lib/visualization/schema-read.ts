import "server-only";
import { db } from "@/lib/db";
import { labelSelect } from "@/lib/visualization/asset-read";

export async function readVisualizationSchema(datasetId: string, page: number, pageSize: number) {
  const [items, total] = await Promise.all([
    db.label.findMany({ where: { datasetId }, select: labelSelect, orderBy: { id: "asc" }, skip: (page - 1) * pageSize, take: pageSize }),
    db.label.count({ where: { datasetId } }),
  ]);
  return { fields: [
    { name: "row_id", type: "Asset.id (string)" }, { name: "filename", type: "string" },
    { name: "modality", type: "IMAGE | VIDEO | AUDIO | TEXT" }, { name: "width / height", type: "Original pixels (integer or null)" },
    { name: "mediaAvailable", type: "boolean (eligible stored image; object existence checked on read)" },
    { name: "annotations[].id", type: "Annotation.id (string)" }, { name: "annotations[].type", type: "Persisted annotation type (string)" },
    { name: "annotations[].revision", type: "integer" }, { name: "annotations[].geometry", type: "Normalized xywh 0..1, or null when overlay unavailable" },
    { name: "annotations[].overlayUnavailable", type: "string or null" },
    { name: "annotations[].label", type: "{ id: Label.id, name: string, color: string } or null" },
    { name: "annotationCount / annotationsTruncated", type: "integer / boolean; at most 500 annotations per asset detail" },
  ], labels: { items, total, page, pageSize } };
}
