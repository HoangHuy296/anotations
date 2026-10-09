import "server-only";

import { JobStage } from "@internal/db";
import { AssetWritesQuiescedError } from "@annotationplatform/domain/asset-write-quiescence";

import type { RequestActor } from "@/lib/auth";
import { cleanupUnpublishedObject, publishUploadedAsset, UploadPublicationFailure } from "@/lib/asset-upload";
import { db } from "@/lib/db";
import { requirePreparedImportAccess } from "@/lib/imports/authorization";
import { computeFolderAggregate, folderCounts, persistFolderAggregate } from "@/lib/imports/folder-accounting";
import { replayExistingVerification, routeToMediaVerification } from "@/lib/media-verification/routing";
import { getDirectUploadProviders } from "@/lib/providers";
import { verifyUploadCapability } from "@/lib/upload-capability";
import { UploadVerificationFailure, verifyUploadedObject } from "@/lib/upload-verification";

export async function completeLocalFolderItem(actor: RequestActor, preparedImportId: string, itemId: string, fileId: string) {
  const preparation = await requirePreparedImportAccess(actor, preparedImportId);
  if (!preparation || preparation.createdById !== actor.id || preparation.status !== "PREPARING") return { ok: false as const, status: 404 as const };
  const providers = getDirectUploadProviders();
  const capability = verifyUploadCapability(providers.config, fileId);
  if (!capability || capability.preparedImportId !== preparedImportId || capability.preparedImportItemId !== itemId || capability.actorId !== actor.id || capability.datasetId !== preparation.datasetId) return { ok: false as const, status: 400 as const };
  const item = await db.preparedImportItem.findFirst({ where: { id: itemId, preparedImportId }, select: { id: true, storageKey: true, assetId: true, filename: true, mimeType: true, sizeBytes: true, normalizedPath: true } });
  if (!item || item.storageKey !== capability.objectKey || item.filename !== capability.filename || item.mimeType !== capability.candidateContentType || item.sizeBytes !== BigInt(capability.sizeBytes)) return { ok: false as const, status: 404 as const };
  const parent = await db.dataset.findFirst({ where: { id: preparation.datasetId, deletedAt: null, archivedAt: null }, select: { modality: true } });
  if (!parent) return { ok: false as const, status: 404 as const };
  if (parent.modality === null) return { ok: false as const, status: 409 as const, code: "DATASET_MODALITY_UNRESOLVED" as const };
  if (item.assetId) {
    const completedAsset = await db.asset.findFirst({ where: { id: item.assetId, datasetId: preparation.datasetId, deletedAt: null }, select: { modality: true } });
    if (!completedAsset) return { ok: false as const, status: 409 as const, code: "UPLOAD_CONFLICT" as const };
    if (completedAsset.modality !== parent.modality) return { ok: false as const, status: 409 as const, code: "ASSET_MODALITY_MISMATCH" as const };
    const completed = await db.preparedImportItem.count({ where: { preparedImportId, assetId: { not: null } } });
    const job = await db.job.findUnique({ where: { id: preparation.jobId }, select: { summary: true } });
    const summary = job?.summary && typeof job.summary === "object" && !Array.isArray(job.summary) ? job.summary as Record<string, unknown> : {};
    return { ok: true as const, status: 200 as const, assetId: item.assetId, replayed: true, disposition: "unchanged" as const, accepted: Number(summary.accepted) || 0, unchanged: Number(summary.unchanged) || 0, rejected: Number(summary.rejected) || 0, retryable: Number(summary.retryable) || 0, unprocessed: Number(summary.unprocessed) || 0, completed, total: preparation.expectedItemCount };
  }
  // A2: a live or PUBLISHED verification for this item answers a repeated completion without touching the (possibly sealed and removed) staged object.
  const pendingReplay = await replayExistingVerification({ bucket: providers.config.MINIO_BUCKET, objectKey: item.storageKey, preparedImportItemId: item.id });
  if (pendingReplay) {
    const aggregate = await db.$transaction(async (tx) => { const next = await computeFolderAggregate(tx, preparedImportId, preparation.jobId, preparation.expectedItemCount); await persistFolderAggregate(tx, preparation.jobId, preparation.expectedItemCount, next); return next; });
    return { ok: true as const, status: 202 as const, verification: pendingReplay.dto, replayed: true, completed: aggregate.completed, total: preparation.expectedItemCount, ...folderCounts(aggregate) };
  }
  try {
    const verified = await verifyUploadedObject(providers.minio, providers.config.MINIO_BUCKET, item.storageKey, capability.sizeBytes, capability.candidateContentType);
    // specs/027-coco-dataset-export §4/§10: the folder-relative path is the
    // canonical identity source for a folder import, not the bare filename.
    const published = await publishUploadedAsset({ capability, verified, bucket: providers.config.MINIO_BUCKET, relativePathHint: item.normalizedPath });
    const outcome = await db.$transaction(async (tx) => {
      const linked = await tx.preparedImportItem.updateMany({ where: { id: item.id, preparedImportId, assetId: null }, data: { assetId: published.asset.id, completedAt: new Date() } });
      const current = await tx.preparedImportItem.findUniqueOrThrow({ where: { id: item.id }, select: { assetId: true } });
      const total = preparation.expectedItemCount;
      const disposition = !linked.count || published.replayed ? "unchanged" as const : "accepted" as const;
      // One durable success disposition per item; retries cannot inflate accepted counts.
      await tx.jobEvent.createMany({ data: [{ id: `phase029_import_success_${item.id}`, jobId: preparation.jobId, level: "INFO", stage: JobStage.WRITING_ASSETS, message: "IMPORT_ITEM_SUCCEEDED", data: { itemId: item.id, disposition } }], skipDuplicates: true });
      const aggregate = await computeFolderAggregate(tx, preparedImportId, preparation.jobId, total);
      await persistFolderAggregate(tx, preparation.jobId, total, aggregate);
      return { assetId: current.assetId!, replayed: !linked.count || published.replayed, disposition, completed: aggregate.completed, total, ...folderCounts(aggregate) };
    });
    return { ok: true as const, status: outcome.replayed ? 200 as const : 201 as const, ...outcome };
  } catch (error) {
    // A2: an unclassifiable object, declared video/mp4|webm into a VIDEO Dataset, is verified by the durable pipeline instead of being deleted and counted as rejected.
    // The folder keeps accounting it as `verifying`; new admissions are refused once the import's own deadline has passed.
    if (error instanceof UploadVerificationFailure && error.code === "UNSUPPORTED_MEDIA" && preparation.deadlineAt.getTime() > Date.now()) {
      const routed = await routeToMediaVerification({ minio: providers.minio, bucket: providers.config.MINIO_BUCKET, capability, source: "LOCAL_FOLDER_ITEM", preparedImportItemId: item.id, relativePathHint: item.normalizedPath });
      if (routed.kind === "refused") return { ok: false as const, status: routed.result.status, code: routed.result.code, ...(routed.result.status === 429 ? { scope: routed.result.scope, limit: routed.result.limit } : {}) };
      if (routed.kind === "not_ready") return { ok: false as const, status: 409 as const, code: "UPLOAD_NOT_READY" as const };
      if (routed.kind === "admitted") {
        const aggregate = await db.$transaction(async (tx) => { const next = await computeFolderAggregate(tx, preparedImportId, preparation.jobId, preparation.expectedItemCount); await persistFolderAggregate(tx, preparation.jobId, preparation.expectedItemCount, next); return next; });
        return { ok: true as const, status: 202 as const, verification: routed.dto, replayed: routed.replayed, completed: aggregate.completed, total: preparation.expectedItemCount, ...folderCounts(aggregate) };
      }
    }
    await cleanupUnpublishedObject(providers.minio, providers.config.MINIO_BUCKET, capability.objectKey);
    let code: string;
    let status: 409 | 415 | 422 | 503 | 500;
    let outcome: "rejected" | "retryable";
    if (error instanceof UploadVerificationFailure) {
      code = error.code;
      status = error.code === "UNSUPPORTED_MEDIA" ? 415 : error.code === "INVALID_MEDIA" ? 422 : 409;
      outcome = error.code === "UPLOAD_NOT_READY" ? "retryable" : "rejected";
    } else if (error instanceof UploadPublicationFailure) {
      code = error.code;
      status = error.code === "INVALID_RELATIVE_PATH" ? 422 : 409;
      outcome = error.code === "ASSET_MODALITY_MISMATCH" || error.code === "DATASET_MODALITY_UNRESOLVED" || error.code === "INVALID_RELATIVE_PATH" ? "rejected" : "retryable";
    } else if (error instanceof AssetWritesQuiescedError) {
      code = "ASSET_WRITES_PAUSED_FOR_MIGRATION"; status = 503; outcome = "retryable";
    } else {
      code = "IMPORT_ITEM_RETRYABLE"; status = 500; outcome = "retryable";
    }
    const stableEventId = `phase029_${outcome}_${item.id}`;
    const aggregate = await db.$transaction(async (tx) => {
      await tx.jobEvent.createMany({ data: [{ id: stableEventId, jobId: preparation.jobId, level: outcome === "rejected" ? "WARN" : "INFO", message: outcome === "rejected" ? "IMPORT_ITEM_REJECTED" : "IMPORT_ITEM_RETRYABLE", data: { itemId: item.id, code } }], skipDuplicates: true });
      const aggregate = await computeFolderAggregate(tx, preparedImportId, preparation.jobId, preparation.expectedItemCount);
      await persistFolderAggregate(tx, preparation.jobId, preparation.expectedItemCount, aggregate, { incomplete: true });
      const summary = { outcome: "incomplete" as const, ...folderCounts(aggregate) };
      return summary;
    });
    return { ok: false as const, status, code, ...aggregate };
  }
}
