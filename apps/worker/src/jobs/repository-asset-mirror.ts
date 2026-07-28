import { Readable } from "node:stream";

import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { createWorkerMinio } from "../providers/minio.js";
import { getWorkerConfig } from "../config.js";

export async function mirrorRepositoryObject(input: { objectKey: string; body: ReadableStream<Uint8Array>; sizeBytes: number }) {
  const config = getWorkerConfig();
  const client = createWorkerMinio(config);
  await client.putObject(config.MINIO_BUCKET, input.objectKey, Readable.fromWeb(input.body as never), input.sizeBytes, { "Content-Type": "application/octet-stream" });
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
