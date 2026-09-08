import "server-only";

import { AssetStatus, AssetWorkflowAction, Modality } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { readSafeMediaReadiness } from "@/lib/media-processing/safe-media-readiness";
import { readVideoAnnotations } from "@/lib/annotations/video-read-service";
import { readImageWorkspaceAsset } from "@/lib/workspace/image-workspace";
import { buildAssetListOrderBy, buildAssetListWhere, buildBeforeSelectionWhere, readSafeWorkspaceAssignments, toSafeWorkspaceAsset, WORKSPACE_ASSET_PAGE_SIZE } from "@/lib/workspace/workspace-assets";
import type { SafeAssetAssignment } from "@/types/collaboration";

/** Shared server-only authorization wrapper for typed responsibility reads.
 * The REST handler uses the collaboration service for current/history; this
 * projection supports workspace consumers without bypassing dataset scope. */
export async function readWorkspaceAssignmentProjection(actor: RequestActor, datasetId: string, assetId: string): Promise<SafeAssetAssignment[] | null> {
  const access = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!access || access.forbidden) return null;
  const asset = await db.asset.findFirst({ where: { id: assetId, datasetId, deletedAt: null, archivedAt: null }, select: { id: true } });
  return asset ? readSafeWorkspaceAssignments(datasetId, assetId) : null;
}

/** Resolves a discussion deep-link only when its comment belongs to the selected
 * authorized asset. The query parameter is never trusted as cross-asset state. */
export async function readSafeDiscussionCommentId(actor: RequestActor, datasetId: string, assetId: string, commentId?: string) {
  if (!commentId) return null;
  const access = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!access || access.forbidden) return null;
  const comment = await db.assetComment.findFirst({ where: { id: commentId, datasetId, assetId }, select: { id: true } });
  return comment?.id ?? null;
}
import type { AssetListOrder, AssetListSort, SafeWorkspaceWorkflow, WorkspaceAssetPage, WorkspaceSelection } from "@/types/workspace";

export type { WorkspaceSelection } from "@/types/workspace";

const submitActionsByStatus: Partial<Record<AssetStatus, AssetWorkflowAction[]>> = {
  [AssetStatus.NEW]: [AssetWorkflowAction.START],
  [AssetStatus.READY]: [AssetWorkflowAction.START],
  [AssetStatus.IN_PROGRESS]: [AssetWorkflowAction.SUBMIT, AssetWorkflowAction.RESUBMIT],
  [AssetStatus.REJECTED]: [AssetWorkflowAction.START_REWORK],
};

const reviewActionsByStatus: Partial<Record<AssetStatus, AssetWorkflowAction[]>> = {
  [AssetStatus.NEEDS_REVIEW]: [AssetWorkflowAction.OPEN_REVIEW, AssetWorkflowAction.APPROVE, AssetWorkflowAction.REJECT],
};

/**
 * Produces the selected asset's current, browser-safe workflow affordances.
 * Route handlers remain the authority: this projection only determines which
 * controls the workspace can render.
 */
export async function readWorkspaceWorkflow(
  actor: RequestActor,
  datasetId: string,
  assetId: string,
): Promise<SafeWorkspaceWorkflow | null> {
  const readAccess = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!readAccess || readAccess.forbidden) return null;
  const asset = await db.asset.findFirst({
    where: { id: assetId, datasetId, deletedAt: null, archivedAt: null },
    select: { id: true, status: true, revision: true },
  });
  if (!asset) return null;
  const [submitAccess, reviewAccess] = await Promise.all([
    requireDatasetPermission(actor, datasetId, "workflow.submit"),
    requireDatasetPermission(actor, datasetId, "workflow.review"),
  ]);
  const permittedActions = [
    ...(submitAccess && !submitAccess.forbidden ? submitActionsByStatus[asset.status] ?? [] : []),
    ...(reviewAccess && !reviewAccess.forbidden ? reviewActionsByStatus[asset.status] ?? [] : []),
  ];
  return { datasetId, assetId: asset.id, status: asset.status, revision: asset.revision, permittedActions};
}

