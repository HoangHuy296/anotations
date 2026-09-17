import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { createWorkerMinio } from "../providers/minio.js";
import { getWorkerConfig } from "../config.js";

/** Remove only an unreferenced boundary-artifact write attempt, never one the current TextAsset row still points at. */
export async function safeCleanupTextBoundaryArtifact(db: PrismaClient, input: { bucket: string; objectKey: string; assetId: string }) {
  if (!input.objectKey.startsWith("text-boundaries/")) return false;
  const current = await db.textAsset.findFirst({ where: { assetId: input.assetId, boundaryArtifactKey: input.objectKey }, select: { id: true } });
  if (current) return false;
  try {
    await createWorkerMinio(getWorkerConfig()).removeObject(input.bucket, input.objectKey);
    return true;
  } catch {
    return false;
  }
}
