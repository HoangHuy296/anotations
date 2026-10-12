import { createHash } from "node:crypto";

import { AssetWritesQuiescedError } from "@annotationplatform/domain/asset-write-quiescence";
import { normalizeAssetRelativePath } from "@annotationplatform/domain/asset-relative-path";
import { a2SourceFingerprintInput, containerMimeType } from "@annotationplatform/domain/media-verification";

import { Prisma } from "../../../../lib/generated/prisma/client.js";
import { completeJobForPublished, swapResult, terminalizeVerification } from "./terminalize.js";
import { itemEventId, recomputeFolderAccounting } from "./folder-accounting.js";
import { identitiesEqual, identityFromStat, isObjectNotFound } from "./identity.js";
import type { StepContext, StepResult, VerificationRow } from "./types.js";

type StoredProbe = { formatName: string | null; durationMs: number | null; streams: Array<{ type: string; codec: string | null; width: number | null; height: number | null; picture: boolean }> };

class PublishAborted extends Error { constructor(readonly outcome: "lost_cas" | "lease_lost") { super(outcome); } }

const RETRY_AFTER_QUIESCENCE_MS = 60_000;

/**
 * P3 — publication (contract section 5.3 step 3). VERIFIED -> PUBLISHED | REJECTED(path) | STALE | CANCELED | EXPIRED.
 * Uses ONLY persisted verification evidence (never the staging key, never the declared MIME). One database transaction creates the Asset + VideoAsset and flips the
 * verification to PUBLISHED, so no Asset can exist without a PUBLISHED verification and no PUBLISHED verification without its Asset.
 */
