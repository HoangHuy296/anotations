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
    if (!transitioned.count) {
      // 021-production-hardening-garbage-collection: the read above already
      // confirmed this Job was RUNNING/RETRYING and its deadline had not yet
      // passed — but this transaction's own snapshot can still be stale by
      // the time this UPDATE runs (e.g. the import commit-timeout scanner,
      // apps/worker/src/queue/import-timeout-scanner.ts, wins a concurrent
      // race and fails the Job first). Zero rows affected here does not
      // always mean "another commit already completed it" — re-check the
      // Job's actual current status before ever reporting success, so a
      // timed-out import is never presented to the caller as committed
      // (spec's core guarantee — no partially/un-committed import shown as
      // successful).
      const current = await tx.job.findUniqueOrThrow({ where: { id: jobId }, select: { status: true } });
      if (current.status === JobStatus.COMPLETED) return { ok: true as const, status: 200 as const, replayed: true, completed, total: preparation.expectedItemCount };
      return { ok: false as const, status: 409 as const };
    }
    await tx.preparedImport.update({ where: { id: preparation.id }, data: { status: PreparedImportStatus.COMMITTED, committedAt: new Date() } });
    await tx.jobEvent.create({ data: { jobId, stage: JobStage.FINISHED, message: "IMPORT_COMMITTED", data: {} } });
    return { ok: true as const, status: 200 as const, replayed: false, completed, total: preparation.expectedItemCount };
  });
}
