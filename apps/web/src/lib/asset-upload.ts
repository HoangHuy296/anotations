import "server-only";

import { AssetStatus, DatasetSourceMode, Modality, Prisma, StorageProvider } from "@internal/db";
import type { Client as MinioClient } from "minio";

import { assertAssetModality, DatasetModalityError } from "@annotationplatform/domain";
import { normalizeAssetRelativePath } from "@annotationplatform/domain/asset-relative-path";

import { assetMetadataSelect } from "@/lib/dataset-metadata";
import { assertAssetWritesNotQuiesced } from "@/lib/asset-write-quiescence-guard";
import { db } from "@/lib/db";
import type { UploadCapability } from "@/lib/upload-capability";
import type { VerifiedUpload } from "@/lib/upload-verification";

const assetWithChildren = {
  ...assetMetadataSelect,
  // specs/027-coco-dataset-export §10 (EXPAND-2). Selected here only, not
  // added to the shared assetMetadataSelect -- this stays out of every
  // other endpoint's response shape until a phase explicitly asks for it.
  relativePath: true,
  imageAsset: { select: { id: true } },
  videoAsset: { select: { id: true } },
  textAsset: { select: { id: true } },
  audioAsset: { select: { id: true } },
} as const;

type PublishedAsset = {
  id: string;
  datasetId: string;
  modality: Modality;
  filename: string;
  relativePath: string | null;
  originalFilename: string | null;
  mimeType: string;
  sizeBytes: bigint | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  textLength: number | null;
  status: AssetStatus;
  batchIndex: number;
  orderIndex: number;
  description: string | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  imageAsset: { id: string } | null;
  videoAsset: { id: string } | null;
  textAsset: { id: string } | null;
  audioAsset: { id: string } | null;
};

export type SafeUploadedAsset = Omit<PublishedAsset, "imageAsset" | "videoAsset" | "textAsset" | "audioAsset" | "sizeBytes"> & {
  sizeBytes: string | null;
};

export class UploadPublicationFailure extends Error {
  constructor(readonly code: "UPLOAD_CONFLICT" | "INVALID_RELATIVE_PATH" | "DATASET_MODALITY_UNRESOLVED" | "ASSET_MODALITY_MISMATCH" | "DATASET_MODALITY_IMMUTABLE") {
    super(code);
    this.name = "UploadPublicationFailure";
  }
}

function hasMatchingChild(asset: PublishedAsset) {
  return (asset.modality === Modality.IMAGE && Boolean(asset.imageAsset))
    || (asset.modality === Modality.VIDEO && Boolean(asset.videoAsset))
    || (asset.modality === Modality.TEXT && Boolean(asset.textAsset))
    || (asset.modality === Modality.AUDIO && Boolean(asset.audioAsset));
}

function safeAsset(asset: PublishedAsset): SafeUploadedAsset {
  const { imageAsset, videoAsset, textAsset, audioAsset, ...safe } = asset;
  void imageAsset;
  void videoAsset;
  void textAsset;
  void audioAsset;
  return { ...safe, sizeBytes: safe.sizeBytes?.toString() ?? null };
}

async function findPublishedObject(bucket: string, objectKey: string) {
  return db.asset.findFirst({
    where: { storageProvider: StorageProvider.MINIO, storageBucket: bucket, storageKey: objectKey, deletedAt: null },
    select: assetWithChildren,
  });
}

