import { assertMediaVerificationTransition, type MediaVerificationStatus } from "@annotationplatform/domain/media-verification";

import { cancelJob, completeJob, failJob } from "../jobs/job-claim-lock.js";
import { recomputeFolderAccounting, writeItemEvent } from "./folder-accounting.js";
import { isObjectNotFound } from "./identity.js";
import type { StepContext, StepResult, VerificationRow, VerifierDeps } from "./types.js";
import type { Prisma } from "../../../../lib/generated/prisma/client.js";

export type TerminalSpec = {
  status: "REJECTED" | "STALE" | "CANCELED" | "EXPIRED";
  resultCode: string;
  resultReason: string;
  /** Job error code for a FAILED Job (rejections, stale, expiry). Cancellation uses the CANCELED Job status instead. */
  jobErrorCode?: string;
  jobErrorKind?: string;
  /** Authoritative evidence of a COMPLETED probe (media rejection) or of a verified object (path rejection). */
  evidence?: { probe: Prisma.InputJsonValue; contentSha256: string; verifiedModality?: "VIDEO" | null; policyVersion: string; processorVersion: string };
};

/** Best-effort deletion of both objects. `objectsClearedAt` is set only when BOTH are positively confirmed absent (R2). Never throws. */
export async function cleanupVerificationObjects(ctx: Pick<StepContext, "db"> & { deps: Pick<VerifierDeps, "minio" | "bucket" | "now"> }, row: Pick<VerificationRow, "id" | "stagedKey" | "stagedBucket" | "sealedKey">) {
  const keys = [row.stagedKey, row.sealedKey].filter((key): key is string => Boolean(key));
  let allGone = true;
  for (const key of keys) {
    try { await ctx.deps.minio.removeObject(row.stagedBucket, key); } catch { /* confirmed below */ }
    try { await ctx.deps.minio.statObject(row.stagedBucket, key); allGone = false; } catch (error) { if (!isObjectNotFound(error)) allGone = false; }
  }
  if (allGone) await ctx.db.mediaVerification.updateMany({ where: { id: row.id, objectsClearedAt: null }, data: { objectsClearedAt: ctx.deps.now() } }).catch(() => undefined);
  return allGone;
}

/** Ends the (lease-owned) Job according to the section 9 matrix. A lost lease simply leaves the Job for recovery. */
async function endJobFor(ctx: StepContext, spec: TerminalSpec): Promise<void> {
  const { db, job, lockToken } = ctx;
  if (spec.status === "CANCELED") {
    await db.job.updateMany({ where: { id: job.id, lockToken, status: { in: ["RUNNING", "CANCELING"] }, cancelRequestedAt: null }, data: { cancelRequestedAt: ctx.deps.now() } });
    await cancelJob(db, { jobId: job.id, lockToken });
    return;
  }
  await db.job.updateMany({
    where: { id: job.id, lockToken, status: "RUNNING" },
    data: { errorCode: spec.jobErrorCode ?? spec.resultCode, errorDetails: { kind: spec.jobErrorKind ?? "PERMANENT_REJECTION", reason: spec.resultReason } },
  });
  await failJob(db, { jobId: job.id, lockToken });
}

/**
 * The only way a verification leaves a non-terminal status other than VERIFIED/PUBLISHED. One compare-and-swap (`updateMany WHERE id AND status=<from>`, count must be 1),
 * then folder accounting, object cleanup and the Job's own terminal state. Returns false when another actor already moved the row (a safe no-op).
 */
export async function terminalizeVerification(ctx: StepContext, row: VerificationRow, spec: TerminalSpec, options: { endJob?: boolean } = {}): Promise<boolean> {
  assertMediaVerificationTransition(row.status as MediaVerificationStatus, spec.status);
  const now = ctx.deps.now();
  const swapped = await ctx.db.mediaVerification.updateMany({
    where: { id: row.id, status: row.status },
    data: {
      status: spec.status, resultCode: spec.resultCode, resultReason: spec.resultReason, finishedAt: now,
      // Frozen field/state table: only the path-policy REJECTED keeps `verifiedModality`; STALE/CANCELED/EXPIRED and a media REJECTED must have it null even when the row had reached VERIFIED.
      verifiedModality: spec.evidence?.verifiedModality ?? null,
      ...(spec.evidence ? { probe: spec.evidence.probe, contentSha256: spec.evidence.contentSha256, policyVersion: spec.evidence.policyVersion, processorVersion: spec.evidence.processorVersion } : {}),
    },
  });
  if (swapped.count !== 1) return false;
  if (row.preparedImportItemId) {
    const item = await ctx.db.preparedImportItem.findUnique({ where: { id: row.preparedImportItemId }, select: { id: true, preparedImportId: true, preparedImport: { select: { jobId: true } } } });
    if (item) {
      // REJECTED is a deterministic verdict; STALE/EXPIRED/CANCELED leave the item uncompleted and re-uploadable while the import is open.
      if (spec.status === "REJECTED") await writeItemEvent(ctx.db, item.preparedImport.jobId, "rejected", item.id, spec.resultCode);
      else if (spec.resultReason !== "IMPORT_ENDED" && spec.resultReason !== "DATASET_INACTIVE") await writeItemEvent(ctx.db, item.preparedImport.jobId, "retryable", item.id, spec.resultCode);
      await recomputeFolderAccounting(ctx.db, item.preparedImportId);
    }
  }
  await cleanupVerificationObjects(ctx, row);
  if (options.endJob !== false) await endJobFor(ctx, spec);
  return true;
}

/** Resumes a Job whose verification is already PUBLISHED (a crash between the publish commit and `completeJob`). */
export async function completeJobForPublished(ctx: StepContext) {
  return completeJob(ctx.db, { jobId: ctx.job.id, lockToken: ctx.lockToken, stage: "FINISHED", progress: 100, totalItems: 1, processedItems: 1, successItems: 1, failedItems: 0, skippedItems: 0, summary: { message: "Upload verified and published.", outcome: "completed", resultCount: 1 } });
}

/** Ends the Job for a row another actor (scanner/duplicate delivery) already terminalized, so a re-delivered Job never lingers RUNNING. */
export async function endJobForTerminalRow(ctx: StepContext, row: VerificationRow) {
  if (row.status === "PUBLISHED") return completeJobForPublished(ctx);
  const code = row.resultCode ?? "UPLOAD_VERIFICATION_EXPIRED";
  const kind = row.status === "STALE" ? "STALE_EVIDENCE" : row.status === "EXPIRED" ? "ALLOWANCE_EXPIRED" : row.resultCode === "INVALID_RELATIVE_PATH" ? "PERMANENT_REJECTION_PATH" : "PERMANENT_REJECTION";
  return endJobFor(ctx, { status: row.status as TerminalSpec["status"], resultCode: code, resultReason: row.resultReason ?? "ALLOWANCE_ELAPSED", jobErrorCode: row.status === "STALE" ? "UPLOAD_SOURCE_CHANGED" : row.status === "EXPIRED" ? "UPLOAD_VERIFICATION_EXPIRED" : code, jobErrorKind: kind });
}

/**
 * A lost compare-and-swap means ANOTHER actor (a duplicate delivery, a retry successor or a scanner) already moved the row. That is never "terminal" for this caller and must
 * not end its Job: the state loop re-reads the recorded status and resumes from it.
 */
export const swapResult = (won: boolean): StepResult => (won ? { kind: "terminal" } : { kind: "advanced" });
