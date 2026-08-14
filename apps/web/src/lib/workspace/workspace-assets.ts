import "server-only";

import type { AssetStatus, Modality } from "@internal/db";

import type { SafeWorkspaceAsset } from "@/types/workspace";

export const WORKSPACE_ASSET_PAGE_SIZE = 100;

/**
 * Split out from `workspace-read.ts` so `image-workspace.ts` (which
 * `workspace-read.ts` itself imports for the IMAGE projection) can share this
 * mapper without a circular import.
 */
export function toSafeWorkspaceAsset(asset: {
  id: string; modality: Modality; filename: string; width: number | null; height: number | null; description: string | null;
  revision: number; status: AssetStatus; batchIndex: number; orderIndex: number; _count: { annotations: number };
}): SafeWorkspaceAsset {
  return {
    id: asset.id, modality: asset.modality, filename: asset.filename, width: asset.width, height: asset.height,
    description: asset.description, version: asset.revision, status: asset.status,
    batchIndex: asset.batchIndex, orderIndex: asset.orderIndex, annotationCount: asset._count.annotations,
  };
}
