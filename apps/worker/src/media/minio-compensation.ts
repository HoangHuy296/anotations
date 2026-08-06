import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

export type MediaCompensationResult = "deleted" | "referenced" | "outside_scope" | "not_found";

export type MediaObjectStore = { removeObject(bucket: string, objectKey: string): Promise<void> };

/**
 * A media worker may compensate only its exact private derivative namespace.
 * Canonical Asset, AssetVersion, and AudioAsset references always win over a
 * cleanup attempt, including a race after an upload but before a caller sees
 * the transaction result.
 */
export async function cleanupUnreferencedMediaDerivative(
  db: Pick<PrismaClient, "asset" | "assetVersion" | "audioAsset">,
  minio: MediaObjectStore,
  input: { bucket: string; objectKey: string; assetId: string },
): Promise<MediaCompensationResult> {
  if (!input.objectKey.startsWith(`media-derivatives/${input.assetId}/`)) return "outside_scope";
  const [asset, version, audio] = await Promise.all([
    db.asset.findFirst({ where: { storageBucket: input.bucket, storageKey: input.objectKey }, select: { id: true } }),
    db.assetVersion.findFirst({ where: { storageBucket: input.bucket, storageKey: input.objectKey }, select: { id: true } }),
    db.audioAsset.findFirst({ where: { assetId: input.assetId, waveformKey: input.objectKey }, select: { id: true } }),
  ]);
  if (asset || version || audio) return "referenced";
  try {
    await minio.removeObject(input.bucket, input.objectKey);
    return "deleted";
  } catch {
    return "not_found";
  }
}
