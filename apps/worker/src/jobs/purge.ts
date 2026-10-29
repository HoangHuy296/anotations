import { purgeAssetsJobInputSchema } from "@annotationplatform/domain/purge-job";
import type { Client as MinioClient } from "minio";

import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { getWorkerConfig } from "../config.js";
import { createRoutedWorkerMinio } from "../providers/sealed-namespace.js";
import { heartbeatJob } from "./job-claim-lock.js";

export type PurgeProcessResult = "completed" | "failed" | "refused";
export type PurgeKey = { bucket: string; key: string };

const DELETE_BATCH = 100;

function add(keys: Map<string, PurgeKey>, bucket: string | null | undefined, key: string | null | undefined, fallbackBucket: string) {
  if (!key) return;
  const b = bucket || fallbackBucket;
  keys.set(`${b}\u0000${key}`, { bucket: b, key });
}

/**
 * Every MinIO object that belongs to the dataset (or to the given assets). Captured BEFORE any row is deleted: the rows are the only record of the keys, and
 * the cascade removes them. `assetIds === null` means the whole dataset (including dataset-level artifacts: exports, AI results, visualizations).
 */
export async function capturePurgeKeys(db: PrismaClient, datasetId: string, assetIds: string[] | null, defaultBucket: string): Promise<PurgeKey[]> {
  const keys = new Map<string, PurgeKey>();
  const assetFilter = assetIds ? { id: { in: assetIds } } : {};
  const byAsset = assetIds ? { assetId: { in: assetIds } } : {};
  const [assets, versions, videos, verifications, preparedItems] = await Promise.all([
    db.asset.findMany({ where: { datasetId, ...assetFilter }, select: { storageBucket: true, storageKey: true, cacheBucket: true, cacheKey: true } }),
    db.assetVersion.findMany({ where: { datasetId, ...byAsset }, select: { storageBucket: true, storageKey: true, cacheBucket: true, cacheKey: true } }),
    db.videoAsset.findMany({ where: { asset: { datasetId, ...assetFilter } }, select: { thumbnailKey: true, frameStorageKey: true } }),
    db.mediaVerification.findMany({ where: { datasetId, ...byAsset }, select: { stagedBucket: true, stagedKey: true, sealedKey: true } }),
    db.preparedImportItem.findMany({ where: { preparedImport: { datasetId }, ...byAsset }, select: { storageKey: true } }),
  ]);
  for (const row of [...assets, ...versions]) {
    add(keys, row.storageBucket, row.storageKey, defaultBucket);
    add(keys, row.cacheBucket, row.cacheKey, defaultBucket);
  }
  for (const row of videos) { add(keys, null, row.thumbnailKey, defaultBucket); add(keys, null, row.frameStorageKey, defaultBucket); }
  for (const row of verifications) { add(keys, row.stagedBucket, row.stagedKey, defaultBucket); add(keys, row.stagedBucket, row.sealedKey, defaultBucket); }
  for (const row of preparedItems) add(keys, null, row.storageKey, defaultBucket);
  if (!assetIds) {
    const [artifacts, jobs, aiTasks] = await Promise.all([
      db.visualizationArtifact.findMany({ where: { datasetId }, select: { bucket: true, key: true } }),
      db.job.findMany({ where: { datasetId, resultStorageKey: { not: null } }, select: { resultStorageKey: true } }),
      db.aiTask.findMany({ where: { datasetId, resultStorageKey: { not: null } }, select: { resultStorageKey: true } }),
    ]);
    for (const row of artifacts) add(keys, row.bucket, row.key, defaultBucket);
    for (const row of jobs) add(keys, null, row.resultStorageKey, defaultBucket);
    for (const row of aiTasks) add(keys, null, row.resultStorageKey, defaultBucket);
  }
  return [...keys.values()];
}

/** Deletes every key (idempotent: removing an absent object is not an error). Sealed keys are routed to the verifier identity by the client. */
export async function deleteKeys(minio: MinioClient, keys: PurgeKey[], onBatch?: () => Promise<void>): Promise<number> {
  let deleted = 0;
  for (let offset = 0; offset < keys.length; offset += DELETE_BATCH) {
    for (const { bucket, key } of keys.slice(offset, offset + DELETE_BATCH)) {
      await minio.removeObject(bucket, key);
      deleted += 1;
    }
    await onBatch?.();
  }
  return deleted;
}

