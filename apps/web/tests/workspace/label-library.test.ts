import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DatasetMemberRole, Modality } from "@internal/db";

import { db } from "@/lib/db";
import { listLabelLibraryDatasets, orderLabelLibraryDatasets, pickLabelLibraryDataset, shouldBackfillDefaultImageLabels } from "@/lib/labels/label-library";
import { addWorkspaceMember, cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser, workspaceUnique } from "./helpers";

const page = readFileSync(new URL("../../src/app/(app)/labels/page.tsx", import.meta.url), "utf8");

test("the library lists only the datasets the user owns or belongs to, owned first, with their own label counts", async () => {
  const me = await createWorkspaceUser();
  const other = await createWorkspaceUser();
  const mineText = await createWorkspaceDataset(me.id, Modality.TEXT);
  const mineImage = await createWorkspaceDataset(me.id, Modality.IMAGE);
  const shared = await createWorkspaceDataset(other.id, Modality.VIDEO);
  const foreign = await createWorkspaceDataset(other.id, Modality.AUDIO);
  const datasetIds = [mineText.id, mineImage.id, shared.id, foreign.id];
  try {
    await addWorkspaceMember(shared.id, me.id, DatasetMemberRole.REVIEWER);
    for (const name of ["a", "b"]) await db.label.create({ data: { datasetId: mineText.id, name: workspaceUnique(name), normalizedName: workspaceUnique(name), color: "#0EA5E9" } });
    await db.label.create({ data: { datasetId: foreign.id, name: workspaceUnique("x"), normalizedName: workspaceUnique("x"), color: "#0EA5E9" } });

    const library = await listLabelLibraryDatasets(me.id);
    const ids = library.map((dataset) => dataset.id);
    assert.deepEqual([...ids].sort(), [mineImage.id, mineText.id, shared.id].sort(), "another user's dataset never appears");
    assert.ok(!ids.includes(foreign.id));
    assert.equal(ids.indexOf(shared.id), 2, "shared datasets come after every owned one");
    assert.deepEqual(library.map((dataset) => dataset.owned), [true, true, false]);
    assert.equal(library.find((dataset) => dataset.id === mineText.id)?.labelCount, 2);
    assert.equal(library.find((dataset) => dataset.id === mineText.id)?.modality, Modality.TEXT);
    assert.equal(library.find((dataset) => dataset.id === shared.id)?.labelCount, 0, "a taxonomy is counted per dataset; another dataset's labels are never mixed in");
  } finally {
    await cleanupWorkspaceFixture([me.id, other.id], datasetIds);
  }
});

test("an archived or deleted dataset is not offered", async () => {
  const me = await createWorkspaceUser();
  const live = await createWorkspaceDataset(me.id, Modality.IMAGE);
  const archived = await createWorkspaceDataset(me.id, Modality.IMAGE);
  const deleted = await createWorkspaceDataset(me.id, Modality.IMAGE);
  try {
    await db.dataset.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    await db.dataset.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    assert.deepEqual((await listLabelLibraryDatasets(me.id)).map((dataset) => dataset.id), [live.id]);
  } finally {
    await cleanupWorkspaceFixture([me.id], [live.id, archived.id, deleted.id]);
  }
});

test("the shown dataset is chosen from the user's own list: a foreign or unknown id falls back to the first, an empty list shows nothing", () => {
  const list = orderLabelLibraryDatasets([
    { id: "s1", name: "Shared", modality: Modality.VIDEO, owned: false, labelCount: 1 },
    { id: "o1", name: "Mine", modality: Modality.TEXT, owned: true, labelCount: 2 },
  ]);
  assert.deepEqual(list.map((dataset) => dataset.id), ["o1", "s1"]);
  assert.equal(pickLabelLibraryDataset(list, "s1")?.id, "s1");
  assert.equal(pickLabelLibraryDataset(list, "someone-elses-dataset")?.id, "o1");
  assert.equal(pickLabelLibraryDataset(list, undefined)?.id, "o1");
  assert.equal(pickLabelLibraryDataset([], "o1"), null);
});

test("default IMAGE categories are written only into IMAGE datasets, never into TEXT, VIDEO, AUDIO or unresolved ones", () => {
  assert.deepEqual([Modality.IMAGE, Modality.TEXT, Modality.VIDEO, Modality.AUDIO, null].map(shouldBackfillDefaultImageLabels), [true, false, false, false, false]);
  assert.match(page, /dataset && shouldBackfillDefaultImageLabels\(dataset\.modality\)/, "the page applies the rule before backfilling");
});

test("page contract: the selector links are scoped to the user's own list and carry the dataset id only; permission is still checked on the selected dataset", () => {
  assert.match(page, /listLabelLibraryDatasets\(actor\.id\)/);
  assert.match(page, /pickLabelLibraryDataset\(datasets, requestedDatasetId\)/);
  assert.match(page, /requireDatasetPermission\(actor, dataset\.id, "label\.manage"\)/);
  assert.match(page, /aria-label="Your datasets"/);
});
