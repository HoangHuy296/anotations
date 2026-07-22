import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { z } from "zod";

const prohibitedKey = /(password|secret|token|credential|access.?key|private.?url|storage.?key|storage.?bucket|cookie|session)/i;
const urlValue = /^https?:\/\//i;

/** Retain ordinary properties while removing only unsafe branches. */
export function sanitizeExportJson(value: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.length <= 16_384 && !urlValue.test(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 10_000).map((item) => sanitizeExportJson(item, depth + 1));
  if (typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key.length <= 128 && !prohibitedKey.test(key))
    .map(([key, entry]) => [key, sanitizeExportJson(entry, depth + 1)]));
}

function safeStorageProvider(provider: string | null) {
  if (provider === "MINIO" || provider === "LOCAL") return provider;
  return provider ? "EXTERNAL" : null;
}

export const exportManifestSchema = z.object({
  schemaVersion: z.literal("1"),
  exportedAt: z.string().datetime(),
  dataset: z.object({
    id: z.string(), name: z.string(), description: z.string().nullable(), type: z.string(),
    primaryModality: z.string().nullable(), sourceMode: z.string(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  }).strict(),
  assets: z.array(z.object({
    id: z.string(), datasetId: z.string(), filename: z.string(), originalFilename: z.string().nullable(),
    modality: z.string(), mimeType: z.string(), status: z.string(), sizeBytes: z.string().nullable(),
    width: z.number().int().nullable(), height: z.number().int().nullable(), durationMs: z.number().int().nullable(),
    textLength: z.number().int().nullable(), batchIndex: z.number().int(), orderIndex: z.number().int(),
    description: z.string().nullable(), checksum: z.string().nullable(), revision: z.number().int(),
    createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
    storage: z.object({
      assetId: z.string(), provider: z.enum(["MINIO", "EXTERNAL", "LOCAL"]).nullable(),
      contentType: z.string().nullable(), sizeBytes: z.string().nullable(), checksum: z.string().nullable(),
    }).strict(),
  }).strict()),
  labels: z.array(z.object({
    id: z.string(), datasetId: z.string(), name: z.string(), normalizedName: z.string(), color: z.string(),
    description: z.string().nullable(), modality: z.string().nullable(), scope: z.string(), hotkey: z.string().nullable(),
    properties: z.unknown(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  }).strict()),
  annotations: z.array(z.object({
    id: z.string(), datasetId: z.string(), assetId: z.string(), labelId: z.string().nullable(), modality: z.string(),
    type: z.string(), source: z.string(), status: z.string(), geometry: z.unknown(), properties: z.unknown(),
    revision: z.number().int(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  }).strict()),
}).strict();

export type ExportManifest = z.infer<typeof exportManifestSchema>;

/**
 * Loads one Dataset through Dataset-scoped relations and emits only an
 * explicit metadata allowlist. Private storage locators never enter the
 * returned manifest.
 */
export async function buildExportManifest(db: PrismaClient, datasetId: string, exportedAt: Date): Promise<ExportManifest | null> {
  const dataset = await db.dataset.findFirst({
    where: { id: datasetId, archivedAt: null, deletedAt: null },
    select: {
      id: true, name: true, description: true, type: true, primaryModality: true, sourceMode: true, createdAt: true, updatedAt: true,
      assets: {
        where: { archivedAt: null, deletedAt: null },
        orderBy: [{ batchIndex: "asc" }, { orderIndex: "asc" }, { id: "asc" }],
        select: {
          id: true, datasetId: true, filename: true, originalFilename: true, modality: true, mimeType: true, status: true,
          sizeBytes: true, width: true, height: true, durationMs: true, textLength: true, batchIndex: true, orderIndex: true,
          description: true, checksum: true, revision: true, storageProvider: true, createdAt: true, updatedAt: true,
        },
      },
      labels: {
        orderBy: [{ normalizedName: "asc" }, { id: "asc" }],
        select: {
          id: true, datasetId: true, name: true, normalizedName: true, color: true, description: true, modality: true,
          scope: true, hotkey: true, properties: true, createdAt: true, updatedAt: true,
        },
      },
      annotations: {
        orderBy: [{ asset: { batchIndex: "asc" } }, { asset: { orderIndex: "asc" } }, { createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true, datasetId: true, assetId: true, labelId: true, modality: true, type: true, source: true, status: true,
          geometry: true, properties: true, revision: true, createdAt: true, updatedAt: true,
        },
      },
    },
  });
  if (!dataset) return null;

  return exportManifestSchema.parse({
    schemaVersion: "1",
    exportedAt: exportedAt.toISOString(),
    dataset: {
      id: dataset.id, name: dataset.name, description: dataset.description, type: dataset.type,
      primaryModality: dataset.primaryModality, sourceMode: dataset.sourceMode,
      createdAt: dataset.createdAt.toISOString(), updatedAt: dataset.updatedAt.toISOString(),
    },
    assets: dataset.assets.map((asset) => ({
      id: asset.id, datasetId: asset.datasetId, filename: asset.filename, originalFilename: asset.originalFilename,
      modality: asset.modality, mimeType: asset.mimeType, status: asset.status, sizeBytes: asset.sizeBytes?.toString() ?? null,
      width: asset.width, height: asset.height, durationMs: asset.durationMs, textLength: asset.textLength,
      batchIndex: asset.batchIndex, orderIndex: asset.orderIndex, description: asset.description, checksum: asset.checksum,
      revision: asset.revision, createdAt: asset.createdAt.toISOString(), updatedAt: asset.updatedAt.toISOString(),
      storage: {
        assetId: asset.id, provider: safeStorageProvider(asset.storageProvider), contentType: asset.mimeType,
        sizeBytes: asset.sizeBytes?.toString() ?? null, checksum: asset.checksum,
      },
    })),
    labels: dataset.labels.map((label) => ({
      ...label, modality: label.modality, scope: label.scope, properties: sanitizeExportJson(label.properties),
      createdAt: label.createdAt.toISOString(), updatedAt: label.updatedAt.toISOString(),
    })),
    annotations: dataset.annotations.map((annotation) => ({
      ...annotation, modality: annotation.modality, type: annotation.type, source: annotation.source, status: annotation.status,
      geometry: sanitizeExportJson(annotation.geometry), properties: sanitizeExportJson(annotation.properties),
      createdAt: annotation.createdAt.toISOString(), updatedAt: annotation.updatedAt.toISOString(),
    })),
  });
}