async function failPurge(db: PrismaClient, jobId: string, lockToken: string) {
  const now = new Date();
  await db.job.updateMany({
    where: { id: jobId, lockToken, status: "RUNNING" },
    data: { status: "FAILED", errorCode: "PURGE_FAILED", finishedAt: now, lockedBy: null, lockToken: null, lockedAt: null, lockedUntil: null, heartbeatAt: null },
  });
}

/**
 * Private worker processor for PURGE_DATASET / PURGE_ASSETS (owner-only permanent delete).
 *
 * Order is the crash-safety argument: (1) capture the keys while the rows still exist, (2) delete the MinIO objects (idempotent, retried with the Job),
 * (3) only then delete the PostgreSQL rows and write the PurgeAudit row in ONE transaction. A failure before (3) leaves the rows hidden (`deletedAt`) and
 * the Job FAILED, so nothing is half-forgotten; the Job row itself is removed by the dataset cascade when it succeeds, so the audit row is the durable result.
 */
export async function processPurge(db: PrismaClient, jobId: string, lockToken: string, minioOverride?: MinioClient): Promise<PurgeProcessResult> {
  const job = await db.job.findFirst({
    where: { id: jobId, type: { in: ["PURGE_DATASET", "PURGE_ASSETS"] }, lockToken, status: "RUNNING" },
    select: { id: true, type: true, datasetId: true, createdById: true, input: true },
  });
  if (!job) return "refused";
  const startedAt = new Date();
  try {
    const config = getWorkerConfig();
    let assetIds: string[] | null = null;
    if (job.type === "PURGE_ASSETS") {
      const parsed = purgeAssetsJobInputSchema.safeParse(job.input);
      if (!parsed.success) { await failPurge(db, jobId, lockToken); return "failed"; }
      assetIds = parsed.data.assetIds;
      // Defence in depth: only assets of THIS dataset that were already hidden by the request.
      const owned = await db.asset.findMany({ where: { id: { in: assetIds }, datasetId: job.datasetId, deletedAt: { not: null } }, select: { id: true } });
      assetIds = owned.map((row) => row.id);
    } else {
      const dataset = await db.dataset.findUnique({ where: { id: job.datasetId }, select: { deletedAt: true } });
      if (!dataset?.deletedAt) { await failPurge(db, jobId, lockToken); return "failed"; }
    }
    const keys = await capturePurgeKeys(db, job.datasetId, assetIds, config.MINIO_BUCKET);
    const minio = minioOverride ?? createRoutedWorkerMinio(config);
    const objectsDeleted = await deleteKeys(minio, keys, async () => { await heartbeatJob(db, { jobId, lockToken }); });
    await db.$transaction(async (tx) => {
      const assetCount = assetIds ? assetIds.length : await tx.asset.count({ where: { datasetId: job.datasetId } });
      await tx.purgeAudit.create({
        data: { kind: job.type, datasetId: job.datasetId, actorId: job.createdById, assetCount, objectCount: keys.length, objectsDeleted, startedAt, finishedAt: new Date() },
      });
      if (assetIds) {
        await tx.mediaVerification.deleteMany({ where: { datasetId: job.datasetId, assetId: { in: assetIds } } });
        await tx.preparedImportItem.deleteMany({ where: { assetId: { in: assetIds } } });
        await tx.asset.deleteMany({ where: { id: { in: assetIds }, datasetId: job.datasetId } });
        await tx.job.updateMany({
          where: { id: jobId, lockToken, status: "RUNNING" },
          data: { status: "COMPLETED", stage: "FINISHED", progress: 100, finishedAt: new Date(), lockedBy: null, lockToken: null, lockedAt: null, lockedUntil: null, heartbeatAt: null },
        });
      } else {
        await tx.dataset.delete({ where: { id: job.datasetId } });
      }
    }, { timeout: 120_000 });
    return "completed";
  } catch {
    await failPurge(db, jobId, lockToken);
    return "failed";
  }
}
