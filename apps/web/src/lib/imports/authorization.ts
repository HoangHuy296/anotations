import "server-only";

import { UserRole } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireDatasetPermission } from "@/lib/authorization";

export function canStartLocalFolderImport(actor: RequestActor) {
  return actor.role === UserRole.ADMIN || actor.role === UserRole.MANAGER;
}

export async function requirePreparedImportAccess(actor: RequestActor, preparedImportId: string) {
  const preparation = await db.preparedImport.findFirst({
    where: {
      id: preparedImportId,
      dataset: actor.role === UserRole.ADMIN ? { deletedAt: null, archivedAt: null } : {
        deletedAt: null, archivedAt: null,
        OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }],
      },
    },
    select: { id: true, datasetId: true, jobId: true, status: true, deadlineAt: true, expectedItemCount: true, createdById: true },
  });
  if (!preparation) return null;
  const access = await requireDatasetPermission(actor, preparation.datasetId, "asset.upload");
  if (!access || access.forbidden) return null;
  return preparation;
}

export async function requireImportJobAccess(actor: RequestActor, jobId: string) {
  const job = await db.job.findFirst({ where: { id: jobId, type: "IMPORT_DATASET" }, select: { id: true, datasetId: true, status: true, type: true } });
  if (!job) return null;
  const access = await requireDatasetPermission(actor, job.datasetId, "asset.upload");
  if (!access || access.forbidden) return null;
  return job;
}

