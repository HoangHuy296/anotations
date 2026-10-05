import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

import { resolveImageExportEligibility } from "./image-export-eligibility.js";
import type { ImageExportSkipReason } from "./image-export-eligibility.js";
import { buildZipArchive, type ZipEntry } from "./zip-writer.js";

/**
 * Dataset -> YOLO export (specs/028-multi-format-export §6, §10).
 *
 * Implemented against YOLO's own independently documented public format --
 * NOT a captured AIOZ `/format` sample (none exists for this formatter; see
 * spec 028 §7). `aiozVerified: false` in the capability matrix reflects
 * this; do not claim provider compatibility without a real sample to check
 * against.
 *
 * Shares eligibility/skip-reason/ordering with every other interoperable
 * image format via `image-export-eligibility.ts` (specs/028 §1) -- this
 * file is only YOLO's own rendering: center-based normalized coordinates,
 * 0-based class indices, one `.txt` label file per eligible image (written
 * even when empty), a `classes.txt`, packaged as a deterministic ZIP.
 *
 * FROZEN DECISIONS (specs/028 §10's YOLO checklist):
 *  - Class index = category.id - 1 (the shared resolver's category ids are
 *    1-based, matching COCO; YOLO's own convention is 0-based).
 *  - Canonical geometry (x,y,width,height, all normalized [0,1] by image
 *    dimensions) requires NO pixel conversion for YOLO -- unlike COCO, YOLO
 *    itself normalizes by image width/height, so the canonical model and
 *    YOLO's wire format agree on normalization; only the anchor point
 *    differs (top-left corner vs. center).
 *  - x_center = x + width/2, y_center = y + height/2, width/height
 *    unchanged.
 *  - Coordinates formatted to exactly 6 decimal places (fixed width, never
 *    trailing-zero-stripped) -- a common, unambiguous YOLO-ecosystem
 *    convention, and fully deterministic.
 *  - Every eligible image gets exactly one label file, even with zero
 *    eligible annotations (written empty, not omitted) -- "one label file
 *    per eligible image" is a hard invariant, not a convenience.
 *  - Label file paths mirror each image's `fileName` (relativePath-or-
 *    filename), directory structure preserved, extension replaced with
 *    `.txt`, under a top-level `labels/` folder (the standard YOLO/
 *    Ultralytics `images/`+`labels/` parallel-tree convention -- this
 *    archive never contains the images themselves, matching COCO's own
 *    scope of referencing assets by name, not embedding their bytes).
 *  - COLLISION SAFETY, tested explicitly: since `relativePath` has not
 *    landed yet (specs/027 §13a), `fileName` today can genuinely collide
 *    across different real assets (that's the whole reason 027 exists).
 *    Two eligible images whose candidate label path would collide are
 *    BOTH deterministically disambiguated by appending `_<imageId>` to
 *    every member of the colliding group (symmetric, order-independent) --
 *    never a silent last-write-wins overwrite inside the archive. Once
 *    `relativePath` lands and is unique among live Assets, this branch
 *    becomes structurally unreachable for new data, but stays as a
 *    permanent safety net.
 *  - Archive entries are written in one fixed order: `classes.txt` first,
 *    then labels in image-id order (1..N) -- deterministic across runs.
 *  - No storage keys, signed URLs, MinIO details, or provider/task data
 *    anywhere in the artifact -- the shared eligibility resolver never
 *    surfaces any of that in the first place.
 */

const COORDINATE_PRECISION = 6;

function formatCoordinate(value: number): string {
  return value.toFixed(COORDINATE_PRECISION);
}

/** Strips a trailing extension from the LAST path segment only -- a dot
 * inside a directory name is never mistaken for an extension separator. */
function stripExtension(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  return lastDot > lastSlash ? path.slice(0, lastDot) : path;
}

export type YoloExportResult = {
  archive: Buffer;
  skipped: Record<ImageExportSkipReason, number>;
  totalAnnotationsConsidered: number;
  imageCount: number;
  annotationCount: number;
};

/** Builds the full Dataset YOLO export, or null if the Dataset does not exist / is archived-deleted. */
export async function buildYoloDatasetExport(db: PrismaClient, datasetId: string): Promise<YoloExportResult | null> {
  const eligibility = await resolveImageExportEligibility(db, datasetId);
  if (!eligibility) return null;

  // classes.txt: category order is already deterministic (normalizedName,
  // id) from the shared resolver; 0-based index = category.id - 1.
  const classesContent = eligibility.categories.length
    ? `${eligibility.categories.map((category) => category.name).join("\n")}\n`
    : "";

  // Label path assignment, collision-safe (see module docstring).
  const candidateByImageId = new Map<number, string>();
  for (const image of eligibility.images) candidateByImageId.set(image.id, `${stripExtension(image.fileName)}.txt`);
  const imageIdsByCandidate = new Map<string, number[]>();
  for (const [imageId, candidate] of candidateByImageId) {
    const group = imageIdsByCandidate.get(candidate) ?? [];
    group.push(imageId);
    imageIdsByCandidate.set(candidate, group);
  }
  const labelPathByImageId = new Map<number, string>();
  for (const [candidate, imageIds] of imageIdsByCandidate) {
    if (imageIds.length === 1) {
      labelPathByImageId.set(imageIds[0], candidate);
      continue;
    }
    // Collision: every member of the group is disambiguated, not just the
    // second one -- symmetric and deterministic regardless of image order.
    for (const imageId of imageIds) {
      labelPathByImageId.set(imageId, `${stripExtension(candidateByImageId.get(imageId)!)}_${imageId}.txt`);
    }
  }

  // Group eligible annotations by image, preserving the shared deterministic order.
  const linesByImageId = new Map<number, string[]>();
  for (const image of eligibility.images) linesByImageId.set(image.id, []);
  for (const annotation of eligibility.annotations) {
    const classIndex = annotation.categoryId - 1;
    const xCenter = annotation.geometry.x + annotation.geometry.width / 2;
    const yCenter = annotation.geometry.y + annotation.geometry.height / 2;
    const line = [
      classIndex,
      formatCoordinate(xCenter),
      formatCoordinate(yCenter),
      formatCoordinate(annotation.geometry.width),
      formatCoordinate(annotation.geometry.height),
    ].join(" ");
    linesByImageId.get(annotation.imageId)!.push(line);
  }

  const entries: ZipEntry[] = [{ path: "classes.txt", content: Buffer.from(classesContent, "utf8") }];
  for (const image of eligibility.images) {
    // eligibility.images is already sorted by (fileName-or-relativePath, id).
    const lines = linesByImageId.get(image.id)!;
    const content = lines.length ? `${lines.join("\n")}\n` : "";
    entries.push({ path: `labels/${labelPathByImageId.get(image.id)!}`, content: Buffer.from(content, "utf8") });
  }

  return {
    archive: buildZipArchive(entries),
    skipped: eligibility.skipped,
    totalAnnotationsConsidered: eligibility.totalAnnotationsConsidered,
    imageCount: eligibility.images.length,
    annotationCount: eligibility.annotations.length,
  };
}
