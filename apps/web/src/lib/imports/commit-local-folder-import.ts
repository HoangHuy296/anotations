import "server-only";

import { JobStage, JobStatus, PreparedImportStatus } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireImportJobAccess } from "@/lib/imports/authorization";

export async function commitLocalFolderImport(actor: RequestActor, jobId: string) {
  const job = await requireImportJobAccess(actor, jobId);
  if (!job) return { ok: false as const, status: 404 as const };
  if (job.status === JobStatus.COMPLETED) return { ok: true as const, status: 200 as const, replayed: true, completed: 0, total: 0 };
  if (job.status !== JobStatus.RUNNING && job.status !== JobStatus.RETRYING) return { ok: false as const, status: 409 as const };
  return db.$transaction(async (tx) => {
    const preparation = await tx.preparedImport.findUnique({ where: { jobId }, select: { id: true, status: true, expectedItemCount: true, deadlineAt: true } });
    if (!preparation || preparation.status === PreparedImportStatus.EXPIRED || preparation.deadlineAt <= new Date()) return { ok: false as const, status: 409 as const };
    const completed = await tx.preparedImportItem.count({ where: { preparedImportId: preparation.id, assetId: { not: null } } });
    if (completed !== preparation.expectedItemCount) {
      return { ok: false as const, status: 409 as const, code: "IMPORT_INCOMPLETE" as const, completed, total: preparation.expectedItemCount };
    }
    const transitioned = await tx.job.updateMany({ where: { id: jobId, status: { in: [JobStatus.RUNNING, JobStatus.RETRYING] } }, data: { status: JobStatus.COMPLETED, stage: JobStage.FINISHED, progress: 100, processedItems: completed, successItems: completed, finishedAt: new Date(), summary: { outcome: "completed", resultCount: completed } } });
    if (!transitioned.count) return { ok: true as const, status: 200 as const, replayed: true, completed, total: preparation.expectedItemCount };
    await tx.preparedImport.update({ where: { id: preparation.id }, data: { status: PreparedImportStatus.COMMITTED, committedAt: new Date() } });
    await tx.jobEvent.create({ data: { jobId, stage: JobStage.FINISHED, message: "IMPORT_COMMITTED", data: {} } });
    return { ok: true as const, status: 200 as const, replayed: false, completed, total: preparation.expectedItemCount };
  });
}