export async function publishUploadedAsset(input: {
  capability: UploadCapability;
  verified: VerifiedUpload;
  bucket: string;
  /**
   * specs/027-coco-dataset-export §4/§10. When the caller already knows the
   * canonical dataset-relative identity (a local-folder-import completion
   * knows its PreparedImportItem.normalizedPath), it passes it here. A
   * plain single-file upload has no folder structure, so it omits this and
   * falls back to the (already-sanitized) filename.
   */
  relativePathHint?: string;
}) {
  const existing = await findPublishedObject(input.bucket, input.capability.objectKey);
  if (existing) {
    if (existing.datasetId !== input.capability.datasetId || !hasMatchingChild(existing)) throw new UploadPublicationFailure("UPLOAD_CONFLICT");
    const parent = await db.dataset.findFirst({ where: { id: input.capability.datasetId, deletedAt: null, archivedAt: null }, select: { modality: true } });
    if (!parent) throw new UploadPublicationFailure("UPLOAD_CONFLICT");
    try { assertAssetModality(parent.modality, existing.modality); }
    catch (error) { if (error instanceof DatasetModalityError) throw new UploadPublicationFailure(error.code); throw error; }
    return { asset: safeAsset(existing), replayed: true };
  }

  // specs/027-coco-dataset-export §10: checked only on the path that would
  // create a genuinely new Asset row, never on the replay path above (a
  // replay is a read of already-published state, not a write, and must
  // keep succeeding during a quiescence window).
  await assertAssetWritesNotQuiesced();

  // §4/§10 EXPAND-2: every new Asset gets a canonical, already-normalized
  // relativePath, or the write is rejected outright -- never a NULL row,
  // never an invented path.
  const relativePath = normalizeAssetRelativePath(input.relativePathHint ?? input.capability.filename);
  if (relativePath === null) throw new UploadPublicationFailure("INVALID_RELATIVE_PATH");

  let created: { asset: PublishedAsset; replayed: boolean };
  try {
    created = await db.$transaction(async (tx) => {
      const parent = await tx.dataset.findFirst({ where: { id: input.capability.datasetId, deletedAt: null, archivedAt: null }, select: { modality: true } });
      if (!parent) throw new UploadPublicationFailure("UPLOAD_CONFLICT");
      try { assertAssetModality(parent.modality, input.verified.modality); }
      catch (error) { if (error instanceof DatasetModalityError) throw new UploadPublicationFailure(error.code); throw error; }

      const duplicate = await tx.asset.findFirst({
        where: { storageProvider: StorageProvider.MINIO, storageBucket: input.bucket, storageKey: input.capability.objectKey, deletedAt: null },
        select: assetWithChildren,
      });
      if (duplicate) {
        if (duplicate.datasetId !== input.capability.datasetId || !hasMatchingChild(duplicate)) throw new UploadPublicationFailure("UPLOAD_CONFLICT");
        try { assertAssetModality(parent.modality, duplicate.modality); }
        catch (error) { if (error instanceof DatasetModalityError) throw new UploadPublicationFailure(error.code); throw error; }
        return { asset: duplicate, replayed: true };
      }

      const common = {
        datasetId: input.capability.datasetId,
        uploadedById: input.capability.actorId,
        modality: input.verified.modality,
        filename: input.capability.filename,
        relativePath,
        originalFilename: input.capability.filename,
        mimeType: input.verified.mimeType,
        sizeBytes: input.verified.sizeBytes,
        ...(input.verified.width ? { width: input.verified.width } : {}),
        ...(input.verified.height ? { height: input.verified.height } : {}),
        ...(input.verified.textLength ? { textLength: input.verified.textLength } : {}),
        sourceMode: DatasetSourceMode.UPLOAD,
        storageProvider: StorageProvider.MINIO,
        storageBucket: input.bucket,
        storageKey: input.capability.objectKey,
        sourceFingerprint: input.verified.sourceFingerprint,
        status: AssetStatus.READY,
      };

      switch (input.verified.modality) {
        case Modality.IMAGE:
          return { asset: await tx.asset.create({ data: { ...common, imageAsset: { create: { exif: {} } } }, select: assetWithChildren }), replayed: false };
        case Modality.VIDEO:
          return { asset: await tx.asset.create({ data: { ...common, videoAsset: { create: { metadata: {} } } }, select: assetWithChildren }), replayed: false };
        case Modality.TEXT:
          return { asset: await tx.asset.create({ data: { ...common, textAsset: { create: { tokenization: {}, metadata: {} } } }, select: assetWithChildren }), replayed: false };
        case Modality.AUDIO:
          return { asset: await tx.asset.create({ data: { ...common, audioAsset: { create: { metadata: {} } } }, select: assetWithChildren }), replayed: false };
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new UploadPublicationFailure("UPLOAD_CONFLICT");
    }
    throw error;
  }

  if (!hasMatchingChild(created.asset)) throw new UploadPublicationFailure("UPLOAD_CONFLICT");
  return { asset: safeAsset(created.asset), replayed: created.replayed };
}

/** Best-effort cleanup only; no object identifier is returned to a browser. */
export async function cleanupUnpublishedObject(minio: MinioClient, bucket: string, objectKey: string) {
  try {
    const published = await findPublishedObject(bucket, objectKey);
    if (!published) await minio.removeObject(bucket, objectKey);
  } catch {
    // Cleanup failure is intentionally not surfaced to the browser.
  }
}
