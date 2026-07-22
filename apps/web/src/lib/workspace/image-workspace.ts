import "server-only";

import { AssetStatus, Modality } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import type {
  ImageWorkspacePage,
  NormalizedBoundingBox,
  SafeImageAnnotation,
  SafeImageWorkspaceAsset,
  SafeWorkspaceAsset,
  SafeWorkspaceLabel,
} from "@/types/image-workspace";

const PAGE_SIZE = 100;

function safeGeometry(value: unknown): NormalizedBoundingBox | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const box = value as Record<string, unknown>;
  const numbers = [box.x, box.y, box.width, box.height];
  if (!numbers.every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  const [x, y, width, height] = numbers as number[];
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) return null;
  return { x, y, width, height };
}

function toSafeAsset(asset: {
  id: string; modality: Modality; filename: string; width: number | null; height: number | null; description: string | null;
  revision: number; status: AssetStatus; batchIndex: number; orderIndex: number; _count: { annotations: number };
}): SafeWorkspaceAsset {
  return {
    id: asset.id, modality: asset.modality, filename: asset.filename, width: asset.width, height: asset.height,
    description: asset.description, version: asset.revision, status: asset.status,
    batchIndex: asset.batchIndex, orderIndex: asset.orderIndex, annotationCount: asset._count.annotations,
  };
}

export async function readImageWorkspacePage(
  actor: RequestActor,
  datasetId: string,
  options: { page?: number; search?: string; statuses?: AssetStatus[]; selectedAssetId?: string } = {},
): Promise<{ dataset: { id: string; name: string }; page: ImageWorkspacePage } | null> {
  const access = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!access || access.forbidden) return null;
  const requestedPage = Math.max(1, Math.floor(options.page ?? 1));
  const search = options.search?.trim().slice(0, 100) ?? "";
  const where = {
    datasetId,
    deletedAt: null,
    archivedAt: null,
    ...(search ? { filename: { contains: search, mode: "insensitive" as const } } : {}),
    ...(options.statuses?.length ? { status: { in: options.statuses } } : {}),
  };
  const requestedAsset = options.selectedAssetId ? await db.asset.findFirst({
    where: { ...where, id: options.selectedAssetId },
    select: { id: true, batchIndex: true, orderIndex: true },
  }) : null;
  const selectedPosition = requestedAsset ? await db.asset.count({
    where: {
      ...where,
      OR: [
        { batchIndex: { lt: requestedAsset.batchIndex } },
        { batchIndex: requestedAsset.batchIndex, orderIndex: { lt: requestedAsset.orderIndex } },
        { batchIndex: requestedAsset.batchIndex, orderIndex: requestedAsset.orderIndex, id: { lt: requestedAsset.id } },
      ],
    },
  }) : null;
  const page = selectedPosition === null ? requestedPage : Math.floor(selectedPosition / PAGE_SIZE) + 1;
  const [dataset, items, total, completed] = await Promise.all([
    db.dataset.findFirst({ where: { id: datasetId, deletedAt: null, archivedAt: null }, select: { id: true, name: true } }),
    db.asset.findMany({
      where,
      orderBy: [{ batchIndex: "asc" }, { orderIndex: "asc" }, { id: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: { id: true, modality: true, filename: true, width: true, height: true, description: true, revision: true, status: true, batchIndex: true, orderIndex: true, _count: { select: { annotations: true } } },
    }),
    db.asset.count({ where }),
    db.asset.count({ where: { datasetId, deletedAt: null, archivedAt: null, status: { not: AssetStatus.NEW } } }),
  ]);
  if (!dataset) return null;
  const safeItems = items.map(toSafeAsset);
  const selectedAssetId = requestedAsset?.id ?? safeItems[0]?.id ?? null;
  const selectedIndex = selectedAssetId ? safeItems.findIndex((item) => item.id === selectedAssetId) : -1;
  const absoluteIndex = selectedIndex < 0 ? -1 : (page - 1) * PAGE_SIZE + selectedIndex;
  const previousItem = selectedIndex > 0 ? safeItems[selectedIndex - 1] : null;
  const nextItem = selectedIndex >= 0 && selectedIndex < safeItems.length - 1 ? safeItems[selectedIndex + 1] : null;
  const [previousAcrossPage, nextAcrossPage] = await Promise.all([
    absoluteIndex > 0 && !previousItem ? db.asset.findMany({ where, orderBy: [{ batchIndex: "asc" }, { orderIndex: "asc" }, { id: "asc" }], skip: absoluteIndex - 1, take: 1, select: { id: true } }) : Promise.resolve([]),
    absoluteIndex >= 0 && absoluteIndex + 1 < total && !nextItem ? db.asset.findMany({ where, orderBy: [{ batchIndex: "asc" }, { orderIndex: "asc" }, { id: "asc" }], skip: absoluteIndex + 1, take: 1, select: { id: true } }) : Promise.resolve([]),
  ]);
  const previousId = previousItem?.id ?? previousAcrossPage[0]?.id ?? null;
  const nextId = nextItem?.id ?? nextAcrossPage[0]?.id ?? null;
  return {
    dataset,
    page: {
      items: safeItems, total, completed, page, pageSize: PAGE_SIZE, selectedAssetId,
      previous: previousId ? { id: previousId, page: Math.floor((absoluteIndex - 1) / PAGE_SIZE) + 1 } : null,
      next: nextId ? { id: nextId, page: Math.floor((absoluteIndex + 1) / PAGE_SIZE) + 1 } : null,
    },
  };
}

export async function readImageWorkspaceAsset(actor: RequestActor, datasetId: string, assetId: string) {
  const access = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!access || access.forbidden) return null;
  const [asset, labels] = await Promise.all([
    db.asset.findFirst({
      where: { id: assetId, datasetId, modality: Modality.IMAGE, deletedAt: null, archivedAt: null },
      select: {
        id: true, filename: true, width: true, height: true, description: true, revision: true, status: true, batchIndex: true, orderIndex: true,
        _count: { select: { annotations: true } },
        annotations: { where: { modality: Modality.IMAGE, type: "BOUNDING_BOX" }, orderBy: { createdAt: "asc" }, select: { id: true, assetId: true, labelId: true, type: true, geometry: true, status: true, revision: true, updatedAt: true } },
      },
    }),
    db.label.findMany({ where: { datasetId, OR: [{ modality: null }, { modality: Modality.IMAGE }] }, orderBy: { normalizedName: "asc" }, select: { id: true, name: true, color: true, modality: true } }),
  ]);
  if (!asset) return null;
  const annotations: SafeImageAnnotation[] = asset.annotations.flatMap((annotation) => {
    const geometry = safeGeometry(annotation.geometry);
    if (!geometry || annotation.type !== "BOUNDING_BOX" || !["DRAFT", "IN_PROGRESS", "COMPLETED"].includes(annotation.status)) return [];
    return [{ id: annotation.id, assetId: annotation.assetId, labelId: annotation.labelId, type: "BOUNDING_BOX" as const, geometry, status: annotation.status as SafeImageAnnotation["status"], version: annotation.revision, updatedAt: annotation.updatedAt.toISOString() }];
  });
  const safeLabels: SafeWorkspaceLabel[] = labels.map((label) => ({ id: label.id, name: label.name, color: label.color, modality: label.modality === Modality.IMAGE ? "IMAGE" : null }));
  const safeAsset: SafeImageWorkspaceAsset = { ...toSafeAsset({ ...asset, modality: Modality.IMAGE }), modality: Modality.IMAGE };
  return { asset: safeAsset, annotations, labels: safeLabels };
}

export { PAGE_SIZE };
