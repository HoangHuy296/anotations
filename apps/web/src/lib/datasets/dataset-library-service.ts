import "server-only";

import { Prisma, UserRole } from "@internal/db";

import { projectDatasetWorkflowStatus } from "@/lib/datasets/dataset-destination";

import type { RequestActor } from "@/lib/auth";
import { db } from "@/lib/db";
import type { DatasetLibraryQuery } from "@/types/dataset-library";

export const DATASET_PAGE_SIZE = 7;

export function datasetLibraryWhere(actor: RequestActor, query: DatasetLibraryQuery): Prisma.DatasetWhereInput {
  const filters: Prisma.DatasetWhereInput[] = [];
  if (query.method !== "ALL") {
    filters.push({ sourceMode: query.method === "UPLOAD" ? "UPLOAD" : { not: "UPLOAD" } });
  }
  if (query.status === "IN_PROGRESS") {
    // Legacy metadata without a recognized status is displayed as In progress.
    // JSON-path SQL NULL needs an explicit branch alongside JSON null.
    filters.push({ OR: [
      { metadata: { path: ["workflowStatus"], equals: Prisma.DbNull } },
      { metadata: { path: ["workflowStatus"], equals: Prisma.JsonNull } },
      { NOT: [
        { metadata: { path: ["workflowStatus"], equals: "COMPLETED" } },
        { metadata: { path: ["workflowStatus"], equals: "REVIEWED" } },
      ] },
    ] });
  } else if (query.status !== "ALL") {
    filters.push({ metadata: { path: ["workflowStatus"], equals: query.status } });
  }
  return {
    deletedAt: null,
    archivedAt: null,
    ...(actor.role === UserRole.ADMIN ? {} : { OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }] }),
    AND: filters,
  };
}

export async function getDatasetLibrary(actor: RequestActor, query: DatasetLibraryQuery) {
  const where = datasetLibraryWhere(actor, query);
  const backwards = Boolean(query.before);
  const cursor = query.before || query.after;
  const [rows, total] = await Promise.all([
    db.dataset.findMany({
      where,
      orderBy: backwards ? [{ updatedAt: "asc" }, { id: "asc" }] : [{ updatedAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: DATASET_PAGE_SIZE + 1,
      select: {
        id: true, name: true, sourceRootPath: true, sourceRef: true, sourceMode: true,
        ownerId: true, metadata: true, createdAt: true,
        externalRepository: { select: { fullName: true } },
        members: { where: { userId: actor.id }, select: { role: true } },
        _count: { select: { assets: true } },
      },
    }),
    db.dataset.count({ where }),
  ]);
  const overflow = rows.length > DATASET_PAGE_SIZE;
  const datasets = rows.slice(0, DATASET_PAGE_SIZE);
  if (backwards) datasets.reverse();
  const assetWhere = { datasetId: { in: datasets.map(({ id }) => id) } };
  const [statusCounts, modalityCounts] = await Promise.all([
    db.asset.groupBy({ by: ["datasetId", "status"], where: assetWhere, _count: { _all: true } }),
    db.asset.groupBy({ by: ["datasetId", "modality"], where: assetWhere, _count: { _all: true } }),
  ]);
  return {
    datasets: datasets.map(projectDatasetWorkflowStatus), total, statusCounts, modalityCounts,
    hasNext: backwards ? true : overflow,
    hasPrevious: backwards ? overflow : Boolean(query.after),
  };
}
