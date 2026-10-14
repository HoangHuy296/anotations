import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { UserRole } from "@internal/db";

import { datasetLibraryQuerySchema } from "@/lib/datasets/dataset-library-query";
import { getDatasetLibrary } from "@/lib/datasets/dataset-library-service";
import { db } from "@/lib/db";
import { cleanupWorkspaceFixture, createImageAsset, createWorkspaceDataset, createWorkspaceUser } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("the dataset library counts only active assets: a soft-deleted or archived asset no longer inflates the card, the status or the modality counts", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id, "IMAGE");
  const actor = { id: owner.id, email: owner.email, name: owner.name, role: UserRole.MANAGER };
  try {
    const keep = await createImageAsset(dataset.id, { filename: "keep.png" });
    const deleted = await createImageAsset(dataset.id, { filename: "deleted.png" });
    const archived = await createImageAsset(dataset.id, { filename: "archived.png" });
    const query = datasetLibraryQuerySchema.parse({});
    const read = async () => {
      const library = await getDatasetLibrary(actor, query);
      const row = library.datasets.find((item) => item.id === dataset.id)!;
      const sum = (rows: Array<{ datasetId: string; _count: { _all: number } }>) => rows.filter((item) => item.datasetId === dataset.id).reduce((total, item) => total + item._count._all, 0);
      return { cardCount: row._count.assets, byStatus: sum(library.statusCounts), byModality: sum(library.modalityCounts) };
    };
    assert.deepEqual(await read(), { cardCount: 3, byStatus: 3, byModality: 3 });
    await db.asset.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    assert.deepEqual(await read(), { cardCount: 2, byStatus: 2, byModality: 2 }, "after deleting one asset");
    await db.asset.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    assert.deepEqual(await read(), { cardCount: 1, byStatus: 1, byModality: 1 }, "after archiving another");
    assert.equal((await db.asset.count({ where: { datasetId: dataset.id } })), 3, "the rows themselves are kept (soft delete)");
    void keep;
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});
