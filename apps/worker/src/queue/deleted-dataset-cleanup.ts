import type { Client as MinioClient } from "minio";

import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { sweepSingleObject, type SweepOutcome } from "./minio-orphan-scanner.js";

export type CapturedStorageKey = { bucket: string; key: string };

/**
 * Deleted-dataset storage cleanup
 * (021-production-hardening-garbage-collection, User Story 4, FR-028/FR-029).
 *
 * `Asset.dataset` and `AssetVersion.dataset` are both `onDelete: Cascade` in
 * `prisma/schema.prisma` — a hard `dataset.delete()` removes every one of
 * that Dataset's Asset/AssetVersion rows in the same database operation.
 * Their storage keys are therefore only ever readable *before* that delete
 * commits; this module's exported entry point performs the capture and the
 * delete inside one transaction so that ordering can never be gotten wrong
 * by a caller.
 *
 * The repository audit for this feature found no existing code path that
 * hard-deletes a Dataset today — `DELETE /api/datasets/[datasetId]` only
 * archives it (`archivedAt`), which does not cascade and needs no cleanup
 * (an archived Dataset's Assets remain fully valid, referenced records).
 * This module is the safe, tested primitive a future hard-delete feature
 * must build on; it does not itself add a "permanently delete this
 * Dataset" route or UI — that would be a new product feature, out of this
 * hardening phase's scope.
 */
export async function captureDatasetAssetStorageKeys(db: PrismaClient, datasetId: string): Promise<CapturedStorageKey[]> {
  const [assets, versions] = await Promise.all([
    db.asset.findMany({ where: { datasetId }, select: { storageBucket: true, storageKey: true, cacheBucket: true, cacheKey: true } }),
    db.assetVersion.findMany({ where: { datasetId }, select: { storageBucket: true, storageKey: true, cacheBucket: true, cacheKey: true } }),
  ]);
  const keys: CapturedStorageKey[] = [];
  for (const row of [...assets, ...versions]) {
    if (row.storageBucket && row.storageKey) keys.push({ bucket: row.storageBucket, key: row.storageKey });
    if (row.cacheBucket && row.cacheKey) keys.push({ bucket: row.cacheBucket, key: row.cacheKey });
  }
  return keys;
}

/**
 * Captures every affected storage key, then hard-deletes the Dataset
 * (triggering the cascade) — both inside one transaction, so no Asset can
 * be added/removed between the read and the delete, and the caller can
 * never accidentally call this out of order.
 */
export async function hardDeleteDatasetAndCaptureStorageKeys(db: PrismaClient, datasetId: string): Promise<CapturedStorageKey[]> {
  return db.$transaction(async (tx) => {
    const keys = await captureDatasetAssetStorageKeys(tx as PrismaClient, datasetId);
    await tx.dataset.delete({ where: { id: datasetId } });
    return keys;
  });
}

/**
 * Batched cleanup over a pre-captured key list (never re-derived after the
 * fact — see module doc above). Each key goes through the same
 * `sweepSingleObject` reference re-check as every other GC path, so a key
 * that turns out to still be referenced elsewhere (the data model does not
 * currently support that, but this stays conservative regardless — FR-032)
 * is preserved rather than assumed safe to delete.
 */
export async function cleanupDatasetStorageObjects(input: {
  db: PrismaClient;
  minio: MinioClient;
  keys: CapturedStorageKey[];
  dryRun?: boolean;
  gracePeriodMs?: number;
  batchSize?: number;
}): Promise<SweepOutcome> {
  const batchSize = Math.max(1, input.batchSize ?? 100);
  const combined: SweepOutcome = { scanned: 0, orphans: [], deleted: [], tooYoung: [], failed: [] };
  for (let offset = 0; offset < input.keys.length; offset += batchSize) {
    const batch = input.keys.slice(offset, offset + batchSize);
    for (const item of batch) {
      const result = await sweepSingleObject({
        db: input.db, minio: input.minio, bucket: item.bucket, key: item.key,
        dryRun: input.dryRun ?? false, gracePeriodMs: input.gracePeriodMs ?? 0,
      });
      combined.scanned += result.scanned;
      combined.orphans.push(...result.orphans);
      combined.deleted.push(...result.deleted);
      combined.tooYoung.push(...result.tooYoung);
      combined.failed.push(...result.failed);
    }
  }
  return combined;
}
