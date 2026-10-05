import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

import { cancelJob, completeJob, failJob, heartbeatJob, updateJobProgress } from "./job-claim-lock.js";
import { buildMirrorObjectKey, buildSourceFingerprint } from "./source-fingerprint.js";
import { chunkRepositoryCandidates, downloadRepositoryCandidate, listRepositoryCandidateListing, parseRepositoryImportInput } from "./repository-import-source.js";
import { mirrorRepositoryObject, safeCleanupUnpublishedObject } from "./repository-asset-mirror.js";
import { reconcileMirroredRepositoryAsset, upsertMirroredRepositoryAsset } from "./repository-asset-upsert.js";
import { verifyRepositoryObjectModality } from "./repository-media-classification.js";
import { writeSafeJobEvent } from "./job-event-writer.js";
import { resolveSourceAccessForJob, sourceAccessToRepositoryAccess } from "../source/source-access.js";
import { applyRepositoryImportTestPoint } from "./repository-import-test-hooks.js";
import { getWorkerConfig } from "../config.js";

type ImportResult = { kind: "local-receipt" | "repository-completed" | "repository-refused" | "not-applicable" };

async function acknowledgeCancellation(db: PrismaClient, jobId: string, lockToken: string) {
  const job = await db.job.findFirst({
    where: { id: jobId, lockToken, status: { in: ["RUNNING", "CANCELING"] } },
    select: { cancelRequestedAt: true, status: true },
  });
  if (!job || (!job.cancelRequestedAt && job.status !== "CANCELING")) return false;
  await cancelJob(db, { jobId, lockToken });
  return true;
}

/**
 * Local-folder imports remain a receipt-only workflow. Repository processing
 * is opt-in only when both the durable Dataset mode and safe Job input agree.
 */
