import "server-only";

import type { AssetStatus, Modality, Prisma } from "@internal/db";

import { db } from "@/lib/db";
import type { SafeAssetAssignment } from "@/types/collaboration";
import type { AssetListOrder, AssetListQuery, AssetListSort, SafeWorkspaceAsset } from "@/types/workspace";

export const WORKSPACE_ASSET_PAGE_SIZE = 10;

/** Typed responsibility projection for authorized workspace reads. It has no
 * workflow, geometry, revision, or private-storage fields. */
export async function readSafeWorkspaceAssignments(datasetId: string, assetId: string): Promise<SafeAssetAssignment[]> {
  const rows = await db.assetAssignment.findMany({
    where: { datasetId, assetId }, orderBy: { type: "asc" },
    select: { assetId: true, type: true, userId: true, assignedAt: true },
  });
  return rows.map((row) => ({ ...row, assignedAt: row.assignedAt.toISOString() }));
}

/**
 * The one Prisma where-clause builder for Asset Browser filtering (022).
 * Shared by `readWorkspacePage` (the Assets tab's server-rendered listing),
 * the `GET /api/datasets/[datasetId]/assets` route, and the bulk-mutation
 * endpoint's `FILTERED`-selection resolver, so all three always agree on
 * exactly which Assets a given query matches. See
 * specs/022-asset-browser-dataset-management-workspace/research.md (§1, §4).
 */
export function buildAssetListWhere(datasetId: string, query: AssetListQuery): Prisma.AssetWhereInput {
  const search = query.q?.trim().slice(0, 100);
  const createdAt = query.createdFrom || query.createdTo ? {
    ...(query.createdFrom ? { gte: new Date(query.createdFrom) } : {}),
    ...(query.createdTo ? { lte: new Date(query.createdTo) } : {}),
  } : undefined;
  const updatedAt = query.updatedFrom || query.updatedTo ? {
    ...(query.updatedFrom ? { gte: new Date(query.updatedFrom) } : {}),
    ...(query.updatedTo ? { lte: new Date(query.updatedTo) } : {}),
  } : undefined;
  return {
    datasetId,
    deletedAt: null,
    archivedAt: null,
    ...(search ? { filename: { contains: search, mode: "insensitive" as const } } : {}),
    ...(query.status?.length ? { status: { in: query.status } } : {}),
    ...(query.modality ? { modality: query.modality } : {}),
    ...(query.labelId?.length ? { assetLabels: { some: { labelId: { in: query.labelId } } } } : {}),
    ...(query.assignedToId ? { assignedToId: query.assignedToId } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/**
 * Sort is display-only and intentionally not part of `AssetListQuery` (it
 * must never define Selection membership -- FR-005/FR-013). Default mirrors
 * the pre-022 fixed ordering exactly, so callers that pass no sort keep
 * today's behavior unchanged.
 */
export function buildAssetListOrderBy(sort?: AssetListSort, order: AssetListOrder = "desc"): Prisma.AssetOrderByWithRelationInput[] {
  if (sort === "createdAt") return [{ createdAt: order }, { id: "asc" }];
  if (sort === "updatedAt") return [{ updatedAt: order }, { id: "asc" }];
  if (sort === "filename") return [{ filename: order }, { id: "asc" }];
  return [{ batchIndex: "asc" }, { orderIndex: "asc" }, { id: "asc" }];
}

/**
 * The "position of `ref` under the active order" comparator that
 * `readWorkspacePage`'s selected-asset auto-paging and Previous/Next
 * lookahead need, generalized to match whichever `buildAssetListOrderBy`
 * order is active (previously hardcoded to the default batchIndex/orderIndex
 * ordering only). Mirrors `buildAssetListOrderBy`'s tiebreak exactly: custom
 * sorts always break ties by ascending `id`, so "earlier in the list" means
 * a strictly smaller `id` once the primary field is equal.
 */
export function buildBeforeSelectionWhere(
  sort: AssetListSort | undefined,
  order: AssetListOrder,
  ref: { batchIndex: number; orderIndex: number; id: string; createdAt: Date; updatedAt: Date; filename: string },
): Prisma.AssetWhereInput {
  if (sort === "createdAt") return { OR: [{ createdAt: order === "desc" ? { gt: ref.createdAt } : { lt: ref.createdAt } }, { createdAt: ref.createdAt, id: { lt: ref.id } }] };
  if (sort === "updatedAt") return { OR: [{ updatedAt: order === "desc" ? { gt: ref.updatedAt } : { lt: ref.updatedAt } }, { updatedAt: ref.updatedAt, id: { lt: ref.id } }] };
  if (sort === "filename") return { OR: [{ filename: order === "desc" ? { gt: ref.filename } : { lt: ref.filename } }, { filename: ref.filename, id: { lt: ref.id } }] };
  return {
    OR: [
      { batchIndex: { lt: ref.batchIndex } },
      { batchIndex: ref.batchIndex, orderIndex: { lt: ref.orderIndex } },
      { batchIndex: ref.batchIndex, orderIndex: ref.orderIndex, id: { lt: ref.id } },
    ],
  };
}

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
