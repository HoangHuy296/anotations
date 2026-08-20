import { logMaintenanceEvent } from "@annotationplatform/domain";

import { Prisma, type PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { GC_LOCK_KEYS, withAdvisoryLock } from "./gc-coordination.js";

/**
 * JobEvent retention cleanup
 * (021-production-hardening-garbage-collection, User Story 5, FR-034–036).
 *
 * Deletes `JobEvent` rows older than `retentionDays`, but only for a Job
 * already in a terminal state (`COMPLETED`/`FAILED`/`CANCELED`) — an active
 * Job's events are never touched regardless of age (FR-036). Processes in
 * bounded batches via `DELETE ... WHERE id IN (SELECT ... LIMIT n)`, the
 * standard batched-delete idiom, rather than one unbounded `DELETE`
 * (FR-035). `maxBatchesPerRun` caps how much a single scheduled tick
 * drains, so a very large backlog spreads across multiple ticks instead of
 * one long-running call blocking the interval timer.
 *
 * Safe to run repeatedly: once a batch of candidates is deleted, it is
 * simply absent from the next query — re-running finds nothing left to do
 * and is a clean no-op (FR-035's "safe to run repeatedly").
 */
export async function cleanupOldJobEvents(input: {
  db: PrismaClient;
  retentionDays: number;
  batchSize: number;
  maxBatchesPerRun?: number;
  now?: Date;
  /**
   * Test-only narrowing: when provided, only these Jobs' events are ever
   * considered. Never set by the scheduled production entry point (which
   * must sweep the whole table) — exists solely so tests can safely assert
   * exact counts against their own fixture without any risk of touching
   * (or, worse, actually deleting) unrelated real rows in a shared
   * database. This is not optional polish: an earlier version of this
   * module's test suite asserted an unscoped global count and, on its
   * first real run, deleted real pre-existing JobEvent rows from the dev
   * database along with its own fixture data.
   */
  onlyJobIds?: string[];
}): Promise<{ deleted: number; batches: number; exhaustedMaxBatches: boolean }> {
  const maxBatches = input.maxBatchesPerRun ?? 20;
  const now = input.now ?? new Date();
  let totalDeleted = 0;
  let batches = 0;
  let exhaustedMaxBatches = false;

  // Prisma.sql/Prisma.join compose this fragment as a properly parameterized
  // query — never string-interpolated SQL — regardless of whether
  // onlyJobIds is supplied.
  const scopeClause = input.onlyJobIds
    ? Prisma.sql`AND e."jobId" IN (${Prisma.join(input.onlyJobIds)})`
    : Prisma.empty;

  for (; batches < maxBatches; batches += 1) {
    const rows = await input.db.$queryRaw<Array<{ id: string }>>`
      DELETE FROM "JobEvent"
      WHERE id IN (
        SELECT e.id
        FROM "JobEvent" e
        JOIN "Job" j ON j.id = e."jobId"
        WHERE e."createdAt" < ${now} - (${input.retentionDays}::text || ' days')::interval
          AND j.status IN ('COMPLETED', 'FAILED', 'CANCELED')
          ${scopeClause}
        LIMIT ${input.batchSize}
      )
      RETURNING id
    `;
    totalDeleted += rows.length;
    if (rows.length < input.batchSize) {
      batches += 1;
      break;
    }
    if (batches + 1 >= maxBatches) exhaustedMaxBatches = true;
  }

  return { deleted: totalDeleted, batches, exhaustedMaxBatches };
}

/**
 * Scheduled entry point (FR-053). Coordinated across worker replicas the
 * same way as the MinIO GC passes (`gc-coordination.ts`) — a bulk `DELETE`
 * over an unbounded row set isn't naturally row-atomic the way a single
 * conditional `UPDATE ... WHERE id = ...` is, so this uses the same
 * advisory-lock primitive rather than risking two replicas racing batches
 * against each other.
 */
export async function runScheduledJobEventRetention(input: {
  db: PrismaClient;
  retentionDays: number;
  batchSize: number;
  maxBatchesPerRun?: number;
  /** Test-only — see `cleanupOldJobEvents`. Never set in production. */
  onlyJobIds?: string[];
}): Promise<{ ran: true; deleted: number; batches: number } | { ran: false }> {
  const startedAt = Date.now();
  const outcome = await withAdvisoryLock(input.db, GC_LOCK_KEYS.JOB_EVENT_RETENTION, (tx) => cleanupOldJobEvents({ ...input, db: tx }));
  if (!outcome.ran) return { ran: false };
  logMaintenanceEvent("JOB_EVENT_RETENTION_SWEPT", {
    retentionDays: input.retentionDays,
    batchSize: input.batchSize,
    deleted: outcome.result.deleted,
    batches: outcome.result.batches,
    durationMs: Date.now() - startedAt,
  });
  return { ran: true, deleted: outcome.result.deleted, batches: outcome.result.batches };
}