/**
 * Lists the shared, modality-neutral Assets tab for one authorized dataset.
 * `options.selectedAsset` carries both the id and the modality the caller
 * expects it to have (the URL encodes modality via which navigation key
 * produced the id -- `?image=`, `?video=`, `?audio=`, `?text=`). The lookup
 * filters on both, so a stale or spoofed pairing (e.g. `?video=` pointing at
 * an IMAGE asset) fails to resolve rather than silently selecting the wrong
 * engine; the returned `selectedAsset` reports the modality actually
 * confirmed from the Dataset, not an echo of the request.
 */
export async function readWorkspacePage(
  actor: RequestActor,
  datasetId: string,
  options: {
    page?: number;
    search?: string;
    statuses?: AssetStatus[];
    selectedAsset?: { id: string; modality: Modality };
    modality?: Modality;
    labelId?: string[];
    assignedToId?: string;
    createdFrom?: string;
    createdTo?: string;
    updatedFrom?: string;
    updatedTo?: string;
    sort?: AssetListSort;
    order?: AssetListOrder;
  } = {},
): Promise<{ dataset: { id: string; name: string }; page: WorkspaceAssetPage } | null> {
  const access = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!access || access.forbidden) return null;
  const requestedPage = Math.max(1, Math.floor(options.page ?? 1));
  const sort = options.sort;
  const order = options.order ?? "desc";
  const where = buildAssetListWhere(datasetId, {
    q: options.search,
    status: options.statuses,
    modality: options.modality,
    labelId: options.labelId,
    assignedToId: options.assignedToId,
    createdFrom: options.createdFrom,
    createdTo: options.createdTo,
    updatedFrom: options.updatedFrom,
    updatedTo: options.updatedTo,
  });
  const orderBy = buildAssetListOrderBy(sort, order);
  const requestedAsset = options.selectedAsset ? await db.asset.findFirst({
    where: { ...where, id: options.selectedAsset.id, modality: options.selectedAsset.modality },
    select: { id: true, batchIndex: true, orderIndex: true, createdAt: true, updatedAt: true, filename: true },
  }) : null;
  const selectedPosition = requestedAsset ? await db.asset.count({
    where: { ...where, ...buildBeforeSelectionWhere(sort, order, requestedAsset) },
  }) : null;
  const page = selectedPosition === null ? requestedPage : Math.floor(selectedPosition / WORKSPACE_ASSET_PAGE_SIZE) + 1;
  const [dataset, items, total, completed] = await Promise.all([
    db.dataset.findFirst({ where: { id: datasetId, deletedAt: null, archivedAt: null }, select: { id: true, name: true } }),
    db.asset.findMany({
      where,
      orderBy,
      skip: (page - 1) * WORKSPACE_ASSET_PAGE_SIZE,
      take: WORKSPACE_ASSET_PAGE_SIZE,
      select: { id: true, modality: true, filename: true, width: true, height: true, description: true, revision: true, status: true, batchIndex: true, orderIndex: true, _count: { select: { annotations: true } } },
    }),
    db.asset.count({ where }),
    db.asset.count({ where: { datasetId, deletedAt: null, archivedAt: null, status: { not: AssetStatus.NEW } } }),
  ]);
  if (!dataset) return null;
  const assets = items.map(toSafeWorkspaceAsset);
  const selectedAssetId = requestedAsset?.id ?? assets[0]?.id ?? null;
  const selectedIndex = selectedAssetId ? assets.findIndex((asset) => asset.id === selectedAssetId) : -1;
  const selectedAssetRecord = selectedIndex >= 0 ? assets[selectedIndex]! : null;
  const absoluteIndex = selectedIndex < 0 ? -1 : (page - 1) * WORKSPACE_ASSET_PAGE_SIZE + selectedIndex;
  const previousAsset = selectedIndex > 0 ? assets[selectedIndex - 1] : null;
  const nextAsset = selectedIndex >= 0 && selectedIndex < assets.length - 1 ? assets[selectedIndex + 1] : null;
  const [previousAcrossPage, nextAcrossPage] = await Promise.all([
    absoluteIndex > 0 && !previousAsset ? db.asset.findMany({ where, orderBy, skip: absoluteIndex - 1, take: 1, select: { id: true, modality: true } }) : Promise.resolve([]),
    absoluteIndex >= 0 && absoluteIndex + 1 < total && !nextAsset ? db.asset.findMany({ where, orderBy, skip: absoluteIndex + 1, take: 1, select: { id: true, modality: true } }) : Promise.resolve([]),
  ]);
  const previousId = previousAsset?.id ?? previousAcrossPage[0]?.id ?? null;
  const nextId = nextAsset?.id ?? nextAcrossPage[0]?.id ?? null;
  return {
    dataset,
    page: {
      items: assets, total, completed, page, pageSize: WORKSPACE_ASSET_PAGE_SIZE,
      selectedAsset: selectedAssetRecord ? { id: selectedAssetRecord.id, modality: selectedAssetRecord.modality } : null,
      previous: previousId ? { id: previousId, modality: previousAsset?.modality ?? previousAcrossPage[0]!.modality, page: Math.floor((absoluteIndex - 1) / WORKSPACE_ASSET_PAGE_SIZE) + 1 } : null,
      next: nextId ? { id: nextId, modality: nextAsset?.modality ?? nextAcrossPage[0]!.modality, page: Math.floor((absoluteIndex + 1) / WORKSPACE_ASSET_PAGE_SIZE) + 1 } : null,
    },
  };
}

