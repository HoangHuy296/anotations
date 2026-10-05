import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

/**
 * specs/028-multi-format-export §1 -- extracted out of
 * coco-export-serializer.ts (specs/027-coco-dataset-export §2, §3) so every
 * interoperable IMAGE export format (COCO, YOLO, and future VOC/LabelMe/
 * CVAT/OpenImages) shares the exact same eligibility predicate, skip-reason
 * accounting, and deterministic ordering -- never a second, format-specific
 * re-implementation of any of it. A format's own serializer takes this
 * resolved, already-classified, already-ordered result and renders its own
 * wire shape (pixel bbox vs. YOLO's center-based normalized coordinates vs.
 * LabelMe's `points`, etc.) -- that per-format rendering is the only thing
 * NOT shared here, by design.
 */

export type ImageExportSkipReason =
  | "wrong_modality"
  | "missing_dimensions"
  | "unsupported_geometry_type"
  | "invalid_geometry"
  | "rejected"
  | "unlabeled"
  | "label_not_in_image_category_set";

export type EligibleImage = { id: number; assetId: string; fileName: string; width: number; height: number };
export type EligibleCategory = { id: number; labelId: string; name: string };

/** Geometry stays canonical-normalized [0,1] here -- pixel/center-based/etc.
 * conversion is each format's own job, not shared. */
export type EligibleAnnotation = {
  annotationId: string;
  imageId: number;
  categoryId: number;
  geometry: { x: number; y: number; width: number; height: number };
  source: string;
  properties: unknown;
  createdAt: Date;
};

export type ImageExportEligibility = {
  images: EligibleImage[];
  categories: EligibleCategory[];
  /** Sorted by (image_id, createdAt, id) -- deterministic, independent of
   *  DB/processing order (spec 027 §3). */
  annotations: EligibleAnnotation[];
  /** Named, exhaustive skip accounting -- never a silent drop (spec 027 §2). */
  skipped: Record<ImageExportSkipReason, number>;
  totalAnnotationsConsidered: number;
};

/** The one place `file_name`/the images[] sort key is derived, so the
 * migration-day switch to `relativePath` (specs/027 §13a) is exactly one
 * line -- add `relativePath: true` to this module's asset `select`. */
export function resolveImageFileName(asset: { filename: string; relativePath?: string | null }): string {
  return asset.relativePath ?? asset.filename;
}

/**
 * Mirrors apps/web/src/lib/validation/annotation-api.ts's `boundingBox`
 * schema exactly (x,y,width,height each normalized [0,1], box within
 * bounds). Duplicated rather than imported: apps/worker cannot import
 * apps/web/src/lib (see the identical precedent/comment in
 * apps/worker/src/jobs/ai-prediction-writer.ts for `normalizeLabelName`).
 * Any future change to the canonical schema must be mirrored here.
 */
export function isValidNormalizedBoundingBox(geometry: unknown): geometry is { x: number; y: number; width: number; height: number } {
  if (!geometry || typeof geometry !== "object") return false;
  const g = geometry as Record<string, unknown>;
  const { x, y, width, height } = g;
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") return false;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  if (width <= 0 || width > 1 || height <= 0 || height > 1) return false;
  if (x + width > 1 || y + height > 1) return false;
  return true;
}

export const emptyImageExportSkipCounts = (): Record<ImageExportSkipReason, number> => ({
  wrong_modality: 0,
  missing_dimensions: 0,
  unsupported_geometry_type: 0,
  invalid_geometry: 0,
  rejected: 0,
  unlabeled: 0,
  label_not_in_image_category_set: 0,
});

/** Resolves eligibility for the full Dataset, or null if it does not exist
 *  / is archived-deleted. */