export async function processImportDataset(db: PrismaClient, jobId: string, lockToken: string): Promise<ImportResult> {
  const preparation = await db.preparedImport.findUnique({ where: { jobId }, select: { id: true, status: true } });
  if (preparation) return { kind: "local-receipt" };

  const job = await db.job.findUnique({
    where: { id: jobId },
    select: { id: true, datasetId: true, createdById: true, input: true, sourceConnectionId: true, dataset: { select: { sourceMode: true, modality: true, sourceRootPath: true } } },
  });
  const source = job ? parseRepositoryImportInput(job.input) : null;
  if (!job || job.dataset.sourceMode !== "MIRROR_TO_MINIO" || !source) return { kind: "not-applicable" };
  if (job.dataset.modality === null) {
    await db.job.updateMany({ where: { id: job.id, lockToken, status: "RUNNING" }, data: { errorCode: "DATASET_MODALITY_UNRESOLVED" } });
    await failJob(db, { jobId: job.id, lockToken });
    return { kind: "repository-refused" };
  }
  const datasetModality = job.dataset.modality;

  let safeFailureCode = "REPOSITORY_IMPORT_FAILED";
  try {
    await applyRepositoryImportTestPoint(db, job.id, "CANCEL_BEFORE_PROVIDER");
    if (await acknowledgeCancellation(db, job.id, lockToken)) return { kind: "repository-refused" };
    const accessResolution = await resolveSourceAccessForJob(db, job.id);
    const access = sourceAccessToRepositoryAccess(accessResolution);
    if (!access) {
      await db.job.updateMany({ where: { id: job.id, lockToken, status: "RUNNING" }, data: { errorCode: accessResolution.kind === "refused" ? accessResolution.errorCode : "SOURCE_CONNECTION_NOT_FOUND" } });
      await failJob(db, { jobId: job.id, lockToken });
      return { kind: "repository-refused" };
    }
    const scanning = await updateJobProgress(db, { jobId: job.id, lockToken, stage: "SCANNING_FILES", progress: 1, totalItems: source.manifest.itemCount, processedItems: 0, successItems: 0, failedItems: 0, skippedItems: 0 });
    if (scanning.kind !== "updated") throw new Error("LOCK_LOST");
    if (await acknowledgeCancellation(db, job.id, lockToken)) return { kind: "repository-refused" };
    safeFailureCode = "SOURCE_LIST_FAILED";
    const listing = await listRepositoryCandidateListing({ source, access });
    const { candidates } = listing;
    let imported = 0;
    let unchanged = 0;
    let rejected = 0;
    let retryable = 0;
    let skipped = 0;
    const totalItems = candidates.length + listing.skippedItems;
    const batches = chunkRepositoryCandidates(candidates);
    for (const [batchIndex, batch] of batches.entries()) {
      if (await acknowledgeCancellation(db, job.id, lockToken)) return { kind: "repository-refused" };
      for (const candidate of batch) {
        const live = await heartbeatJob(db, { jobId: job.id, lockToken });
        if (live.kind !== "updated") throw new Error("LOCK_LOST");
        const fingerprint = buildSourceFingerprint({ provider: source.repository.provider, owner: source.repository.owner, repository: source.repository.repo, path: candidate.path });
        const objectKey = buildMirrorObjectKey({ datasetId: job.datasetId, sourceFingerprint: fingerprint, revision: candidate.revision, providerFileIdentity: candidate.providerFileIdentity });
        let published: { bucket: string; objectKey: string } | null = null;
        try {
          if (await acknowledgeCancellation(db, job.id, lockToken)) return { kind: "repository-refused" };
          safeFailureCode = "SOURCE_RECONCILIATION_FAILED";
          const reconciled = await reconcileMirroredRepositoryAsset({ db, datasetId: job.datasetId, sourceFingerprint: fingerprint, candidate, bucket: getWorkerConfig().MINIO_BUCKET, objectKey });
          if (reconciled.kind === "conflict") throw new Error("SOURCE_RECONCILIATION_CONFLICT");
          if (reconciled.kind === "reusable") { unchanged += 1; continue; }
          await updateJobProgress(db, { jobId: job.id, lockToken, stage: "UPLOADING_OBJECTS", progress: Math.max(1, Math.floor(((imported + unchanged + rejected + retryable + skipped) / totalItems) * 80)), processedItems: imported + unchanged + rejected + retryable + skipped, successItems: imported + unchanged, failedItems: rejected + retryable, skippedItems: skipped });
          await applyRepositoryImportTestPoint(db, job.id, "BEFORE_UPLOAD");
          safeFailureCode = "SOURCE_DOWNLOAD_FAILED";
          const downloaded = await downloadRepositoryCandidate(candidate, access);
          safeFailureCode = "MINIO_UPLOAD_FAILED";
          published = await mirrorRepositoryObject({ objectKey, body: downloaded.body, sizeBytes: downloaded.sizeBytes });
          await applyRepositoryImportTestPoint(db, job.id, "CANCEL_AFTER_UPLOAD");
          if (await acknowledgeCancellation(db, job.id, lockToken)) {
            await safeCleanupUnpublishedObject(db, { bucket: published.bucket, objectKey: published.objectKey, datasetId: job.datasetId });
            return { kind: "repository-refused" };
          }
          await applyRepositoryImportTestPoint(db, job.id, "AFTER_UPLOAD_BEFORE_PERSIST");
          await updateJobProgress(db, { jobId: job.id, lockToken, stage: "WRITING_ASSETS", progress: Math.max(1, Math.floor(((imported + unchanged + rejected + retryable + skipped) / totalItems) * 80) + 10), processedItems: imported + unchanged + rejected + retryable + skipped, successItems: imported + unchanged, failedItems: rejected + retryable, skippedItems: skipped });
          const verifiedModality = await verifyRepositoryObjectModality({ jobId: job.id, bucket: published.bucket, objectKey: published.objectKey, expectedSizeBytes: downloaded.sizeBytes });
          if (verifiedModality !== datasetModality) throw new Error("ASSET_MODALITY_MISMATCH");
          safeFailureCode = "ASSET_PERSIST_FAILED";
          const publication = await upsertMirroredRepositoryAsset({ db, datasetId: job.datasetId, uploadedById: job.createdById, provider: source.repository.provider, candidate, verifiedModality, sourceFingerprint: fingerprint, bucket: published.bucket, objectKey: published.objectKey, sourceRootPath: job.dataset.sourceRootPath });
          if (publication.modality !== datasetModality) throw new Error("ASSET_MODALITY_MISMATCH");
          imported += 1;
        } catch (error) {
          if (published) await safeCleanupUnpublishedObject(db, { bucket: published.bucket, objectKey: published.objectKey, datasetId: job.datasetId });
          // A candidate that the provider cannot download is a bounded
          // item-level failure.  Continue the batch and expose only its
          // aggregate count; all other source/storage/DB/lock failures remain
          // terminal and use the existing safe failure policy.
          if (error instanceof Error && error.message === "SOURCE_DOWNLOAD_FAILED") {
            retryable += 1;
            continue;
          }
          if (error instanceof Error && ["ASSET_MODALITY_MISMATCH", "SOURCE_CONTENT_UNVERIFIED", "SOURCE_CONTENT_UNSUPPORTED"].includes(error.message)) {
            // Fail-closed byte classification is an explicit item rejection,
            // never a silent skip or a whole-import success.
            rejected += 1;
            continue;
          }
          throw error;
        }
      }
      // Unsupported entries are deliberately accounted for only after every
      // supported candidate has reached a safe boundary.  This makes the
      // persisted outcome monotonic and ensures terminal equality.
      if (batchIndex === batches.length - 1) skipped = listing.skippedItems;
      const processedItems = imported + unchanged + rejected + retryable + skipped;
      const batchProgress = Math.max(1, Math.floor((processedItems / totalItems) * 90));
      const progressResult = await updateJobProgress(db, {
        jobId: job.id, lockToken, stage: "WRITING_ASSETS", progress: batchProgress,
        totalItems, processedItems, successItems: imported + unchanged, failedItems: rejected + retryable, skippedItems: skipped,
      });
      if (progressResult.kind !== "updated") throw new Error("LOCK_LOST");
      await writeSafeJobEvent(db, { jobId: job.id, kind: "IMPORT_BATCH_COMPLETED", aggregate: { imported: imported + unchanged, skipped, failed: rejected + retryable } });
      await applyRepositoryImportTestPoint(db, job.id, "CANCEL_AFTER_BATCH");
      if (await acknowledgeCancellation(db, job.id, lockToken)) return { kind: "repository-refused" };
    }
    await applyRepositoryImportTestPoint(db, job.id, "AFTER_PERSIST_BEFORE_COMPLETE");
    if (await acknowledgeCancellation(db, job.id, lockToken)) return { kind: "repository-refused" };
    const processedItems = imported + unchanged + rejected + retryable + skipped;
    const finalSummary = { outcome: rejected || retryable || skipped ? "incomplete" : "completed", accepted: imported, unchanged, rejected, retryable, unprocessed: Math.max(0, totalItems - processedItems), skipped };
    if (rejected || retryable || skipped) {
      const recorded = await updateJobProgress(db, { jobId: job.id, lockToken, stage: "WRITING_ASSETS", progress: 100, totalItems, processedItems, successItems: imported + unchanged, failedItems: rejected + retryable, skippedItems: skipped });
      if (recorded.kind !== "updated") return { kind: "repository-refused" };
      await failJob(db, { jobId: job.id, lockToken, stage: "FINISHED", errorCode: "IMPORT_INCOMPLETE", summary: { ...finalSummary, outcome: "incomplete" }, progress: 100, totalItems, processedItems, successItems: imported + unchanged, failedItems: rejected + retryable, skippedItems: skipped });
      return { kind: "repository-refused" };
    }
    const completed = await completeJob(db, {
      jobId: job.id, lockToken, stage: "FINISHED", progress: 100, totalItems, processedItems, successItems: imported + unchanged, failedItems: 0, skippedItems: skipped,
      summary: { resultCount: imported + unchanged, ...finalSummary },
    });
    if (completed.kind !== "updated") return { kind: "repository-refused" };
    await applyRepositoryImportTestPoint(db, job.id, "AFTER_COMPLETE_BEFORE_ACK");
    return { kind: "repository-completed" };
  } catch (error) {
    // Only explicitly machine-safe, uppercase worker codes are persisted. This
    // keeps provider/Prisma diagnostics out of PostgreSQL while retaining a
    // precise actionable code for bounded internal policy failures.
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,119}$/.test(error.message) ? error.message : safeFailureCode;
    await db.job.updateMany({ where: { id: job.id, lockToken, status: "RUNNING" }, data: { errorCode: code } });
    await failJob(db, { jobId: job.id, lockToken });
    return { kind: "repository-refused" };
  }
}
