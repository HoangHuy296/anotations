import { nextRetryDelayMs } from "@annotationplatform/domain/media-verification";

import { failJob } from "../jobs/job-claim-lock.js";
import type { OperationalReason, StepContext, VerificationRow } from "./types.js";

const NON_TERMINAL = ["PENDING", "SEALED", "VERIFIED"] as const;
const isProbeReason = (reason: OperationalReason) => reason === "UPLOAD_VERIFICATION_PROBE_TIMEOUT" || reason === "UPLOAD_VERIFICATION_PROBE_FAILED";

/**
 * Operational (non-authoritative) failure, R5. The verification row KEEPS its non-terminal status; only the informational `lastFailure*` columns and the Job change.
 * Within `maxAttempts` the Job goes RETRYING with a backoff `runAfter` (and its delivery fields cleared so the redelivery scanner re-queues it); once the attempts are
 * exhausted the Job ends FAILED with a distinct, retryable code. The row is never REJECTED/STALE by this path: it stays retryable until `verificationDeadlineAt`, after
 * which the expiry scanner makes it EXPIRED.
 */
export async function handleOperationalFailure(ctx: StepContext, row: VerificationRow, reason: OperationalReason): Promise<"retrying" | "failed"> {
  const { db, deps, job, lockToken } = ctx;
  const now = deps.now();
  const consumed = job.attempts + 1;
  const exhausted = consumed >= job.maxAttempts;
  const failureCode = !exhausted ? "VERIFICATION_ATTEMPT_FAILED" : isProbeReason(reason) ? "VERIFICATION_EXECUTION_EXHAUSTED" : "VERIFICATION_INFRASTRUCTURE_FAILED";
  await db.mediaVerification.updateMany({ where: { id: row.id, status: { in: [...NON_TERMINAL] } }, data: { lastFailureCode: failureCode, lastFailureReason: reason, lastFailureAt: now } });
  if (!exhausted) {
    await db.job.updateMany({
      where: { id: job.id, lockToken, status: "RUNNING" },
      data: {
        status: "RETRYING", attempts: consumed, runAfter: new Date(now.getTime() + nextRetryDelayMs(consumed)),
        lockedBy: null, lockToken: null, lockedAt: null, lockedUntil: null, heartbeatAt: null,
        queueName: null, queueJobId: null, enqueuedAt: null, dequeuedAt: null, errorCode: null,
      },
    });
    return "retrying";
  }
  await db.job.updateMany({
    where: { id: job.id, lockToken, status: "RUNNING" },
    data: { attempts: consumed, errorCode: failureCode, errorDetails: { kind: isProbeReason(reason) ? "EXECUTION_EXHAUSTED" : "TRANSIENT", reason } },
  });
  await failJob(db, { jobId: job.id, lockToken });
  return "failed";
}

/** Maintenance quiescence is not a failure and consumes no attempt: the Job waits (RETRYING with `runAfter`) and resumes at publication. */
export async function deferJob(ctx: StepContext, runAfter: Date): Promise<void> {
  await ctx.db.job.updateMany({
    where: { id: ctx.job.id, lockToken: ctx.lockToken, status: "RUNNING" },
    data: { status: "RETRYING", runAfter, lockedBy: null, lockToken: null, lockedAt: null, lockedUntil: null, heartbeatAt: null, queueName: null, queueJobId: null, enqueuedAt: null, dequeuedAt: null },
  });
}
