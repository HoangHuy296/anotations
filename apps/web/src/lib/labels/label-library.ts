import type { Modality, Prisma } from "@internal/db";

import { db } from "@/lib/db";

/** One dataset in the signed-in user's label library: a dataset they own or were added to, with the size of its taxonomy. */
export type LabelLibraryDataset = {
  id: string;
  name: string;
  modality: Modality | null;
  owned: boolean;
  labelCount: number;
};

/** Upper bound on the datasets shown in the library switcher; the list is a navigation aid, not a report. */
export const LABEL_LIBRARY_DATASET_LIMIT = 100;

/** The taxonomies the user may open: only datasets they own or are a member of, never another user's. Owned datasets come first, then most recently updated. */
export async function listLabelLibraryDatasets(actorId: string, client: Pick<Prisma.TransactionClient, "dataset"> = db): Promise<LabelLibraryDataset[]> {
  const rows = await client.dataset.findMany({
    where: { deletedAt: null, archivedAt: null, OR: [{ ownerId: actorId }, { members: { some: { userId: actorId } } }] },
    orderBy: { updatedAt: "desc" },
    take: LABEL_LIBRARY_DATASET_LIMIT,
    select: { id: true, name: true, modality: true, ownerId: true, _count: { select: { labels: true } } },
  });
  return orderLabelLibraryDatasets(rows.map((row) => ({ id: row.id, name: row.name, modality: row.modality, owned: row.ownerId === actorId, labelCount: row._count.labels })));
}

/** Owned datasets before shared ones; within each group the incoming (most recently updated first) order is kept. */
export function orderLabelLibraryDatasets(datasets: LabelLibraryDataset[]): LabelLibraryDataset[] {
  return [...datasets.filter((dataset) => dataset.owned), ...datasets.filter((dataset) => !dataset.owned)];
}

/** The dataset whose taxonomy is shown. A requested id that is not in the user's own list is ignored (never trusted), falling back to the first dataset. */
export function pickLabelLibraryDataset(datasets: LabelLibraryDataset[], requestedId: string | undefined): LabelLibraryDataset | null {
  return datasets.find((dataset) => dataset.id === requestedId) ?? datasets[0] ?? null;
}

/** The default IMAGE categories are reference data for IMAGE datasets only; opening a TEXT, VIDEO or AUDIO taxonomy must never write them. */
export function shouldBackfillDefaultImageLabels(modality: Modality | null): boolean {
  return modality === "IMAGE";
}