export async function resolveImageExportEligibility(db: PrismaClient, datasetId: string): Promise<ImageExportEligibility | null> {
  const dataset = await db.dataset.findFirst({ where: { id: datasetId, archivedAt: null, deletedAt: null }, select: { id: true } });
  if (!dataset) return null;

  const eligibleAssetRows = await db.asset.findMany({
    where: { datasetId, modality: "IMAGE", archivedAt: null, deletedAt: null, width: { not: null }, height: { not: null } },
    // MIGRATION-DAY CHANGE: add `relativePath: true` here once BACKFILL/ENFORCE land.
    select: { id: true, filename: true, width: true, height: true },
  });
  // §3: eligible assets sorted by (relativePath-or-filename, id).
  eligibleAssetRows.sort((a, b) => {
    const fa = resolveImageFileName(a);
    const fb = resolveImageFileName(b);
    return fa === fb ? (a.id < b.id ? -1 : 1) : fa < fb ? -1 : 1;
  });
  const imageIdByAssetId = new Map<string, number>();
  eligibleAssetRows.forEach((asset, index) => imageIdByAssetId.set(asset.id, index + 1));
  const images: EligibleImage[] = eligibleAssetRows.map((asset) => ({
    id: imageIdByAssetId.get(asset.id)!, assetId: asset.id, fileName: resolveImageFileName(asset), width: asset.width!, height: asset.height!,
  }));

  const eligibleLabelRows = await db.label.findMany({
    where: { datasetId, scope: "OBJECT", OR: [{ modality: "IMAGE" }, { modality: null }] },
    select: { id: true, name: true, normalizedName: true },
  });
  eligibleLabelRows.sort((a, b) => (a.normalizedName === b.normalizedName ? (a.id < b.id ? -1 : 1) : a.normalizedName < b.normalizedName ? -1 : 1));
  const categoryIdByLabelId = new Map<string, number>();
  eligibleLabelRows.forEach((label, index) => categoryIdByLabelId.set(label.id, index + 1));
  const categories: EligibleCategory[] = eligibleLabelRows.map((label) => ({ id: categoryIdByLabelId.get(label.id)!, labelId: label.id, name: label.name }));

  // Whole-dataset load, classified in JS -- matches the existing precedent in
  // export-manifest.ts's buildExportManifest, and keeps every skip reason
  // mutually exclusive and auditable in one pass, rather than several
  // hand-maintained COUNT() queries that could drift from this list.
  const allAnnotations = await db.annotation.findMany({
    where: { datasetId },
    select: {
      id: true, assetId: true, labelId: true, type: true, status: true, source: true,
      geometry: true, properties: true, createdAt: true,
      asset: { select: { modality: true, archivedAt: true, deletedAt: true, width: true, height: true } },
    },
  });

  const skipped = emptyImageExportSkipCounts();
  const annotations: EligibleAnnotation[] = [];

  for (const annotation of allAnnotations) {
    const asset = annotation.asset;
    if (asset.modality !== "IMAGE" || asset.archivedAt !== null || asset.deletedAt !== null) { skipped.wrong_modality += 1; continue; }
    if (asset.width === null || asset.height === null) { skipped.missing_dimensions += 1; continue; }
    if (annotation.type !== "BOUNDING_BOX") { skipped.unsupported_geometry_type += 1; continue; }
    if (annotation.status === "REJECTED") { skipped.rejected += 1; continue; }
    if (!isValidNormalizedBoundingBox(annotation.geometry)) { skipped.invalid_geometry += 1; continue; }
    if (!annotation.labelId) { skipped.unlabeled += 1; continue; }
    const categoryId = categoryIdByLabelId.get(annotation.labelId);
    if (categoryId === undefined) { skipped.label_not_in_image_category_set += 1; continue; }
    const imageId = imageIdByAssetId.get(annotation.assetId);
    if (imageId === undefined) { skipped.missing_dimensions += 1; continue; } // defensive: asset excluded from images[] for a reason already counted above at the asset level in normal operation

    annotations.push({
      annotationId: annotation.id, imageId, categoryId, geometry: annotation.geometry,
      source: annotation.source, properties: annotation.properties, createdAt: annotation.createdAt,
    });
  }

  // §3: sorted by (image_id, createdAt, id) -- deterministic, independent of
  // DB/processing order. Every format numbers its own annotations[] from
  // this same sorted order.
  annotations.sort((a, b) => {
    if (a.imageId !== b.imageId) return a.imageId - b.imageId;
    const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    return a.annotationId < b.annotationId ? -1 : a.annotationId > b.annotationId ? 1 : 0;
  });

  return { images, categories, annotations, skipped, totalAnnotationsConsidered: allAnnotations.length };
}
