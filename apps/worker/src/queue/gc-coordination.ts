import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

/**
 * Cross-worker coordination for scheduled, destructive GC passes
 * (021-production-hardening-garbage-collection, research.md decision 6).
 *
 * Every row-atomic scheduled pass in this feature (stale-job recovery,
 * dead-letter, JobEvent retention, deleted-asset/dataset cleanup) needs no
 * lock at all — two worker replicas racing the same row simply both
 * attempt the same conditional `UPDATE`/delete-if-still-orphaned check, and
 * at most one succeeds, exactly like `job.repository.ts#claimJob` already
 * relies on. The one pass that is *not* naturally row-atomic is the
 * full-bucket/prefix MinIO orphan scan: it lists external MinIO state
 * rather than claiming Postgres rows, so nothing stops two replicas from
 * both running the (wasteful, if pointless) full listing at once.
 *
 * `pg_try_advisory_lock` is a built-in PostgreSQL primitive — not a new,
 * independent locking system (the one thing AGENTS.md forbids) — used here
 * to serialize exactly that one listing pass across replicas. It is
 * session-scoped: acquiring and releasing it must happen on the *same*
 * underlying connection, which is why this helper wraps its callback in
 * one Prisma interactive `$transaction` (guaranteed single connection)
 * rather than issuing separate pooled `$queryRaw` calls that could each
 * land on a different pooled connection and silently fail to coordinate
 * anything.
 */
export async function withAdvisoryLock<T>(
  db: PrismaClient,
  lockKey: number,
  fn: (tx: PrismaClient) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<{ ran: true; result: T } | { ran: false }> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_lock(${lockKey}) AS locked`;
    if (!rows[0]?.locked) return { ran: false as const };
    try {
      const result = await fn(tx as PrismaClient);
      return { ran: true as const, result };
    } finally {
      // Always attempt release even if `fn` throws — an uncaught error
      // still ends this transaction (and Postgres would release a
      // session-level advisory lock when the connection returns to the
      // pool/closes regardless), but releasing explicitly here means the
      // lock is free again immediately rather than only once the pooled
      // connection happens to be recycled.
      await tx.$queryRaw`SELECT pg_advisory_unlock(${lockKey})`;
    }
  }, { timeout: options.timeoutMs ?? 10 * 60_000, maxWait: 5_000 });
}

/** Fixed, distinct advisory-lock keys — one per scheduled GC pass that needs mutual exclusion. */
export const GC_LOCK_KEYS = {
  MINIO_ORPHAN_SCAN: 72_190_001,
  TEMP_UPLOAD_CLEANUP: 72_190_002,
  JOB_EVENT_RETENTION: 72_190_003,
} as const;
