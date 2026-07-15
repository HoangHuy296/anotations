import "server-only";

import { AssetStatus, DatasetSourceMode, Modality, Prisma, StorageProvider } from "@internal/db";
import type { Client as MinioClient } from "minio";

import { assetMetadataSelect } from "@/lib/dataset-metadata";
import { db } from "@/lib/db";
import type { UploadCapability } from "@/lib/upload-capability";
import type { VerifiedUpload } from "@/lib/upload-verification";

const assetWithChildren = {
  ...assetMetadataSelect,
  imageAsset: { select: { id: true } },
  videoAsset: { select: { id: true } },
  textDocument: { select: { id: true } },
  audioAsset: { select: { id: true } },
} as const;

type PublishedAsset = {
  id: string;
  datasetId: string;
  modality: Modality;
  filename: string;
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
  textDocument: { id: string } | null;
  audioAsset: { id: string } | null;
};

export type SafeUploadedAsset = Omit<PublishedAsset, "imageAsset" | "videoAsset" | "textDocument" | "audioAsset" | "sizeBytes"> & {
  sizeBytes: string | null;
};

export class UploadPublicationFailure extends Error {
  constructor(readonly code: "UPLOAD_CONFLICT") {
    super(code);
    this.name = "UploadPublicationFailure";
  }
}

function hasMatchingChild(asset: PublishedAsset) {
  return (asset.modality === Modality.IMAGE && Boolean(asset.imageAsset))
    || (asset.modality === Modality.VIDEO && Boolean(asset.videoAsset))
    || (asset.modality === Modality.TEXT && Boolean(asset.textDocument))
    || (asset.modality === Modality.AUDIO && Boolean(asset.audioAsset));
}

function safeAsset(asset: PublishedAsset): SafeUploadedAsset {
  const { imageAsset, videoAsset, textDocument, audioAsset, ...safe } = asset;
  void imageAsset;
  void videoAsset;
  void textDocument;
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
}) {
  const existing = await findPublishedObject(input.bucket, input.capability.objectKey);
  if (existing) {
    if (!hasMatchingChild(existing)) throw new UploadPublicationFailure("UPLOAD_CONFLICT");
    return { asset: safeAsset(existing), replayed: true };
  }

  let created: { asset: PublishedAsset; replayed: boolean };
  try {
    created = await db.$transaction(async (tx) => {
      const duplicate = await tx.asset.findFirst({
        where: { storageProvider: StorageProvider.MINIO, storageBucket: input.bucket, storageKey: input.capability.objectKey, deletedAt: null },
        select: assetWithChildren,
      });
      if (duplicate) return { asset: duplicate, replayed: true };

      const common = {
        datasetId: input.capability.datasetId,
        uploadedById: input.capability.actorId,
        modality: input.verified.modality,
        filename: input.capability.filename,
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
          return { asset: await tx.asset.create({ data: { ...common, textDocument: { create: { tokenization: {}, metadata: {} } } }, select: assetWithChildren }), replayed: false };
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