/**
 * The one server-only selected-asset boundary for the shared workspace route.
 * It resolves the Dataset/Asset relationship and permission before dispatching
 * a modality-specific projection. No browser route or canvas may duplicate
 * those authorization or projection decisions.
 */
export async function readWorkspaceSelection(
  actor: RequestActor,
  datasetId: string,
  assetId: string,
): Promise<WorkspaceSelection | null> {
  const access = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!access || access.forbidden) return null;
  const asset = await db.asset.findFirst({
    where: { id: assetId, datasetId, deletedAt: null, archivedAt: null },
    select: {
      id: true, modality: true, filename: true, description: true, revision: true, status: true,
      // Only consumed by the TEXT branch below (real Details metadata, 022
      // FR-031) -- cheap enough to select unconditionally alongside the
      // fields every branch already needs, rather than a second query.
      mimeType: true, sizeBytes: true, textLength: true, createdAt: true, updatedAt: true,
      textAsset: { select: { language: true } },
    },
  });
  if (!asset) return null;
  if (asset.modality === Modality.IMAGE) {
    const image = await readImageWorkspaceAsset(actor, datasetId, assetId);
    return image ? { engine: "IMAGE", ...image } : null;
  }
  if (asset.modality === Modality.VIDEO || asset.modality === Modality.AUDIO) {
    const readiness = await readSafeMediaReadiness(actor, datasetId, assetId);
    if (!readiness) return null;
    if (asset.modality === Modality.VIDEO) {
      const annotations = await readVideoAnnotations(actor, assetId);
      if (!annotations) return null;
      return {
        engine: "VIDEO",
        asset: { id: asset.id, modality: "VIDEO", filename: asset.filename, description: asset.description, version: asset.revision, status: asset.status },
        readiness,
        annotations,
      };
    }
    return {
      engine: "AUDIO",
      asset: { id: asset.id, modality: asset.modality, filename: asset.filename, description: asset.description },
      readiness,
    };
  }
  return {
    engine: "TEXT",
    asset: {
      id: asset.id, modality: "TEXT", filename: asset.filename, description: asset.description,
      mimeType: asset.mimeType, sizeBytes: asset.sizeBytes?.toString() ?? null, textLength: asset.textLength,
      language: asset.textAsset?.language ?? null, createdAt: asset.createdAt.toISOString(), updatedAt: asset.updatedAt.toISOString(),
    },
  };
}
