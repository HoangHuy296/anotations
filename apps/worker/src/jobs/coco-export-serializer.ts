import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

import { resolveImageExportEligibility } from "./image-export-eligibility.js";
import type { ImageExportSkipReason } from "./image-export-eligibility.js";

/**
 * Dataset -> COCO export (specs/027-coco-dataset-export §2, §3).
 *
 * This is a *plain* COCO document ({images, annotations, categories}),
 * generated once from canonical PostgreSQL Asset/Label/Annotation state --
 * never from the external AIOZ provider's `/tasks/result/{id}/format`
 * endpoint, which formats a single AiTask's own result and is a different
 * capability with different semantics (see spec §0). Manual, AI, and
 * imported annotations go through this exact same serializer; an AI
 * annotation a user has since edited exports its current row, not any
 * historical provider payload.
 *
 * Refactored (specs/028-multi-format-export §1): eligibility/skip-reason/
 * ordering logic now lives in `image-export-eligibility.ts`, shared by
 * every interoperable image format. This file is now only COCO's own
 * rendering: pixel bbox/area conversion, the `score` field, and the exact
 * COCO wire shape. Behavior is unchanged -- the eligibility rules, skip
 * reasons, and deterministic ordering are byte-for-byte what they were
 * before the extraction (confirmed by rerunning this file's existing tests
 * unmodified).
 */

/** Re-exported for backward compatibility -- existing callers/tests import
 * this name from this module; the canonical implementation now lives in
 * image-export-eligibility.ts, shared by every image format. */
export { resolveImageFileName as resolveCocoFileName } from "./image-export-eligibility.js";

export type CocoSkipReason = ImageExportSkipReason;

export type CocoExportResult = {
  document: {
    images: Array<{ id: number; file_name: string; width: number; height: number }>;
    annotations: Array<{
      id: number;
      image_id: number;
      category_id: number;
      bbox: [number, number, number, number];
      area: number;
      iscrowd: 0;
      score?: number;
    }>;
    categories: Array<{ id: number; name: string }>;
  };
  /** Named, exhaustive skip accounting -- never a silent drop (spec §2). */
  skipped: Record<CocoSkipReason, number>;
  totalAnnotationsConsidered: number;
};

function isFiniteUnitScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Builds the full Dataset COCO export, or null if the Dataset does not exist / is archived-deleted. */
export async function buildCocoDatasetExport(db: PrismaClient, datasetId: string): Promise<CocoExportResult | null> {
  const eligibility = await resolveImageExportEligibility(db, datasetId);
  if (!eligibility) return null;

  const imageById = new Map(eligibility.images.map((image) => [image.id, image]));
  const rendered = eligibility.annotations.map((annotation) => {
    const image = imageById.get(annotation.imageId)!;
    const pixelWidth = annotation.geometry.width * image.width;
    const pixelHeight = annotation.geometry.height * image.height;
    const bbox: [number, number, number, number] = [annotation.geometry.x * image.width, annotation.geometry.y * image.height, pixelWidth, pixelHeight];
    const area = pixelWidth * pixelHeight;
    const properties = annotation.properties as { confidence?: unknown } | null;
    const score = annotation.source === "AI" && isFiniteUnitScore(properties?.confidence) ? properties!.confidence as number : undefined;
    return { imageId: annotation.imageId, categoryId: annotation.categoryId, bbox, area, score };
  });

  return {
    document: {
      images: eligibility.images.map((image) => ({ id: image.id, file_name: image.fileName, width: image.width, height: image.height })),
      annotations: rendered.map((row, index) => ({
        id: index + 1,
        image_id: row.imageId,
        category_id: row.categoryId,
        bbox: row.bbox,
        area: row.area,
        iscrowd: 0 as const,
        ...(row.score !== undefined ? { score: row.score } : {}),
      })),
      categories: eligibility.categories.map((category) => ({ id: category.id, name: category.name })),
    },
    skipped: eligibility.skipped,
    totalAnnotationsConsidered: eligibility.totalAnnotationsConsidered,
  };
}
