import "server-only";

import { Modality } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { readSafeMediaReadiness, type SafeMediaReadiness } from "@/lib/media-processing/safe-media-readiness";
import { readVideoAnnotations } from "@/lib/annotations/video-read-service";
import { readImageWorkspaceAsset } from "@/lib/workspace/image-workspace";
import type { WorkspaceSelection } from "@/types/workspace";

export type { WorkspaceSelection } from "@/types/workspace";

/**
 * The one server-only selected-asset boundary for the shared workspace route.
 * It resolves the Dataset/Asset relationship and permission before dispatching
 * a modality-specific projection. No browser route or canvas may duplicate
 * those authorization or projection decisions.
 */
export async function readWorkspaceSelection(
  actor: RequestActor,
  datasetId: string,
  assetId: string,
): Promise<WorkspaceSelection | null> {
  const access = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!access || access.forbidden) return null;
  const asset = await db.asset.findFirst({
    where: { id: assetId, datasetId, deletedAt: null, archivedAt: null },
    select: { id: true, modality: true, filename: true, description: true, revision: true },
  });
  if (!asset) return null;
  if (asset.modality === Modality.IMAGE) {
    const image = await readImageWorkspaceAsset(actor, datasetId, assetId);
    return image ? { engine: "IMAGE", ...image } : null;
  }
  if (asset.modality === Modality.VIDEO || asset.modality === Modality.AUDIO) {
    const readiness = await readSafeMediaReadiness(actor, datasetId, assetId);
    if (!readiness) return null;
    if (asset.modality === Modality.VIDEO) {
      const annotations = await readVideoAnnotations(actor, assetId);
      if (!annotations) return null;
      return {
        engine: "VIDEO",
        asset: { id: asset.id, modality: "VIDEO", filename: asset.filename, description: asset.description, version: asset.revision },
        readiness,
        annotations,
      };
    }
    return {
      engine: "AUDIO",
      asset: { id: asset.id, modality: asset.modality, filename: asset.filename, description: asset.description },
      readiness,
    };
  }
  return { engine: "TEXT", asset: { id: asset.id, modality: "TEXT", filename: asset.filename, description: asset.description } };
}
