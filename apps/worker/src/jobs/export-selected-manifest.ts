import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { z } from "zod";

import { exportManifestSchema, safeStorageProvider, sanitizeExportJson } from "./export-manifest.js";

// Reuses the exact per-asset/label/annotation shapes `export-manifest.ts`
// already validated for Dataset Export -- one allowlist, not a second one
// that could quietly drift (both must exclude the same private storage
// locators). This is a genuinely separate top-level schema/manifest,
// though: Export Selected must never reuse Dataset Export's own contract or
// idempotency key (FR-027; research.md §12).
const assetSchema = exportManifestSchema.shape.assets.element;
const labelSchema = exportManifestSchema.shape.labels.element;
const annotationSchema = exportManifestSchema.shape.annotations.element;

export const exportSelectedManifestSchema = z.object({
  schemaVersion: z.literal("1"),
  exportedAt: z.string().datetime(),
  datasetId: z.string(),
  selectedAssetCount: z.number().int(),
  assets: z.array(assetSchema),
  /** Asset-level metadata labels (022) -- distinct from `annotations[].labelId`, never implies a geometry/Annotation. */
  assetLabels: z.array(z.object({ assetId: z.string(), labelId: z.string() }).strict()),
  labels: z.array(labelSchema),
  annotations: z.array(annotationSchema),
}).strict();

export type ExportSelectedManifest = z.infer<typeof exportSelectedManifestSchema>;

/**
 * Selection-scoped counterpart to `buildExportManifest` (022 User Story 4).
 * Metadata + annotations only -- no binary content, same as Dataset Export
 * (assets carry only `storage.provider/contentType/sizeBytes/checksum`,
 * never a storage key/bucket). `assetIds` is re-resolved by the caller
 * (`bulk-asset-selection.ts`) immediately before this runs, so it always
 * reflects the selection's *current* server-side match, never a stale
 * client-provided list.
 */
export async function buildExportSelectedManifest(db: PrismaClient, datasetId: string, assetIds: string[], exportedAt: Date): Promise<ExportSelectedManifest> {
  if (assetIds.length === 0) {
    return exportSelectedManifestSchema.parse({ schemaVersion: "1", exportedAt: exportedAt.toISOString(), datasetId, selectedAssetCount: 0, assets: [], assetLabels: [], labels: [], annotations: [] });
  }
  const assets = await db.asset.findMany({
    where: { id: { in: assetIds }, datasetId, deletedAt: null },
    orderBy: [{ batchIndex: "asc" }, { orderIndex: "asc" }, { id: "asc" }],
    select: {
      id: true, datasetId: true, filename: true, originalFilename: true, modality: true, mimeType: true, status: true,
      sizeBytes: true, width: true, height: true, durationMs: true, textLength: true, batchIndex: true, orderIndex: true,
      description: true, checksum: true, revision: true, storageProvider: true, createdAt: true, updatedAt: true,
    },
  });
  const resolvedIds = assets.map((asset) => asset.id);
  const [assetLabelRows, annotationRows] = await Promise.all([
    db.assetLabel.findMany({ where: { assetId: { in: resolvedIds } }, select: { assetId: true, labelId: true } }),
    db.annotation.findMany({
      where: { assetId: { in: resolvedIds }, datasetId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true, datasetId: true, assetId: true, labelId: true, modality: true, type: true, source: true, status: true,
        geometry: true, properties: true, revision: true, createdAt: true, updatedAt: true,
      },
    }),
  ]);
  const referencedLabelIds = new Set<string>([
    ...assetLabelRows.map((row) => row.labelId),
    ...annotationRows.map((row) => row.labelId).filter((id): id is string => Boolean(id)),
  ]);
  const labelRows = referencedLabelIds.size > 0 ? await db.label.findMany({
    where: { id: { in: [...referencedLabelIds] }, datasetId },
    orderBy: [{ normalizedName: "asc" }, { id: "asc" }],
    select: { id: true, datasetId: true, name: true, normalizedName: true, color: true, description: true, modality: true, scope: true, hotkey: true, properties: true, createdAt: true, updatedAt: true },
  }) : [];

  return exportSelectedManifestSchema.parse({
    schemaVersion: "1",
    exportedAt: exportedAt.toISOString(),
    datasetId,
    selectedAssetCount: assets.length,
    assets: assets.map((asset) => ({
      id: asset.id, datasetId: asset.datasetId, filename: asset.filename, originalFilename: asset.originalFilename,
      modality: asset.modality, mimeType: asset.mimeType, status: asset.status, sizeBytes: asset.sizeBytes?.toString() ?? null,
      width: asset.width, height: asset.height, durationMs: asset.durationMs, textLength: asset.textLength,
      batchIndex: asset.batchIndex, orderIndex: asset.orderIndex, description: asset.description, checksum: asset.checksum,
      revision: asset.revision, createdAt: asset.createdAt.toISOString(), updatedAt: asset.updatedAt.toISOString(),
      storage: { assetId: asset.id, provider: safeStorageProvider(asset.storageProvider), contentType: asset.mimeType, sizeBytes: asset.sizeBytes?.toString() ?? null, checksum: asset.checksum },
    })),
    assetLabels: assetLabelRows,
    labels: labelRows.map((label) => ({
      ...label, modality: label.modality, scope: label.scope, properties: sanitizeExportJson(label.properties),
      createdAt: label.createdAt.toISOString(), updatedAt: label.updatedAt.toISOString(),
    })),
    annotations: annotationRows.map((annotation) => ({
      ...annotation, modality: annotation.modality, type: annotation.type, source: annotation.source, status: annotation.status,
      geometry: sanitizeExportJson(annotation.geometry), properties: sanitizeExportJson(annotation.properties),
      createdAt: annotation.createdAt.toISOString(), updatedAt: annotation.updatedAt.toISOString(),
    })),
  });
}
