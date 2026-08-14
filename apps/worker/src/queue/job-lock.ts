import { randomUUID } from "node:crypto";

import type { Job, PrismaClient } from "../../../../lib/generated/prisma/client.js";

/**
 * Default lease duration. Configurable per-call (see `renewOrReclaimLock`'s
 * last parameter) rather than a scattered literal. 3 minutes comfortably
 * exceeds the 30-second polling ceiling (`POLL_MAX_DELAY_MS`, defined in
 * ai-poll-constants.ts) plus its `LOCK_RENEWAL_BUFFER_MS`, provided the
 * external AI provider request itself carries a timeout well below 3
 * minutes (required of every AiProviderAdapter implementation — see T006's
 * requirements in tasks.md).
 */
export const DEFAULT_LEASE_DURATION_MS = 3 * 60 * 1000;

export type LockResult = { acquired: true; lockToken: string } | { acquired: false };

/**
 * Scanner-driven re-entry into an already-RUNNING Job. This project's poll
 * scanner (apps/worker/src/queue/ai-poll-scanner.ts) drives repeated poll
 * steps itself, on a PostgreSQL-backed interval, rather than re-delivering
 * the Job through BullMQ (queue delivery for an AI Job happens exactly once,
 * on submission — see specs/020-ai-integration/research.md #1). If that ever
 * changes to a BullMQ-delayed-delivery design instead, this comment and the
 * "scanner-driven" framing below must be updated to match.
 *
 * Unlike `claimJob` (apps/worker/src/jobs/job.repository.ts), which only
 * transitions QUEUED|RETRYING -> RUNNING once on that single delivery, this
 * primitive re-enters a Job that is already RUNNING across many later poll
 * steps.
 *
 * `observedLockToken` must be the `lockToken` read from the Job row in the
 * poll processor's own step 1 ("load Job"). The critical invariant is:
 *
 *   A valid (unexpired) lease can only be renewed by the worker that
 *   currently owns it; an expired lease can be reclaimed by another worker.
 *
 * Renewal therefore requires *both* the token and the `workerId` to match
 * the current row — token equality alone is not sufficient proof of
 * ownership.
 *
 * **`lockToken` rotates on every successful call, renew or reclaim alike.**
 * This is required, not cosmetic: if it did not rotate, two concurrent calls
 * racing with the same `observedLockToken` (e.g. two overlapping scanner
 * ticks for the same worker) would both still match the token equality
 * check after the first commits, and both would return `acquired: true` —
 * exactly the duplicate-execution bug this lock exists to prevent. Rotating
 * unconditionally means the second, later call's `observedLockToken` no
 * longer matches the row once the first has committed, so it correctly
 * fails and returns `acquired: false`.
 *
 * `lockedAt`, in contrast, is preserved across an ordinary renewal (only
 * reset to `NOW()` on an actual reclaim) so it continues to reflect when the
 * *current owning worker* first acquired the lease, not merely when it was
 * last renewed.
 *
 * **The caller must discard `observedLockToken` after a successful call and
 * use the returned `lockToken` for every subsequent `renewLock`/
 * `releaseLock` call in that poll step** — the old token no longer matches
 * the row.
 */
export async function renewOrReclaimLock(
  db: PrismaClient,
  jobId: string,
  workerId: string,
  observedLockToken: string | null,
  leaseDurationMs: number = DEFAULT_LEASE_DURATION_MS,
): Promise<LockResult> {
  const lockToken = randomUUID();
  const rows = await db.$queryRaw<Job[]>`
    UPDATE "Job"
    SET
      "lockedBy" = ${workerId},
      "lockToken" = ${lockToken},
      "lockedAt" = CASE
        WHEN "lockToken" = ${observedLockToken} AND "lockedBy" = ${workerId} AND "lockedUntil" >= NOW() THEN "lockedAt"
        ELSE NOW()
      END,
      "lockedUntil" = NOW() + (${leaseDurationMs}::text || ' milliseconds')::interval,
      "heartbeatAt" = NOW(),
      "updatedAt" = NOW()
    WHERE "id" = ${jobId}
      AND "status" = 'RUNNING'
      AND (
        "lockedUntil" IS NULL
        OR "lockedUntil" < NOW()
        OR ("lockToken" = ${observedLockToken} AND "lockedBy" = ${workerId} AND "lockedUntil" >= NOW())
      )
    RETURNING *
  `;
  const job = rows[0];
  return job ? { acquired: true, lockToken } : { acquired: false };
}

/**
 * Extends an already-held lease without changing its token. Used after a
 * poll step that is not yet terminal, so the lock survives until the next
 * scanner-driven poll is due. Requires both `lockToken` and `workerId` to
 * match the current row — refuses (does not throw) otherwise, e.g. because
 * another worker has since reclaimed an expired lease.
 *
 * `extendByMs` must be a finite, positive number. A zero, negative, or
 * non-finite value would either leave the lease unchanged or immediately
 * expire it, silently corrupting the lock — reject it outright instead.
 */
export async function renewLock(
  db: PrismaClient,
  jobId: string,
  lockToken: string,
  workerId: string,
  extendByMs: number,
): Promise<LockResult> {
  if (!Number.isFinite(extendByMs) || extendByMs <= 0) {
    throw new RangeError(`renewLock: extendByMs must be a finite, positive number of milliseconds, got ${extendByMs}.`);
  }
  const rows = await db.$queryRaw<Job[]>`
    UPDATE "Job"
    SET
      "lockedUntil" = NOW() + (${extendByMs}::text || ' milliseconds')::interval,
      "heartbeatAt" = NOW(),
      "updatedAt" = NOW()
    WHERE "id" = ${jobId}
      AND "status" = 'RUNNING'
      AND "lockToken" = ${lockToken}
      AND "lockedBy" = ${workerId}
    RETURNING *
  `;
  const job = rows[0];
  return job ? { acquired: true, lockToken } : { acquired: false };
}

/**
 * Releases a held lease early (e.g. after a poll step reaches a terminal
 * AiTask/Job state). Requires both `lockToken` and `workerId` to match.
 */
export async function releaseLock(db: PrismaClient, jobId: string, lockToken: string, workerId: string): Promise<void> {
  await db.job.updateMany({
    where: { id: jobId, lockToken, lockedBy: workerId },
    data: { lockedBy: null, lockToken: null, lockedAt: null, lockedUntil: null, heartbeatAt: null },
  });
}
