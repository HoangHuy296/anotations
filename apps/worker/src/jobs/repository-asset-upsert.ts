import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { assertAssetModality, DatasetModalityError } from "@annotationplatform/domain";

import { resolveHistoricalCandidateRelativePath } from "../../../../packages/domain/src/asset-relative-path-backfill.js";

import type { RepositoryCandidate } from "./repository-import-source.js";
import { assertAssetWritesNotQuiesced } from "../providers/asset-write-quiescence-guard.js";

export type RepositoryAssetReconciliation =
  | { kind: "absent" }
  | { kind: "reusable"; assetId: string; storageKey: string }
  | { kind: "conflict" };

/**
 * A source fingerprint names one logical repository path.  Reusing it is safe
 * only when the immutable revision/blob identity, byte size, object location,
 * modality, and required child row all agree.  A differing blob is never
 * silently overwritten by a retry.
 */
export async function reconcileMirroredRepositoryAsset(input: {
  db: PrismaClient;
  datasetId: string;
  sourceFingerprint: string;
  candidate: RepositoryCandidate;
  bucket: string;
  objectKey: string;
}): Promise<RepositoryAssetReconciliation> {
  const dataset = await input.db.dataset.findFirst({ where: { id: input.datasetId, deletedAt: null, archivedAt: null }, select: { modality: true } });
  if (!dataset) throw new Error("DATASET_UNAVAILABLE");
  if (dataset.modality === null) throw new Error("DATASET_MODALITY_UNRESOLVED");
  const asset = await input.db.asset.findUnique({
    where: { datasetId_sourceFingerprint: { datasetId: input.datasetId, sourceFingerprint: input.sourceFingerprint } },
    select: {
      id: true, modality: true, storageBucket: true, storageKey: true, sourceRevision: true, sourceFileSha: true, sizeBytes: true,
      imageAsset: { select: { id: true } }, videoAsset: { select: { id: true } }, audioAsset: { select: { id: true } }, textAsset: { select: { id: true } },
    },
  });
  if (!asset) return { kind: "absent" };
  try { assertAssetModality(dataset.modality, asset.modality); }
  catch (error) { if (error instanceof DatasetModalityError) throw new Error(error.code); throw error; }
  const correctChild = asset.modality === "IMAGE" ? Boolean(asset.imageAsset)
    : asset.modality === "VIDEO" ? Boolean(asset.videoAsset)
      : asset.modality === "AUDIO" ? Boolean(asset.audioAsset)
        : Boolean(asset.textAsset);
  const exact = asset.modality === dataset.modality
    && asset.storageBucket === input.bucket
    && asset.storageKey === input.objectKey
    && asset.sourceRevision === input.candidate.revision
    && asset.sourceFileSha === input.candidate.providerFileIdentity
    && asset.sizeBytes === BigInt(input.candidate.sizeBytes)
    && correctChild;
  return exact ? { kind: "reusable", assetId: asset.id, storageKey: asset.storageKey! } : { kind: "conflict" };
}

export async function upsertMirroredRepositoryAsset(input: {
  db: PrismaClient;
  datasetId: string;
  uploadedById: string;
  provider: "GITHUB" | "GITEA";
  candidate: RepositoryCandidate;
  verifiedModality: "IMAGE" | "VIDEO" | "AUDIO" | "TEXT";
  sourceFingerprint: string;
  bucket: string;
  objectKey: string;
  /** The owning Dataset's sourceRootPath (specs/027-coco-dataset-export §4). */
  sourceRootPath: string | null;
}) {
  await assertAssetWritesNotQuiesced();
  const outcome = resolveHistoricalCandidateRelativePath({
    preparedImportNormalizedPath: null, sourcePath: input.candidate.path,
    datasetSourceRootPath: input.sourceRootPath, filename: input.candidate.filename,
  });
  if (!outcome.ok) throw new Error("INVALID_RELATIVE_PATH");
  const relativePath = outcome.relativePath;

  const child = input.verifiedModality === "IMAGE" ? { imageAsset: { create: {} } }
    : input.verifiedModality === "VIDEO" ? { videoAsset: { create: { metadata: {} } } }
      : input.verifiedModality === "AUDIO" ? { audioAsset: { create: { metadata: {} } } }
        : { textAsset: { create: { tokenization: {}, metadata: {} } } };
  const create = async () => input.db.$transaction(async (tx) => {
    const dataset = await tx.dataset.findFirst({ where: { id: input.datasetId, deletedAt: null, archivedAt: null }, select: { modality: true } });
    if (!dataset) throw new Error("DATASET_UNAVAILABLE");
    try { assertAssetModality(dataset.modality, input.verifiedModality); }
    catch (error) { if (error instanceof DatasetModalityError) throw new Error(error.code); throw error; }
    const existing = await tx.asset.findUnique({
      where: { datasetId_sourceFingerprint: { datasetId: input.datasetId, sourceFingerprint: input.sourceFingerprint } },
      select: { id: true, modality: true, storageBucket: true, storageKey: true, sourceRevision: true, sourceFileSha: true, sizeBytes: true },
    });
    if (existing) {
      const exact = existing.modality === input.verifiedModality
        && existing.storageBucket === input.bucket && existing.storageKey === input.objectKey
        && existing.sourceRevision === input.candidate.revision
        && existing.sourceFileSha === input.candidate.providerFileIdentity
        && existing.sizeBytes === BigInt(input.candidate.sizeBytes);
      if (!exact) throw new Error("SOURCE_RECONCILIATION_CONFLICT");
      return { id: existing.id, modality: existing.modality, storageKey: existing.storageKey };
    }
    return tx.asset.create({
      data: {
        datasetId: input.datasetId, uploadedById: input.uploadedById, modality: input.verifiedModality,
        filename: input.candidate.filename, relativePath, originalFilename: input.candidate.filename, mimeType: input.candidate.mimeType,
        sizeBytes: BigInt(input.candidate.sizeBytes), sourceMode: "MIRROR_TO_MINIO",
        storageProvider: "MINIO", storageBucket: input.bucket, storageKey: input.objectKey,
        sourceProvider: input.provider, sourceRef: input.candidate.revision, sourceRevision: input.candidate.revision,
        sourcePath: input.candidate.path, sourceFileSha: input.candidate.providerFileIdentity,
        sourceFingerprint: input.sourceFingerprint, status: "READY", ...child,
      },
      select: { id: true, modality: true, storageKey: true },
    });
  });
  try { return await create(); }
  catch (error) {
    // A concurrent identical delivery may win the unique sourceFingerprint
    // race. Reuse only if the persisted row is the exact verified result.
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      const existing = await input.db.asset.findUnique({ where: { datasetId_sourceFingerprint: { datasetId: input.datasetId, sourceFingerprint: input.sourceFingerprint } }, select: { id: true, modality: true, storageBucket: true, storageKey: true, sourceRevision: true, sourceFileSha: true, sizeBytes: true } });
      if (existing && existing.modality === input.verifiedModality && existing.storageBucket === input.bucket && existing.storageKey === input.objectKey && existing.sourceRevision === input.candidate.revision && existing.sourceFileSha === input.candidate.providerFileIdentity && existing.sizeBytes === BigInt(input.candidate.sizeBytes)) return { id: existing.id, modality: existing.modality, storageKey: existing.storageKey };
      throw new Error("SOURCE_RECONCILIATION_CONFLICT");
    }
    throw error;
  }
}
