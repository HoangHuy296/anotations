import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { createWorkerMinio } from "../providers/minio.js";
import { getWorkerConfig } from "../config.js";

/** Remove only an unreferenced waveform attempt under the media namespace. */
export async function safeCleanupAudioDerivative(db: PrismaClient, input: { bucket: string; objectKey: string; assetId: string }) {
  const prefix = `audio-waveforms/`;
  if (!input.objectKey.startsWith(prefix)) return false;
  const [audio, version] = await Promise.all([
    db.audioAsset.findFirst({ where: { assetId: input.assetId, waveformKey: input.objectKey }, select: { id: true } }),
    db.assetVersion.findFirst({ where: { assetId: input.assetId, storageBucket: input.bucket, storageKey: input.objectKey }, select: { id: true } }),
  ]);
  if (audio || version) return false;
  try {
    await createWorkerMinio(getWorkerConfig()).removeObject(input.bucket, input.objectKey);
    return true;
  } catch { return false; }
}