export async function publishStep(ctx: StepContext, row: VerificationRow): Promise<StepResult> {
  const { db, deps } = ctx;
  const stale = (reason: "SOURCE_SEALED_CHANGED" | "DATASET_EVIDENCE_CHANGED") => terminalizeVerification(ctx, row, { status: "STALE", resultCode: "UPLOAD_SOURCE_CHANGED", resultReason: reason, jobErrorCode: "UPLOAD_SOURCE_CHANGED", jobErrorKind: "STALE_EVIDENCE" }).then(swapResult);

  try { await deps.assertWritesNotQuiesced(); }
  catch (error) { if (error instanceof AssetWritesQuiescedError) return { kind: "retry_later", runAfter: new Date(deps.now().getTime() + RETRY_AFTER_QUIESCENCE_MS) }; throw error; }

  const dataset = await db.dataset.findFirst({ where: { id: row.datasetId }, select: { modality: true, archivedAt: true, deletedAt: true } });
  if (!dataset || dataset.archivedAt || dataset.deletedAt) {
    return swapResult(await terminalizeVerification(ctx, row, { status: "CANCELED", resultCode: "UPLOAD_VERIFICATION_CANCELED", resultReason: "DATASET_INACTIVE" }));
  }
  if (dataset.modality !== row.boundDatasetModality || dataset.modality !== row.verifiedModality) return stale("DATASET_EVIDENCE_CHANGED");
  if (deps.now().getTime() >= row.verificationDeadlineAt.getTime()) {
    return swapResult(await terminalizeVerification(ctx, row, { status: "EXPIRED", resultCode: "UPLOAD_VERIFICATION_EXPIRED", resultReason: "ALLOWANCE_ELAPSED", jobErrorCode: "UPLOAD_VERIFICATION_EXPIRED", jobErrorKind: "ALLOWANCE_EXPIRED" }));
  }

  // Independent re-check of the sealed object's identity right before the write (R4: no whole-object re-hash; the persisted SHA-256 and decision are used).
  try {
    const sealedNow = identityFromStat(await deps.minio.statObject(row.stagedBucket, row.sealedKey!));
    if (!sealedNow || !identitiesEqual(sealedNow, { etag: row.sealedEtag!, size: row.sealedSizeBytes!, lastModified: row.sealedLastModified!, versionId: row.sealedVersionId })) return stale("SOURCE_SEALED_CHANGED");
  } catch (error) {
    if (isObjectNotFound(error)) return stale("SOURCE_SEALED_CHANGED");
    return { kind: "operational", reason: "UPLOAD_VERIFICATION_STORAGE_FAILED" };
  }

  const relativePath = normalizeAssetRelativePath(row.relativePathHint ?? row.filename);
  if (relativePath === null) {
    // Path-policy refusal of a POSITIVELY verified object: the media evidence is retained (contract section 4/5.1); only the path hint is refused.
    const won = await terminalizeVerification(ctx, row, {
      status: "REJECTED", resultCode: "INVALID_RELATIVE_PATH", resultReason: "RELATIVE_PATH_INVALID", jobErrorCode: "INVALID_RELATIVE_PATH", jobErrorKind: "PERMANENT_REJECTION_PATH",
      evidence: { probe: row.probe as Prisma.InputJsonValue, contentSha256: row.contentSha256!, verifiedModality: "VIDEO", policyVersion: row.policyVersion!, processorVersion: row.processorVersion! },
    });
    return swapResult(won);
  }

  const probe = row.probe as StoredProbe | null;
  const mimeType = containerMimeType(probe?.formatName);
  if (!probe || !mimeType || !row.contentSha256 || !row.sealedKey) throw new Error("VERIFIED_EVIDENCE_INCONSISTENT");
  const track = probe.streams.find((stream) => stream.type === "video" && !stream.picture);
  const sealedKey = row.sealedKey;
  const sourceFingerprint = createHash("sha256").update(a2SourceFingerprintInput(sealedKey, row.contentSha256)).digest("hex");

  let assetId: string;
  let disposition: "accepted" | "unchanged" = "accepted";
  try {
    assetId = await db.$transaction(async (tx) => {
      const current = await tx.mediaVerification.findUnique({ where: { id: row.id }, select: { status: true } });
      if (!current || current.status !== "VERIFIED") throw new PublishAborted("lost_cas");
      const live = await tx.job.findFirst({ where: { id: ctx.job.id, lockToken: ctx.lockToken, status: "RUNNING", lockedUntil: { gt: deps.now() }, cancelRequestedAt: null }, select: { id: true } });
      if (!live) throw new PublishAborted("lease_lost");
      const parent = await tx.dataset.findFirst({ where: { id: row.datasetId, deletedAt: null, archivedAt: null }, select: { modality: true } });
      if (!parent || parent.modality !== "VIDEO") throw new PublishAborted("lost_cas");

      const existing = await tx.asset.findFirst({ where: { storageProvider: "MINIO", storageBucket: row.stagedBucket, storageKey: sealedKey, deletedAt: null }, select: { id: true, datasetId: true, modality: true, videoAsset: { select: { id: true } } } });
      let id: string;
      if (existing) {
        // A replay (e.g. the commit succeeded but the verification flip was interrupted in an older run): reuse only an exactly matching Asset, never create a second one.
        if (existing.datasetId !== row.datasetId || existing.modality !== "VIDEO" || !existing.videoAsset) throw new Error("UPLOAD_CONFLICT");
        id = existing.id;
        disposition = "unchanged";
      } else {
        const created = await tx.asset.create({
          data: {
            datasetId: row.datasetId, uploadedById: row.requestedById, modality: "VIDEO",
            filename: row.filename, relativePath, originalFilename: row.filename, mimeType, sizeBytes: row.sealedSizeBytes,
            ...(track?.width ? { width: track.width } : {}), ...(track?.height ? { height: track.height } : {}), ...(probe.durationMs !== null ? { durationMs: probe.durationMs } : {}),
            sourceMode: "UPLOAD", storageProvider: "MINIO", storageBucket: row.stagedBucket, storageKey: sealedKey,
            checksum: `sha256:${row.contentSha256}`, sourceEtag: row.sealedEtag, sourceFingerprint, status: "READY",
            videoAsset: { create: { metadata: {} } },
          },
          select: { id: true },
        });
        id = created.id;
      }
      const flipped = await tx.mediaVerification.updateMany({ where: { id: row.id, status: "VERIFIED" }, data: { status: "PUBLISHED", assetId: id, publishedAt: deps.now(), finishedAt: deps.now() } });
      if (flipped.count !== 1) throw new PublishAborted("lost_cas");
      if (row.preparedImportItemId) {
        const item = await tx.preparedImportItem.findUnique({ where: { id: row.preparedImportItemId }, select: { id: true, preparedImportId: true, preparedImport: { select: { jobId: true } } } });
        if (item) {
          await tx.preparedImportItem.updateMany({ where: { id: item.id, assetId: null }, data: { assetId: id, completedAt: deps.now() } });
          await tx.jobEvent.createMany({ data: [{ id: itemEventId("success", item.id), jobId: item.preparedImport.jobId, level: "INFO", stage: "WRITING_ASSETS", message: "IMPORT_ITEM_SUCCEEDED", data: { itemId: item.id, disposition } }], skipDuplicates: true });
          await recomputeFolderAccounting(tx, item.preparedImportId);
        }
      }
      return id;
    });
  } catch (error) {
    if (error instanceof PublishAborted) return error.outcome === "lease_lost" ? { kind: "lease_lost" } : { kind: "advanced" };
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { kind: "operational", reason: "UPLOAD_VERIFICATION_STORAGE_FAILED" };
    throw error;
  }
  void assetId;
  await completeJobForPublished(ctx);
  return { kind: "terminal" };
}
