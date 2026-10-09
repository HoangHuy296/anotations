import "server-only";

import { Modality } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";

type MutationResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404 | 409 };

/**
 * AUDIO's asset-description autosave, mirroring `updateVideoDescription` in
 * `video-mutations.ts` but scoped to `Modality.AUDIO`. The AUDIO properties panel used to call the VIDEO-scoped
 * mutation, whose `modality: VIDEO` predicate matched no AUDIO row, so an AUDIO description could never be saved. Same
 * revision-guarded `updateMany` shape: a stale `version` cannot overwrite a
 * newer description.
 */
export async function updateAudioDescription(actor: RequestActor, input: { datasetId: string; assetId: string; version: number; description: string | null }): Promise<MutationResult<{ id: string; description: string | null; version: number }>> {
  const access = await requireDatasetPermission(actor, input.datasetId, "dataset.update");
  if (!access) return { ok: false, status: 404 };
  if (access.forbidden) return { ok: false, status: 403 };
  const result = await db.asset.updateMany({ where: { id: input.assetId, datasetId: input.datasetId, modality: Modality.AUDIO, revision: input.version, deletedAt: null, archivedAt: null }, data: { description: input.description, revision: { increment: 1 } } });
  if (result.count !== 1) {
    const exists = await db.asset.findFirst({ where: { id: input.assetId, datasetId: input.datasetId, modality: Modality.AUDIO, deletedAt: null, archivedAt: null }, select: { id: true } });
    return { ok: false, status: exists ? 409 : 404 };
  }
  const asset = await db.asset.findUnique({ where: { id: input.assetId }, select: { id: true, description: true, revision: true } });
  return asset ? { ok: true, value: { id: asset.id, description: asset.description, version: asset.revision } } : { ok: false, status: 404 };
}
