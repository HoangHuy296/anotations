import "server-only";

import { db } from "@/lib/db";

export const datasetMetadataSelect = {
  id: true, name: true, description: true, type: true, primaryModality: true,
  sourceMode: true, createdAt: true, updatedAt: true, archivedAt: true,
} as const;
export const labelMetadataSelect = {
  id: true, datasetId: true, modality: true, scope: true, name: true, normalizedName: true,
  color: true, description: true, hotkey: true, createdAt: true, updatedAt: true,
} as const;
export const assetMetadataSelect = {
  id: true, datasetId: true, modality: true, filename: true, originalFilename: true, mimeType: true,
  sizeBytes: true, width: true, height: true, durationMs: true, textLength: true, status: true,
  batchIndex: true, orderIndex: true, description: true, revision: true, createdAt: true, updatedAt: true,
} as const;

export async function findSafeLabel(labelId: string) {
  return db.label.findFirst({ where: { id: labelId }, select: labelMetadataSelect });
}
