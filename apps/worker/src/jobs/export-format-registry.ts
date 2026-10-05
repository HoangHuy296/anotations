import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import type { ExportFormat } from "@annotationplatform/domain/export-format-capability";

import { buildCocoDatasetExport } from "./coco-export-serializer.js";
import { buildYoloDatasetExport } from "./yolo-export-serializer.js";

/**
 * specs/028-multi-format-export §5 -- worker-side dispatch, keyed off the
 * same `ExportFormat` union the shared capability matrix uses. A format
 * reaching this dispatcher without a registered serializer is a programming
 * error (API validation, driven by the same matrix, should make it
 * unreachable), not a silent no-op -- `getExportArtifactBuilder` returns
 * `undefined` for anything not registered, and callers treat that as a
 * hard failure, never a fallback format.
 *
 * Every builder returns either a single JSON-serializable document
 * (`kind: "single-file"`) or a pre-built archive Buffer (`kind: "archive"`)
 * -- the job processor picks the artifact key/content-type from `kind`,
 * never from the format name via another `if (format === ...)` branch.
 */
export type ExportArtifactResult =
  | { kind: "single-file"; document: unknown; skipped: Record<string, number>; totalItems: number; exportedAnnotationCount: number }
  | { kind: "archive"; archive: Buffer; skipped: Record<string, number>; totalItems: number; exportedAnnotationCount: number };

type ExportArtifactBuilder = (db: PrismaClient, datasetId: string) => Promise<ExportArtifactResult | null>;

const EXPORT_ARTIFACT_BUILDERS: Partial<Record<ExportFormat, ExportArtifactBuilder>> = {
  COCO: async (db, datasetId) => {
    const result = await buildCocoDatasetExport(db, datasetId);
    if (!result) return null;
    // Preserves the exact pre-registry COCO progress-total formula
    // (images + annotations + categories actually produced) -- this
    // refactor changes no observable COCO behavior.
    const totalItems = result.document.images.length + result.document.annotations.length + result.document.categories.length;
    return { kind: "single-file", document: result.document, skipped: result.skipped, totalItems, exportedAnnotationCount: result.document.annotations.length };
  },
  YOLO: async (db, datasetId) => {
    const result = await buildYoloDatasetExport(db, datasetId);
    if (!result) return null;
    const totalItems = result.imageCount + result.annotationCount;
    return { kind: "archive", archive: result.archive, skipped: result.skipped, totalItems, exportedAnnotationCount: result.annotationCount };
  },
};

export function getExportArtifactBuilder(format: ExportFormat): ExportArtifactBuilder | undefined {
  return EXPORT_ARTIFACT_BUILDERS[format];
}
