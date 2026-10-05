import "../../../../scripts/db-safety/test-entry.cjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DatasetModalityError, datasetWorkspaceEngine } from "@annotationplatform/domain";
import { db } from "@/lib/db";
import { readWorkspacePage, readWorkspaceSelection } from "@/lib/workspace/workspace-read";
import { g5History } from "./g5-fixtures";

const actor = { id: g5History.owner, role: "MANAGER" as const, email: "g5-history-owner@fixture.test", name: "Synthetic G5 owner" };
const modalities = ["IMAGE", "VIDEO", "AUDIO", "TEXT"] as const;

test("Dataset-driven workspace readers preserve empty engines, authorized content, and unresolved history", async () => {
  const owner = await db.user.create({ data: { email: `g5-reader-${randomUUID()}@fixture.test`, role: "MANAGER" } });
  const outsider = await db.user.create({ data: { email: `g5-outsider-${randomUUID()}@fixture.test`, role: "LABELER" } });
  const currentOwner = { id: owner.id, role: "MANAGER" as const, email: owner.email, name: "G5 reader owner" };
  const datasets: string[] = [];
  try {
    const resolved: { datasetId: string; assetId: string; modality: typeof modalities[number] }[] = [];
    for (const modality of modalities) {
      const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `G5 ${modality}`, modality, modalityResolverSubject: owner.id, metadata: { workflowStatus: "IN_PROGRESS" } } });
      datasets.push(dataset.id);
      const empty = await readWorkspacePage(currentOwner, dataset.id);
      assert.ok(empty);
      assert.deepEqual(empty.dataset, { id: dataset.id, name: dataset.name, modality, modalityResolution: "RESOLVED", canResolve: false });
      assert.equal(datasetWorkspaceEngine(empty.dataset), modality);
      assert.equal(empty.page.selectedAsset, null);
      assert.equal(empty.page.previous, null);
      assert.equal(empty.page.next, null);
      assert.deepEqual(empty.page.items, []);
      assert.deepEqual(JSON.parse(JSON.stringify(empty.dataset)), empty.dataset);
      const asset = await db.asset.create({ data: { datasetId: dataset.id, filename: `${modality}.fixture`, modality, mimeType: { IMAGE: "image/png", VIDEO: "video/mp4", AUDIO: "audio/wav", TEXT: "text/plain" }[modality], sourceFingerprint: `g5:${randomUUID()}`, ...(modality === "IMAGE" ? { width: 1, height: 1, imageAsset: { create: {} } } : modality === "VIDEO" ? { videoAsset: { create: {} } } : modality === "AUDIO" ? { audioAsset: { create: {} } } : { textAsset: { create: {} } }) } });
      const selected = await readWorkspaceSelection(currentOwner, dataset.id, asset.id);
      assert.ok(selected);
      assert.equal(selected.engine, modality);
      assert.equal(selected.asset.modality, modality);
      assert.equal(selected.asset.id, asset.id);
      resolved.push({ datasetId: dataset.id, assetId: asset.id, modality });
    }
    const image = resolved[0]!, text = resolved[3]!;
    for (const options of [
      { selectedAsset: { id: image.assetId, modality: "VIDEO" as const } },
      { selectedAsset: { id: text.assetId, modality: "TEXT" as const } },
      { modality: "VIDEO" as const },
    ]) {
      const page = await readWorkspacePage(currentOwner, image.datasetId, options);
      assert.ok(page);
      assert.equal(page.dataset.modality, "IMAGE");
      assert.equal(datasetWorkspaceEngine(page.dataset), "IMAGE");
      assert.ok(!page.page.selectedAsset || page.page.selectedAsset.modality === "IMAGE");
    }
    assert.equal(await readWorkspaceSelection(currentOwner, image.datasetId, text.assetId), null, "cross-Dataset selection is never content for another engine");
    assert.equal(await readWorkspaceSelection(currentOwner, image.datasetId, randomUUID()), null);
    await assert.rejects(db.asset.create({ data: { datasetId: image.datasetId, modality: "TEXT", filename: "spoof.png", mimeType: "image/png", sourceFingerprint: `g5-bypass:${randomUUID()}` } }), /ASSET_MODALITY_MISMATCH/);
    for (const [datasetId, state, selectedId] of [
      [g5History.empty, "EMPTY_UNRESOLVED", randomUUID()],
      [g5History.mixed, "MIXED_UNRESOLVED", g5History.mixedImage],
      [g5History.single, "SINGLE_UNRESOLVED", g5History.singleImage],
    ] as const) {
      const before = await db.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { modality: true, modalityResolverSubject: true, modalityResolvedAt: true, modalityContentRevision: true } });
      const page = await readWorkspacePage(actor, datasetId, { selectedAsset: { id: selectedId, modality: "IMAGE" }, modality: "IMAGE" });
      assert.ok(page);
      assert.equal(page.dataset.modality, null);
      assert.equal(page.dataset.modalityResolution, state);
      assert.equal(page.dataset.canResolve, state === "EMPTY_UNRESOLVED");
      assert.equal(datasetWorkspaceEngine(page.dataset), null);
      assert.equal(page.page.selectedAsset, null);
      assert.equal(page.page.previous, null);
      assert.equal(page.page.next, null);
      await assert.rejects(readWorkspaceSelection(actor, datasetId, selectedId), error => error instanceof DatasetModalityError && error.code === "DATASET_MODALITY_UNRESOLVED");
      assert.deepEqual(await db.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { modality: true, modalityResolverSubject: true, modalityResolvedAt: true, modalityContentRevision: true } }), before, "a workspace read cannot resolve history, seed labels, or advance a fence");
    }
    const memberActor = { id: g5History.manager, role: "MANAGER" as const, email: "g5-history-manager@fixture.test", name: "G5 member" };
    assert.equal((await readWorkspacePage(memberActor, g5History.empty))?.dataset.canResolve, false);
    const unauthorized = { id: outsider.id, role: "ADMIN" as const, email: outsider.email, name: "Stale client authority" };
    assert.equal(await readWorkspacePage(unauthorized, image.datasetId), null, "current persisted authority overrides stale client ADMIN claims");
    assert.equal(await readWorkspaceSelection(unauthorized, image.datasetId, image.assetId), null);
    assert.equal(await readWorkspacePage(currentOwner, randomUUID()), null);
    await db.dataset.update({ where: { id: text.datasetId }, data: { archivedAt: new Date() } });
    assert.equal(await readWorkspacePage(currentOwner, text.datasetId), null);
    assert.equal(await readWorkspaceSelection(currentOwner, text.datasetId, text.assetId), null);
  } finally {
    await db.dataset.deleteMany({ where: { id: { in: datasets } } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, outsider.id] } } });
    await db.$disconnect();
  }
});
