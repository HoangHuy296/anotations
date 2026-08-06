import "server-only";

import { Modality } from "@internal/db";
import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission, type DatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";

export async function resolveVideoAssetAccess(actor: RequestActor, assetId: string, permission: DatasetPermission = "dataset.read") {
  const asset = await db.asset.findFirst({
    where: { id: assetId, deletedAt: null, archivedAt: null, modality: Modality.VIDEO },
    select: { id: true, datasetId: true, modality: true, durationMs: true, videoAsset: { select: { id: true, fps: true, totalFrames: true, codec: true } } },
  });
  if (!asset) return null;
  const access = await requireDatasetPermission(actor, asset.datasetId, permission);
  if (!access || access.forbidden) return null;
  return { asset, access };
}

export async function resolveVideoTrackAccess(actor: RequestActor, trackId: string, permission: DatasetPermission = "dataset.read") {
  const track = await db.videoObjectTrack.findFirst({
    where: { id: trackId },
    select: { id: true, videoAssetId: true, labelId: true, videoAsset: { select: { assetId: true, asset: { select: { id: true, datasetId: true, modality: true, deletedAt: true, archivedAt: true } } } } },
  });
  if (!track || track.videoAsset.asset.modality !== Modality.VIDEO || track.videoAsset.asset.deletedAt || track.videoAsset.asset.archivedAt) return null;
  const access = await requireDatasetPermission(actor, track.videoAsset.asset.datasetId, permission);
  if (!access || access.forbidden) return null;
  return { track, datasetId: track.videoAsset.asset.datasetId, assetId: track.videoAsset.asset.id, access };
}

export async function requireSameDatasetLabel(labelId: string | null | undefined, datasetId: string) {
  if (!labelId) return true;
  const label = await db.label.findFirst({ where: { id: labelId, datasetId }, select: { id: true } });
  return Boolean(label);
}
