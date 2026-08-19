import type { Client as MinioClient } from "minio";

import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { GC_LOCK_KEYS, withAdvisoryLock } from "./gc-coordination.js";
import { sweepUnreferencedObjects, type SweepOutcome } from "./minio-orphan-scanner.js";

/**
 * Temporary-upload cleanup
 * (021-production-hardening-garbage-collection, User Story 4, FR-030).
 *
 * Two known temp/staging prefixes in this codebase (see the audit in this
 * feature's research.md decision 5):
 *
 * - `prepared-imports/` — the local-folder import flow's staging objects.
 *   Has a real session concept (`PreparedImport.status`/`deadlineAt`) — an
 *   object under an active import is protected by
 *   `minio-orphan-scanner.ts`'s narrowed `PreparedImportItem` reference
 *   checker (only an active-or-completed item protects its object; an
 *   abandoned/expired import's leftover items do not, or this cleanup could
 *   never reach them).
 * - `direct-uploads/` — the direct browser-upload flow. Has *no* durable
 *   session row (a presigned POST capability is a short-lived signed
 *   token, not a database record) — an unpublished upload is
 *   indistinguishable from an abandoned one except by age. The grace
 *   period alone is what protects a genuinely in-flight upload here; it
 *   must stay comfortably longer than upload + publish latency (FR-032 —
 *   "when uncertain, don't delete").
 *
 * A published object under either prefix keeps the same key as its Asset's
 * `storageKey` (publishing never renames it), so it is already protected
 * by the ordinary `Asset` reference checker once committed — this module
 * adds no separate "is it published" check of its own.
 */
export const DEFAULT_TEMP_UPLOAD_PREFIXES = ["prepared-imports/", "direct-uploads/"] as const;

export async function cleanupTempUploads(input: {
  db: PrismaClient;
  minio: MinioClient;
  bucket: string;
  dryRun?: boolean;
  gracePeriodMs: number;
  prefixes?: readonly string[];
}): Promise<Record<string, SweepOutcome>> {
  const prefixes = input.prefixes ?? DEFAULT_TEMP_UPLOAD_PREFIXES;
  const results: Record<string, SweepOutcome> = {};
  for (const prefix of prefixes) {
    results[prefix] = await sweepUnreferencedObjects({
      db: input.db, minio: input.minio, bucket: input.bucket, prefix,
      dryRun: input.dryRun ?? false, gracePeriodMs: input.gracePeriodMs,
    });
  }
  return results;
}

/**
 * Scheduled entry point (FR-053) — same cross-worker-replica coordination
 * as the orphan scanner (`GC_LOCK_KEYS.TEMP_UPLOAD_CLEANUP`, a distinct
 * lock key so this pass and the orphan scan can run independently of each
 * other, never blocking on the other's lock).
 */
export async function runScheduledTempUploadCleanup(input: {
  db: PrismaClient;
  minio: MinioClient;
  bucket: string;
  dryRun?: boolean;
  gracePeriodMs: number;
  prefixes?: readonly string[];
}): Promise<{ ran: true; outcomes: Record<string, SweepOutcome> } | { ran: false }> {
  const outcome = await withAdvisoryLock(input.db, GC_LOCK_KEYS.TEMP_UPLOAD_CLEANUP, (tx) => cleanupTempUploads({ ...input, db: tx }));
  return outcome.ran ? { ran: true, outcomes: outcome.result } : { ran: false };
}
