import "server-only";

import { JobStage, JobStatus, PreparedImportStatus } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireImportJobAccess } from "@/lib/imports/authorization";

export async function commitLocalFolderImport(actor: RequestActor, jobId: string) {
  const job = await requireImportJobAccess(actor, jobId);
  if (!job) return { ok: false as const, status: 404 as const };
  if (job.status === JobStatus.COMPLETED) {
    const summary = job.summary && typeof job.summary === "object" && !Array.isArray(job.summary) ? job.summary as Record<string, unknown> : {};
    const accepted = Number(summary.accepted) || 0, unchanged = Number(summary.unchanged) || 0;
    return { ok: true as const, status: 200 as const, replayed: true, accepted, unchanged, rejected: Number(summary.rejected) || 0, retryable: Number(summary.retryable) || 0, unprocessed: Number(summary.unprocessed) || 0, completed: accepted + unchanged, total: accepted + unchanged + (Number(summary.rejected) || 0) + (Number(summary.retryable) || 0) + (Number(summary.unprocessed) || 0) };
  }
  if (job.status === JobStatus.FAILED && job.summary && typeof job.summary === "object" && !Array.isArray(job.summary) && (job.summary as Record<string, unknown>).outcome === "incomplete") {
    const summary = job.summary as Record<string, unknown>;
    return { ok: false as const, status: 409 as const, code: "IMPORT_INCOMPLETE" as const, accepted: Number(summary.accepted) || 0, unchanged: Number(summary.unchanged) || 0, rejected: Number(summary.rejected) || 0, retryable: Number(summary.retryable) || 0, unprocessed: Number(summary.unprocessed) || 0 };
  }
  if (job.status !== JobStatus.RUNNING && job.status !== JobStatus.RETRYING) return { ok: false as const, status: 409 as const };
  return db.$transaction(async (tx) => {
    const preparation = await tx.preparedImport.findUnique({ where: { jobId }, select: { id: true, status: true, expectedItemCount: true, deadlineAt: true } });
    if (!preparation || preparation.status === PreparedImportStatus.EXPIRED || preparation.deadlineAt <= new Date()) return { ok: false as const, status: 409 as const };
    const linkedItems = await tx.preparedImportItem.findMany({ where: { preparedImportId: preparation.id, assetId: { not: null } }, select: { id: true, assetId: true } });
    const completed = linkedItems.length;
    const events = await tx.jobEvent.findMany({ where: { jobId, message: { in: ["IMPORT_ITEM_SUCCEEDED", "IMPORT_ITEM_REJECTED", "IMPORT_ITEM_RETRYABLE"] } }, select: { message: true, data: true } });
    const linkedIds = new Set(linkedItems.map((item) => item.id));
    const acceptedIds = new Set(events.filter((event) => event.message === "IMPORT_ITEM_SUCCEEDED" && (event.data as { disposition?: unknown }).disposition === "accepted").map((event) => (event.data as { itemId?: unknown }).itemId).filter((id): id is string => typeof id === "string" && linkedIds.has(id)));
    const accepted = acceptedIds.size;
    const unchanged = Math.max(0, completed - accepted);
    const rejectedIds = new Set(events.filter((event) => event.message === "IMPORT_ITEM_REJECTED").map((event) => (event.data as { itemId?: unknown }).itemId).filter((id): id is string => typeof id === "string" && !linkedIds.has(id)));
    const retryableIds = new Set(events.filter((event) => event.message === "IMPORT_ITEM_RETRYABLE").map((event) => (event.data as { itemId?: unknown }).itemId).filter((id): id is string => typeof id === "string" && !linkedIds.has(id) && !rejectedIds.has(id)));
    const linkedItemIds = new Set(linkedItems.map((item) => item.id));
    const rejected = [...rejectedIds].filter((id) => !linkedItemIds.has(id)).length;
    const retryable = [...retryableIds].filter((id) => !linkedItemIds.has(id) && !rejectedIds.has(id)).length;
    const unprocessed = Math.max(0, preparation.expectedItemCount - completed - rejected - retryable);
    if (completed !== preparation.expectedItemCount) {
      const summary = { outcome: "incomplete", accepted, unchanged, rejected, retryable, unprocessed };
      await tx.job.updateMany({ where: { id: jobId, status: { in: [JobStatus.RUNNING, JobStatus.RETRYING] } }, data: { status: JobStatus.FAILED, stage: JobStage.FINISHED, progress: 100, processedItems: completed + rejected + retryable + unprocessed, successItems: completed, failedItems: rejected + retryable, skippedItems: unprocessed, errorCode: "IMPORT_INCOMPLETE", finishedAt: new Date(), summary } });
      await tx.jobEvent.createMany({ data: [{ id: `phase029_import_incomplete_${jobId}`, jobId, level: "WARN", stage: JobStage.FINISHED, message: "IMPORT_INCOMPLETE", data: summary }], skipDuplicates: true });
      return { ok: false as const, status: 409 as const, code: "IMPORT_INCOMPLETE" as const, accepted, unchanged, rejected, retryable, unprocessed };
    }
    const transitioned = await tx.job.updateMany({ where: { id: jobId, status: { in: [JobStatus.RUNNING, JobStatus.RETRYING] } }, data: { status: JobStatus.COMPLETED, stage: JobStage.FINISHED, progress: 100, processedItems: completed, successItems: completed, finishedAt: new Date(), errorCode: null, summary: { outcome: "completed", accepted, unchanged, rejected: 0, retryable: 0, unprocessed: 0, resultCount: completed } } });
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
      if (current.status === JobStatus.COMPLETED) return { ok: true as const, status: 200 as const, replayed: true, accepted, unchanged, completed, total: preparation.expectedItemCount };
      return { ok: false as const, status: 409 as const };
    }
    await tx.preparedImport.update({ where: { id: preparation.id }, data: { status: PreparedImportStatus.COMMITTED, committedAt: new Date() } });
    await tx.jobEvent.create({ data: { jobId, stage: JobStage.FINISHED, message: "IMPORT_COMMITTED", data: {} } });
    return { ok: true as const, status: 200 as const, replayed: false, accepted, unchanged, completed, total: preparation.expectedItemCount };
  });
}
