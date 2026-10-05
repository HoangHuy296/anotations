import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { AssetStatus, Modality, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { readWorkspacePage } from "@/lib/workspace/workspace-read";
import { cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser, workspaceUnique } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

/**
 * T012 (022) -- proves the Asset Browser's combined search/filter/sort/
 * pagination behavior at its real, database-backed source (`readWorkspacePage`,
 * extended in T014 to call the shared `buildAssetListWhere`/
 * `buildAssetListOrderBy` from `workspace-assets.ts`), the same pattern
 * `asset-navigator-pagination.test.ts` already established for pagination
 * alone.
 */
test("modality, status, and label filters intersect rather than union", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const videoDataset = await createWorkspaceDataset(owner.id, Modality.VIDEO);
  try {
    const label = await db.label.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, name: "cat", normalizedName: workspaceUnique("cat"), color: "#0EA5E9" }, select: { id: true } });
    const marker = workspaceUnique("browser-query");
    const matching = await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: `${marker}-match.png`, mimeType: "image/png", sourceFingerprint: `${marker}-match`, status: AssetStatus.NEEDS_REVIEW } });
    await db.assetLabel.create({ data: { assetId: matching.id, labelId: label.id } });
    // The other modality lives in a separate Dataset; equal category/status
    // never allows its content to leak into this Dataset's filtered page.
    const videoLabel = await db.label.create({ data: { datasetId: videoDataset.id, modality: Modality.VIDEO, name: "cat", normalizedName: workspaceUnique("cat"), color: "#0EA5E9" }, select: { id: true } });
    const wrongModality = await db.asset.create({ data: { datasetId: videoDataset.id, modality: Modality.VIDEO, filename: `${marker}-wrong-modality.mp4`, mimeType: "video/mp4", sourceFingerprint: `${marker}-wrong-modality`, status: AssetStatus.NEEDS_REVIEW } });
    await db.assetLabel.create({ data: { assetId: wrongModality.id, labelId: videoLabel.id } });
    // Wrong status, same modality+label: must be excluded by the status filter.
    const wrongStatus = await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: `${marker}-wrong-status.png`, mimeType: "image/png", sourceFingerprint: `${marker}-wrong-status`, status: AssetStatus.COMPLETED } });
    await db.assetLabel.create({ data: { assetId: wrongStatus.id, labelId: label.id } });
    // Right modality+status, no label: must be excluded by the label filter.
    await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: `${marker}-no-label.png`, mimeType: "image/png", sourceFingerprint: `${marker}-no-label`, status: AssetStatus.NEEDS_REVIEW } });

    const page = await readWorkspacePage(owner, dataset.id, {
      modality: Modality.IMAGE, statuses: [AssetStatus.NEEDS_REVIEW], labelId: [label.id],
    });
    assert.deepEqual(page?.page.items.map((item) => item.id), [matching.id], "only the asset matching modality AND status AND label is returned");
    const incompatibleFilter = await readWorkspacePage(owner, dataset.id, {
      modality: Modality.VIDEO, statuses: [AssetStatus.NEEDS_REVIEW], labelId: [label.id],
    });
    assert.deepEqual(incompatibleFilter?.page.items, [], "an incompatible modality filter cannot cross Dataset scope");
    assert.equal(incompatibleFilter?.dataset.modality, Modality.IMAGE, "filters do not override the Dataset engine");
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id, videoDataset.id]); }
});

test("changing sort order alone never changes which assets match, only their order", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const marker = workspaceUnique("browser-sort");
    const first = await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: `${marker}-a-first.png`, mimeType: "image/png", sourceFingerprint: `${marker}-a` } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: `${marker}-b-second.png`, mimeType: "image/png", sourceFingerprint: `${marker}-b` } });

    const defaultOrder = await readWorkspacePage(owner, dataset.id, { search: marker });
    const byCreatedAsc = await readWorkspacePage(owner, dataset.id, { search: marker, sort: "createdAt", order: "asc" });
    const byCreatedDesc = await readWorkspacePage(owner, dataset.id, { search: marker, sort: "createdAt", order: "desc" });

    const matchedSet = (result: typeof defaultOrder) => new Set(result?.page.items.map((item) => item.id));
    assert.deepEqual(matchedSet(defaultOrder), new Set([first.id, second.id]));
    assert.deepEqual(matchedSet(byCreatedAsc), matchedSet(defaultOrder), "sort must not change which assets match");
    assert.deepEqual(matchedSet(byCreatedDesc), matchedSet(defaultOrder), "sort must not change which assets match");
    assert.deepEqual(byCreatedAsc?.page.items.map((item) => item.id), [first.id, second.id], "ascending created order: oldest first");
    assert.deepEqual(byCreatedDesc?.page.items.map((item) => item.id), [second.id, first.id], "descending created order: newest first");
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("a custom sort keeps producing consistent, non-overlapping results across pages", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const marker = workspaceUnique("browser-sort-paging");
    const created = await Promise.all(Array.from({ length: 15 }, (_, index) =>
      db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: `${marker}-${String(index).padStart(2, "0")}.png`, mimeType: "image/png", sourceFingerprint: `${marker}-${index}` } })));
    const expectedOrder = [...created].sort((left, right) => left.filename.localeCompare(right.filename)).map((asset) => asset.id);

    const firstPage = await readWorkspacePage(owner, dataset.id, { search: marker, sort: "filename", order: "asc", page: 1 });
    const secondPage = await readWorkspacePage(owner, dataset.id, { search: marker, sort: "filename", order: "asc", page: 2 });
    assert.deepEqual(firstPage?.page.items.map((item) => item.id), expectedOrder.slice(0, 10));
    assert.deepEqual(secondPage?.page.items.map((item) => item.id), expectedOrder.slice(10, 15));
    const overlap = firstPage!.page.items.filter((item) => secondPage!.page.items.some((other) => other.id === item.id));
    assert.deepEqual(overlap, [], "no asset appears on both pages under a custom sort");
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("date range filters bound results to the requested created/updated window", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const marker = workspaceUnique("browser-date-range");
    const inRange = await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: `${marker}-in.png`, mimeType: "image/png", sourceFingerprint: `${marker}-in` } });
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const page = await readWorkspacePage(owner, dataset.id, { search: marker, createdFrom: past, createdTo: future });
    assert.deepEqual(page?.page.items.map((item) => item.id), [inRange.id]);
    const emptyPage = await readWorkspacePage(owner, dataset.id, { search: marker, createdFrom: future });
    assert.deepEqual(emptyPage?.page.items, [], "a from-date in the future excludes every asset created before it");
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});
