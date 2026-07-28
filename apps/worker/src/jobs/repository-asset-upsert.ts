import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

import type { RepositoryCandidate } from "./repository-import-source.js";

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
  const asset = await input.db.asset.findUnique({
    where: { datasetId_sourceFingerprint: { datasetId: input.datasetId, sourceFingerprint: input.sourceFingerprint } },
    select: {
      id: true, modality: true, storageBucket: true, storageKey: true, sourceRevision: true, sourceFileSha: true, sizeBytes: true,
      imageAsset: { select: { id: true } }, videoAsset: { select: { id: true } }, audioAsset: { select: { id: true } }, textDocument: { select: { id: true } },
    },
  });
  if (!asset) return { kind: "absent" };
  const correctChild = input.candidate.modality === "IMAGE" ? Boolean(asset.imageAsset)
    : input.candidate.modality === "VIDEO" ? Boolean(asset.videoAsset)
      : input.candidate.modality === "AUDIO" ? Boolean(asset.audioAsset)
        : Boolean(asset.textDocument);
  const exact = asset.modality === input.candidate.modality
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
  sourceFingerprint: string;
  bucket: string;
  objectKey: string;
}) {
  const child = input.candidate.modality === "IMAGE" ? { imageAsset: { create: {} } }
    : input.candidate.modality === "VIDEO" ? { videoAsset: { create: { metadata: {} } } }
      : input.candidate.modality === "AUDIO" ? { audioAsset: { create: { metadata: {} } } }
        : { textDocument: { create: { tokenization: {}, metadata: {} } } };
  return input.db.asset.upsert({
    where: { datasetId_sourceFingerprint: { datasetId: input.datasetId, sourceFingerprint: input.sourceFingerprint } },
    create: {
      datasetId: input.datasetId, uploadedById: input.uploadedById, modality: input.candidate.modality,
      filename: input.candidate.filename, originalFilename: input.candidate.filename, mimeType: input.candidate.mimeType,
      sizeBytes: BigInt(input.candidate.sizeBytes), sourceMode: "MIRROR_TO_MINIO",
      storageProvider: "MINIO", storageBucket: input.bucket, storageKey: input.objectKey,
      sourceProvider: input.provider, sourceRef: input.candidate.revision, sourceRevision: input.candidate.revision,
      sourcePath: input.candidate.path, sourceFileSha: input.candidate.providerFileIdentity,
      sourceFingerprint: input.sourceFingerprint, status: "READY", ...child,
    },
    update: {
      mimeType: input.candidate.mimeType, sizeBytes: BigInt(input.candidate.sizeBytes), storageProvider: "MINIO",
      storageBucket: input.bucket, storageKey: input.objectKey, sourceRef: input.candidate.revision,
      sourceRevision: input.candidate.revision, sourceFileSha: input.candidate.providerFileIdentity, status: "READY",
    },
    select: { id: true, modality: true, storageKey: true },
  });
}
