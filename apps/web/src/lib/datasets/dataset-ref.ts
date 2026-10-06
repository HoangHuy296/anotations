import "server-only";

import type { Modality } from "@internal/db";
import { db } from "@/lib/db";

export type PersistedDatasetRef = { id: string; modality: Modality };

/**
 * The authoritative `{ id, modality }` of a Dataset, read from its persisted row. Creation responses expose this and never an echo of
 * request input. Returns null when the row is missing or its modality is not yet resolved (callers fail closed).
 */
export async function readPersistedDatasetRef(datasetId: string): Promise<PersistedDatasetRef | null> {
  const dataset = await db.dataset.findUnique({ where: { id: datasetId }, select: { id: true, modality: true } });
  return dataset && dataset.modality !== null ? { id: dataset.id, modality: dataset.modality } : null;
}
