import type { Client as MinioClient } from "minio";

import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { sweepSingleObject, type SweepOutcome } from "./minio-orphan-scanner.js";

/**
 * Deleted-asset storage cleanup
 * (021-production-hardening-garbage-collection, User Story 4, FR-026/FR-027).
 *
 * A thin, asset-identity-scoped wrapper over the shared
 * `sweepSingleObject` primitive: given the storage key an Asset (or one of
 * its cached mirrors) referenced, remove the now-unreferenced object.
 *
 * Deliberately decoupled from any specific "delete an Asset" call site: the
 * repository audit for this feature found no existing code path that
 * deletes/soft-deletes an individual Asset today (only the `asset.delete`
 * permission and `Asset.deletedAt` field are scaffolded for a future
 * feature — see this feature's final report). This function is the safe,
 * tested cleanup primitive that call site must use once it exists; building
 * a new "delete an Asset" product feature is out of this hardening phase's
 * scope.
 *
 * Safe if the Asset row is already gone by the time this runs (the shared
 * reference check simply finds nothing, exactly as intended — FR-026's "the
 * database deletion itself must not depend synchronously on this
 * succeeding"). Retryable: a MinIO failure is reported, never thrown past
 * the caller in a way that would roll back a database transaction: it
 * follows the same isolated per-key `try/catch` shape
 * `minio-orphan-scanner.ts` already uses, so a caller can call this again
 * later (idempotent — see `minio-orphan-scanner.ts`'s own idempotency
 * guarantee) or simply rely on the periodic orphan scanner (the second
 * layer of protection FR-027 requires) to catch it eventually.
 */
export async function cleanupDeletedAssetObject(input: {
  db: PrismaClient;
  minio: MinioClient;
  bucket: string;
  key: string;
  dryRun?: boolean;
  gracePeriodMs?: number;
}): Promise<SweepOutcome> {
  return sweepSingleObject({
    db: input.db,
    minio: input.minio,
    bucket: input.bucket,
    key: input.key,
    dryRun: input.dryRun ?? false,
    // A deliberate, targeted cleanup of a specific asset's own object (not
    // an ambient full-bucket scan) can use a much shorter grace period than
    // the general orphan scanner — the object is already known to be
    // unreferenced by name, the grace period here only guards against the
    // same "just uploaded, not yet published" race the general scanner
    // guards against, not a lack of confidence about *why* it's orphaned.
    gracePeriodMs: input.gracePeriodMs ?? 0,
  });
}
