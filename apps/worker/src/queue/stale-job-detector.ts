import { logJobEvent } from "@annotationplatform/domain";

import type { Job, PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { writeSafeJobEvent } from "../jobs/job-event-writer.js";

const DEFAULT_SCAN_LIMIT = 50;

export type StaleScanResult = { examined: number; retried: number; deadLettered: number };

/**
 * Reclaims one candidate Job whose current attempts are still under budget:
 * retries it *in place* (same row — never a new Job/`retryOfJobId` successor,
 * that lineage is reserved for the separate, user-authorized retry flow) and
 * clears every lease/lock/transport field so the (scheduled)
 * `recovery-scanner.ts` pass can redeliver it fresh. One atomic conditional
 * `UPDATE ... RETURNING *`, the same idiom as `job.repository.ts#claimJob`
 * and `job-lock.ts#renewOrReclaimLock`: the WHERE clause re-verifies
 * eligibility at write time, so two concurrent callers racing the same Job
 * can have at most one succeed (`rows.length` is 0 for the loser).
 */
async function retryInPlace(db: PrismaClient, jobId: string, extraGuard: "LEASE" | "RUNTIME"): Promise<Job | null> {
  const rows = extraGuard === "LEASE"
    ? await db.$queryRaw<Job[]>`
        UPDATE "Job"
        SET
          "status" = 'RETRYING',
          "attempts" = "attempts" + 1,
          "lockedBy" = NULL, "lockToken" = NULL, "lockedAt" = NULL, "lockedUntil" = NULL, "heartbeatAt" = NULL,
          "queueName" = NULL, "queueJobId" = NULL, "enqueuedAt" = NULL, "dequeuedAt" = NULL,
          "updatedAt" = NOW()
        WHERE "id" = ${jobId}
          AND "status" = 'RUNNING'
          AND "lockedUntil" IS NOT NULL
          AND "lockedUntil" < NOW()
          AND "attempts" < "maxAttempts"
        RETURNING *
      `
    : await db.$queryRaw<Job[]>`
        UPDATE "Job"
        SET
          "status" = 'RETRYING',
          "attempts" = "attempts" + 1,
          "lockedBy" = NULL, "lockToken" = NULL, "lockedAt" = NULL, "lockedUntil" = NULL, "heartbeatAt" = NULL,
          "queueName" = NULL, "queueJobId" = NULL, "enqueuedAt" = NULL, "dequeuedAt" = NULL,
          "updatedAt" = NOW()
        WHERE "id" = ${jobId}
          AND "status" = 'RUNNING'
          AND "attempts" < "maxAttempts"
        RETURNING *
      `;
  return rows[0] ?? null;
}

/**
 * Companion to `retryInPlace` for a candidate whose retry budget is already
 * exhausted: a terminal, observable ("dead-letter") `FAILED` outcome on the
 * original Job row — never a silent delete, per FR-008/FR-010.
 */
async function deadLetter(db: PrismaClient, jobId: string, errorCode: "RECOVERY_EXHAUSTED" | "MAX_RUNTIME_EXCEEDED", extraGuard: "LEASE" | "RUNTIME"): Promise<Job | null> {
  const message = errorCode === "RECOVERY_EXHAUSTED"
    ? "The Job's worker lease expired and its retry budget is exhausted."
    : "The Job exceeded its maximum allowed runtime and its retry budget is exhausted.";
  const rows = extraGuard === "LEASE"
    ? await db.$queryRaw<Job[]>`
        UPDATE "Job"
        SET
          "status" = 'FAILED',
          "errorCode" = ${errorCode},
          "error" = ${message},
          "finishedAt" = NOW(),
          "lockedBy" = NULL, "lockToken" = NULL, "lockedAt" = NULL, "lockedUntil" = NULL, "heartbeatAt" = NULL,
          "updatedAt" = NOW()
        WHERE "id" = ${jobId}
          AND "status" = 'RUNNING'
          AND "lockedUntil" IS NOT NULL
          AND "lockedUntil" < NOW()
          AND "attempts" >= "maxAttempts"
        RETURNING *
      `
    : await db.$queryRaw<Job[]>`
        UPDATE "Job"
        SET
          "status" = 'FAILED',
          "errorCode" = ${errorCode},
          "error" = ${message},
          "finishedAt" = NOW(),
          "lockedBy" = NULL, "lockToken" = NULL, "lockedAt" = NULL, "lockedUntil" = NULL, "heartbeatAt" = NULL,
          "updatedAt" = NOW()
        WHERE "id" = ${jobId}
          AND "status" = 'RUNNING'
          AND "attempts" >= "maxAttempts"
        RETURNING *
      `;
  return rows[0] ?? null;
}

async function reclaim(db: PrismaClient, jobId: string, reason: "LEASE_EXPIRED" | "MAX_RUNTIME_EXCEEDED", guard: "LEASE" | "RUNTIME"): Promise<"RETRIED" | "DEAD_LETTERED" | "SKIPPED"> {
  const startedAt = Date.now();
  // Try the "still has retry budget" branch first; if it affects no row
  // (either another caller won the race, or this candidate is actually out
  // of budget), try the dead-letter branch. Each branch's own WHERE clause
  // is the sole source of truth for eligibility — no separate read-then-act.
  const retried = await retryInPlace(db, jobId, guard);
  if (retried) {
    await writeSafeJobEvent(db, { jobId, kind: "JOB_RECOVERED", reason });
    logJobEvent("JOB_RECOVERED", { jobId, type: retried.type, status: retried.status, attempts: retried.attempts, reason, durationMs: Date.now() - startedAt });
    return "RETRIED";
  }
  const errorCode = reason === "LEASE_EXPIRED" ? "RECOVERY_EXHAUSTED" : "MAX_RUNTIME_EXCEEDED";
  const deadLettered = await deadLetter(db, jobId, errorCode, guard);
  if (deadLettered) {
    await writeSafeJobEvent(db, { jobId, kind: "JOB_DEAD_LETTERED", reason: errorCode });
    logJobEvent("JOB_DEAD_LETTERED", { jobId, type: deadLettered.type, status: deadLettered.status, attempts: deadLettered.attempts, reason: errorCode, durationMs: Date.now() - startedAt }, "error");
    return "DEAD_LETTERED";
  }
  // Neither branch matched: the row is no longer RUNNING (already recovered
  // by a concurrent pass, or otherwise moved on) — a safe no-op.
  return "SKIPPED";
}

/**
 * Recovery scanner for jobs whose worker crashed or lost connectivity
 * (021-production-hardening-garbage-collection, User Story 1 / FR-001–005).
 * Finds `RUNNING` Jobs whose existing `lockedUntil` lease has expired past a
 * configurable grace period and reclaims each one exactly once: retried in
 * place under budget, dead-lettered once exhausted. Never touches a Job
 * whose lease is still valid (FR-002).
 */
export async function recoverExpiredLeaseJobs(input: { db: PrismaClient; leaseGraceMs: number; limit?: number }): Promise<StaleScanResult> {
  const take = Math.min(Math.max(input.limit ?? DEFAULT_SCAN_LIMIT, 1), DEFAULT_SCAN_LIMIT);
  const threshold = new Date(Date.now() - input.leaseGraceMs);
  const candidates = await input.db.job.findMany({
    where: { status: "RUNNING", lockedUntil: { not: null, lt: threshold } },
    orderBy: { lockedUntil: "asc" },
    take,
    select: { id: true },
  });

  const result: StaleScanResult = { examined: candidates.length, retried: 0, deadLettered: 0 };
  for (const candidate of candidates) {
    const outcome = await reclaim(input.db, candidate.id, "LEASE_EXPIRED", "LEASE");
    if (outcome === "RETRIED") result.retried += 1;
    else if (outcome === "DEAD_LETTERED") result.deadLettered += 1;
  }
  return result;
}

/**
 * Explicit detector for jobs that remain `RUNNING` beyond a reasonable
 * maximum duration, independent of lease renewal (021-..., FR-006/FR-007 —
 * "Stale RUNNING Job Detector"). Anchored on `lockedAt` (when the *current*
 * owning worker acquired the Job — reset on every fresh claim, unlike
 * `startedAt` which persists across retries) so a job recovered once does
 * not inherit its earlier attempt's elapsed time. This intentionally
 * overrides an otherwise-still-valid lease: a worker that is still
 * heartbeating but has simply taken far too long is still reclaimed:
 * clearing its lock/token means that worker's own eventual completion
 * attempt safely no-ops (the same stale-token-rejection guarantee
 * `job-lock.ts` already relies on), so this is safe even if that worker is
 * still alive.
 */
export async function failRunawayJobs(input: { db: PrismaClient; maxRuntimeMs: number; limit?: number }): Promise<StaleScanResult> {
  const take = Math.min(Math.max(input.limit ?? DEFAULT_SCAN_LIMIT, 1), DEFAULT_SCAN_LIMIT);
  const threshold = new Date(Date.now() - input.maxRuntimeMs);
  const candidates = await input.db.job.findMany({
    where: { status: "RUNNING", lockedAt: { not: null, lt: threshold } },
    orderBy: { lockedAt: "asc" },
    take,
    select: { id: true },
  });

  const result: StaleScanResult = { examined: candidates.length, retried: 0, deadLettered: 0 };
  for (const candidate of candidates) {
    const outcome = await reclaim(input.db, candidate.id, "MAX_RUNTIME_EXCEEDED", "RUNTIME");
    if (outcome === "RETRIED") result.retried += 1;
    else if (outcome === "DEAD_LETTERED") result.deadLettered += 1;
  }
  return result;
}
