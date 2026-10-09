import { mediaVerificationJobInputSchema, isTerminalStatus } from "@annotationplatform/domain/media-verification";

import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { failJob, heartbeatJob } from "../jobs/job-claim-lock.js";
import { deferJob, handleOperationalFailure } from "./operational.js";
import { probeStep } from "./probe-step.js";
import { publishStep } from "./publish.js";
import { sealStep } from "./seal.js";
import { endJobForTerminalRow, terminalizeVerification } from "./terminalize.js";
import type { StepContext, VerifierDeps } from "./types.js";

export type VerifyUploadedMediaResult = "published" | "rejected" | "stale" | "canceled" | "expired" | "retrying" | "failed" | "refused";

const HEARTBEAT_MS = 60_000;
const MAX_STEPS = 12;

async function failPermanently(db: PrismaClient, jobId: string, lockToken: string, errorCode: string) {
  await db.job.updateMany({ where: { id: jobId, lockToken, status: "RUNNING" }, data: { errorCode, errorDetails: { kind: "PERMANENT_REJECTION", reason: errorCode } } });
  await failJob(db, { jobId, lockToken });
}

/**
 * `VERIFY_UPLOADED_MEDIA` processor (contract section 5.3). Idempotent per recorded status: it re-reads the verification row at every boundary and resumes from whatever
 * was last persisted, so duplicate deliveries, crashes and retries can neither create a second Asset nor skip a gate. The queue payload carries only the Job id; the
 * authoritative record is the `MediaVerification` row, and `Job.input` is the strict `{ verificationId, contractVersion }`.
 */
export async function processVerifyUploadedMedia(db: PrismaClient, jobId: string, lockToken: string, deps: VerifierDeps): Promise<VerifyUploadedMediaResult> {
  const job = await db.job.findFirst({
    where: { id: jobId, type: "VERIFY_UPLOADED_MEDIA", lockToken, status: { in: ["RUNNING", "CANCELING"] } },
    select: { id: true, datasetId: true, createdById: true, input: true, attempts: true, maxAttempts: true },
  });
  if (!job) return "refused";
  const input = mediaVerificationJobInputSchema.safeParse(job.input);
  const first = input.success ? await db.mediaVerification.findUnique({ where: { id: input.data.verificationId } }) : null;
  if (!input.success || !first || first.datasetId !== job.datasetId || first.requestedById !== job.createdById) {
    await failPermanently(db, job.id, lockToken, "VERIFICATION_INPUT_INVALID");
    return "failed";
  }
  const ctx: StepContext = { db, deps, job, lockToken };
  const heartbeat = setInterval(() => { void heartbeatJob(db, { jobId, lockToken }).catch(() => undefined); }, HEARTBEAT_MS);
  heartbeat.unref();
  const cancelRequested = async () => {
    const current = await db.job.findFirst({ where: { id: jobId, lockToken, status: { in: ["RUNNING", "CANCELING"] } }, select: { cancelRequestedAt: true, status: true } });
    return Boolean(current?.cancelRequestedAt || current?.status === "CANCELING");
  };
  try {
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const row = await db.mediaVerification.findUnique({ where: { id: first.id } });
      if (!row) { await failPermanently(db, job.id, lockToken, "VERIFICATION_INPUT_INVALID"); return "failed"; }
      if (isTerminalStatus(row.status)) {
        await endJobForTerminalRow(ctx, row);
        return row.status === "PUBLISHED" ? "published" : row.status === "REJECTED" ? "rejected" : row.status === "STALE" ? "stale" : row.status === "EXPIRED" ? "expired" : "canceled";
      }
      // Boundary guards (every step): cancellation, inactive Dataset, allowance.
      if (await cancelRequested()) { if (!(await terminalizeVerification(ctx, row, { status: "CANCELED", resultCode: "UPLOAD_VERIFICATION_CANCELED", resultReason: "REQUESTED" }))) continue; return "canceled"; }
      const dataset = await db.dataset.findFirst({ where: { id: row.datasetId }, select: { archivedAt: true, deletedAt: true } });
      if (!dataset || dataset.archivedAt || dataset.deletedAt) { if (!(await terminalizeVerification(ctx, row, { status: "CANCELED", resultCode: "UPLOAD_VERIFICATION_CANCELED", resultReason: "DATASET_INACTIVE" }))) continue; return "canceled"; }
      if (deps.now().getTime() >= row.verificationDeadlineAt.getTime()) {
        if (!(await terminalizeVerification(ctx, row, { status: "EXPIRED", resultCode: "UPLOAD_VERIFICATION_EXPIRED", resultReason: "ALLOWANCE_ELAPSED", jobErrorCode: "UPLOAD_VERIFICATION_EXPIRED", jobErrorKind: "ALLOWANCE_EXPIRED" }))) continue;
        return "expired";
      }
      let result;
      try {
        result = row.status === "PENDING" ? await sealStep(ctx, row) : row.status === "SEALED" ? await probeStep(ctx, row, cancelRequested) : await publishStep(ctx, row);
      } catch {
        result = { kind: "operational" as const, reason: "UPLOAD_VERIFICATION_STORAGE_FAILED" as const };
      }
      if (result.kind === "advanced") continue;
      if (result.kind === "lease_lost") return "refused";
      if (result.kind === "retry_later") { await deferJob(ctx, result.runAfter); return "retrying"; }
      if (result.kind === "operational") return handleOperationalFailure(ctx, row, result.reason);
      const final = await db.mediaVerification.findUnique({ where: { id: first.id }, select: { status: true } });
      return final?.status === "PUBLISHED" ? "published" : final?.status === "REJECTED" ? "rejected" : final?.status === "STALE" ? "stale" : final?.status === "EXPIRED" ? "expired" : final?.status === "CANCELED" ? "canceled" : "retrying";
    }
    return handleOperationalFailure(ctx, first, "UPLOAD_VERIFICATION_STORAGE_FAILED");
  } finally {
    clearInterval(heartbeat);
  }
}
