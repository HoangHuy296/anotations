import { Readable } from "node:stream";
import { CopyDestinationOptions, CopySourceOptions } from "minio";

import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { createWorkerMinio } from "../providers/minio.js";
import { getWorkerConfig } from "../config.js";
import type { RepositoryCandidate } from "./repository-import-source.js";

/** The only Content-Types the extension mapping in repository-import-source.ts can produce; anything else is stored as an opaque download, never as a browser-interpreted type. */
export const REPOSITORY_OBJECT_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm", "text/plain", "application/json", "text/csv", "audio/mpeg", "audio/ogg", "audio/wav",
]);

export function repositoryObjectMetadata(candidate: Pick<RepositoryCandidate, "mimeType">) {
  return { "Content-Type": REPOSITORY_OBJECT_CONTENT_TYPES.has(candidate.mimeType) ? candidate.mimeType : "application/octet-stream" };
}

export async function mirrorRepositoryObject(input: { objectKey: string; body: ReadableStream<Uint8Array>; sizeBytes: number; mimeType: RepositoryCandidate["mimeType"] }) {
  const config = getWorkerConfig();
  const client = createWorkerMinio(config);
  await client.putObject(config.MINIO_BUCKET, input.objectKey, Readable.fromWeb(input.body as never), input.sizeBytes, repositoryObjectMetadata({ mimeType: input.mimeType }));
  const stat = await client.statObject(config.MINIO_BUCKET, input.objectKey);
  if (stat.size !== input.sizeBytes) throw new Error("MINIO_OBJECT_VERIFICATION_FAILED");
  return { bucket: config.MINIO_BUCKET, objectKey: input.objectKey };
}

/** Deletes only an unreferenced key in the current repository-import scope. */
export async function safeCleanupUnpublishedObject(db: PrismaClient, input: { bucket: string; objectKey: string; datasetId: string }) {
  if (!input.objectKey.startsWith(`repository-imports/${input.datasetId}/`)) return false;
  const [assetReference, versionReference] = await Promise.all([
    db.asset.findFirst({ where: { storageBucket: input.bucket, storageKey: input.objectKey }, select: { id: true } }),
    db.assetVersion.findFirst({ where: { storageBucket: input.bucket, storageKey: input.objectKey }, select: { id: true } }),
  ]);
  if (assetReference || versionReference) return false;
  const client = createWorkerMinio(getWorkerConfig());
  try { await client.removeObject(input.bucket, input.objectKey); return true; } catch { return false; }
}

/**
 * Replaces the Content-Type of an already mirrored object with the content-verified one (server-side self-copy, metadata REPLACE; the bytes are not re-sent). Only the
 * allowlisted types or the opaque fallback are accepted, and the sealed namespace is refused: this is for repository mirror keys only.
 */
export async function correctRepositoryObjectContentType(input: { objectKey: string; contentType: string }) {
  if (!REPOSITORY_OBJECT_CONTENT_TYPES.has(input.contentType) && input.contentType !== "application/octet-stream") throw new Error("MINIO_CONTENT_TYPE_REFUSED");
  if (input.objectKey.startsWith("verified-uploads/")) throw new Error("MINIO_CONTENT_TYPE_REFUSED");
  const config = getWorkerConfig();
  const client = createWorkerMinio(config);
  await client.copyObject(
    new CopySourceOptions({ Bucket: config.MINIO_BUCKET, Object: input.objectKey }),
    new CopyDestinationOptions({ Bucket: config.MINIO_BUCKET, Object: input.objectKey, MetadataDirective: "REPLACE", Headers: { "Content-Type": input.contentType } }),
  );
  const stat = await client.statObject(config.MINIO_BUCKET, input.objectKey);
  if (stat.metaData?.["content-type"] !== input.contentType) throw new Error("MINIO_OBJECT_VERIFICATION_FAILED");
}
