import "server-only";

import { JobStage } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { cleanupUnpublishedObject, publishUploadedAsset, UploadPublicationFailure } from "@/lib/asset-upload";
import { db } from "@/lib/db";
import { requirePreparedImportAccess } from "@/lib/imports/authorization";
import { getDirectUploadProviders } from "@/lib/providers";
import { verifyUploadCapability } from "@/lib/upload-capability";
import { UploadVerificationFailure, verifyUploadedObject } from "@/lib/upload-verification";

export async function completeLocalFolderItem(actor: RequestActor, preparedImportId: string, itemId: string, fileId: string) {
  const preparation = await requirePreparedImportAccess(actor, preparedImportId);
  if (!preparation || preparation.createdById !== actor.id || preparation.status !== "PREPARING") return { ok: false as const, status: 404 as const };
  const providers = getDirectUploadProviders();
  const capability = verifyUploadCapability(providers.config, fileId);
  if (!capability || capability.preparedImportId !== preparedImportId || capability.preparedImportItemId !== itemId || capability.actorId !== actor.id || capability.datasetId !== preparation.datasetId) return { ok: false as const, status: 400 as const };
  const item = await db.preparedImportItem.findFirst({ where: { id: itemId, preparedImportId }, select: { id: true, storageKey: true, assetId: true, filename: true, mimeType: true, sizeBytes: true } });
  if (!item || item.storageKey !== capability.objectKey || item.filename !== capability.filename || item.mimeType !== capability.candidateContentType || item.sizeBytes !== BigInt(capability.sizeBytes)) return { ok: false as const, status: 404 as const };
  if (item.assetId) {
    const completed = await db.preparedImportItem.count({ where: { preparedImportId, assetId: { not: null } } });
    return { ok: true as const, status: 200 as const, assetId: item.assetId, replayed: true, completed, total: preparation.expectedItemCount };
  }
  try {
    const verified = await verifyUploadedObject(providers.minio, providers.config.MINIO_BUCKET, item.storageKey, capability.sizeBytes, capability.candidateContentType);
    const published = await publishUploadedAsset({ capability, verified, bucket: providers.config.MINIO_BUCKET });
    const outcome = await db.$transaction(async (tx) => {
      const linked = await tx.preparedImportItem.updateMany({ where: { id: item.id, preparedImportId, assetId: null }, data: { assetId: published.asset.id, completedAt: new Date() } });
      const current = await tx.preparedImportItem.findUniqueOrThrow({ where: { id: item.id }, select: { assetId: true } });
      const completed = await tx.preparedImportItem.count({ where: { preparedImportId, assetId: { not: null } } });
      const total = preparation.expectedItemCount;
      // Asset.modality remains canonical. Dataset.primaryModality is only a
      // first-import UI default and must never constrain or overwrite later
      // modalities in a mixed Dataset.
      await tx.dataset.updateMany({ where: { id: preparation.datasetId, primaryModality: null }, data: { primaryModality: verified.modality } });
      await tx.job.update({ where: { id: preparation.jobId }, data: { stage: JobStage.WRITING_ASSETS, processedItems: completed, successItems: completed, progress: Math.floor((completed / total) * 100) } });
      return { assetId: current.assetId!, replayed: !linked.count || published.replayed, completed, total };
    });
    return { ok: true as const, status: outcome.replayed ? 200 as const : 201 as const, ...outcome };
  } catch (error) {
    await cleanupUnpublishedObject(providers.minio, providers.config.MINIO_BUCKET, capability.objectKey);
    if (error instanceof UploadVerificationFailure) return { ok: false as const, status: error.code === "UNSUPPORTED_MEDIA" ? 415 as const : 409 as const, code: error.code };
    if (error instanceof UploadPublicationFailure) return { ok: false as const, status: 409 as const, code: error.code };
    return { ok: false as const, status: 500 as const };
  }
}
