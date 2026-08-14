import assert from "node:assert/strict";
import test from "node:test";

import { AssetStatus, Modality, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { readWorkspacePage } from "@/lib/workspace/workspace-read";
import { useAnnotationStore } from "@/stores/image-annotation-store";
import { cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser, workspaceUnique } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("navigation flush exposes failure/conflict and retains the local conflict draft", async () => {
  const store = useAnnotationStore.getState();
  store.clearAutosave("annotation:navigation-failure");
  store.clearAutosave("annotation:navigation-conflict");
  store.scheduleAutosave("annotation:navigation-failure", async () => "failed", 60_000);
  store.scheduleAutosave("annotation:navigation-conflict", async () => "conflict", 60_000);
  store.setConflictDraft("annotation:navigation-conflict", { geometry: { x: 0.2 } });
  const outcomes = await useAnnotationStore.getState().flushAllAutosaves();
  assert.equal(outcomes["annotation:navigation-failure"], "failed");
  assert.equal(outcomes["annotation:navigation-conflict"], "conflict");
  assert.deepEqual(useAnnotationStore.getState().conflictDrafts["annotation:navigation-conflict"], { geometry: { x: 0.2 } });
});

test("selected Asset reconciliation and previous/next stay in a filtered order across page boundaries", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const assets = await Promise.all(Array.from({ length: 102 }, (_, index) => db.asset.create({
      data: {
        datasetId: dataset.id, modality: Modality.IMAGE, filename: `filtered-${String(index).padStart(3, "0")}.png`,
        mimeType: "image/png", sourceFingerprint: workspaceUnique(`filtered-${index}`), batchIndex: Math.floor(index / 100),
        orderIndex: index, status: index === 50 ? AssetStatus.NEW : AssetStatus.COMPLETED,
      }, select: { id: true },
    })));
    const selected = await readWorkspacePage(owner, dataset.id, {
      page: 1, search: "FILTERED", statuses: [AssetStatus.COMPLETED], selectedAsset: { id: assets[100]!.id, modality: Modality.IMAGE },
    });
    assert.equal(selected?.page.page, 1);
    // The one NEW item is excluded, so original index 100 is filtered index 99.
    assert.equal(selected?.page.selectedAsset?.id, assets[100]!.id);
    assert.equal(selected?.page.selectedAsset?.modality, Modality.IMAGE);
    assert.equal(selected?.page.previous?.id, assets[99]!.id);
    assert.equal(selected?.page.next?.id, assets[101]!.id);
    assert.equal(selected?.page.previous?.page, 1);
    assert.equal(selected?.page.next?.page, 2);
    const empty = await readWorkspacePage(owner, dataset.id, { search: "does-not-exist", selectedAsset: { id: assets[0]!.id, modality: Modality.IMAGE } });
    assert.equal(empty?.page.total, 0);
    assert.equal(empty?.page.selectedAsset, null);
    assert.equal(empty?.page.previous, null);
    assert.equal(empty?.page.next, null);
    // A stale/spoofed modality for a real id (e.g. a `?video=` link pointing
    // at an IMAGE asset) must not resolve that asset -- it fails closed to
    // the default first-item selection instead of trusting the caller.
    const mismatched = await readWorkspacePage(owner, dataset.id, {
      page: 1, search: "FILTERED", statuses: [AssetStatus.COMPLETED], selectedAsset: { id: assets[100]!.id, modality: Modality.VIDEO },
    });
    assert.notEqual(mismatched?.page.selectedAsset?.id, assets[100]!.id);
    assert.equal(mismatched?.page.selectedAsset?.id, mismatched?.page.items[0]?.id);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});
