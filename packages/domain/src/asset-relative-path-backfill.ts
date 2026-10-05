import { normalizeAssetRelativePath } from "./asset-relative-path.js";

/**
 * Pure candidate-resolution logic for the specs/027-coco-dataset-export
 * Phase BACKFILL script (scripts/027-backfill-relative-path.ts). Kept
 * separate from that script's DB I/O so it is unit-testable without any
 * database, real or disposable -- the audit's three-way precedence
 * (PreparedImportItem.normalizedPath -> sourcePath minus Dataset
 * .sourceRootPath -> filename), run through the one canonical normalizer,
 * never a SQL re-expression of it (spec §10, §11c).
 */
export type RelativePathCandidateInput = {
  /** From a join to PreparedImportItem on assetId, if one exists. */
  preparedImportNormalizedPath: string | null;
  /** Asset.sourcePath (repository imports only). */
  sourcePath: string | null;
  /** The owning Dataset's sourceRootPath, empty string or null if none. */
  datasetSourceRootPath: string | null;
  /** Asset.filename -- always present, the final fallback. */
  filename: string;
};

export type RelativePathResolution =
  | { ok: true; relativePath: string; source: "PREPARED_IMPORT_ITEM" | "REPOSITORY_SOURCE_PATH" | "PLAIN_UPLOAD_FILENAME" }
  | { ok: false; reason: "UNNORMALIZABLE" };

export function resolveHistoricalCandidateRelativePath(input: RelativePathCandidateInput): RelativePathResolution {
  let raw: string;
  let source: "PREPARED_IMPORT_ITEM" | "REPOSITORY_SOURCE_PATH" | "PLAIN_UPLOAD_FILENAME";

  if (input.preparedImportNormalizedPath !== null) {
    raw = input.preparedImportNormalizedPath;
    source = "PREPARED_IMPORT_ITEM";
  } else if (input.sourcePath !== null) {
    const root = input.datasetSourceRootPath;
    if (root && root !== "" && input.sourcePath === root) {
      raw = input.filename;
    } else if (root && root !== "" && input.sourcePath.startsWith(`${root}/`)) {
      raw = input.sourcePath.slice(root.length + 1);
    } else {
      raw = input.sourcePath;
    }
    source = "REPOSITORY_SOURCE_PATH";
  } else {
    raw = input.filename;
    source = "PLAIN_UPLOAD_FILENAME";
  }

  const normalized = normalizeAssetRelativePath(raw);
  if (normalized === null) return { ok: false, reason: "UNNORMALIZABLE" };
  return { ok: true, relativePath: normalized, source };
}
