import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

import { Modality, StorageProvider, UserRole } from "@internal/db";
import { datasetWorkspaceEngine } from "@annotationplatform/domain";

import { db } from "@/lib/db";
import { datasetMetadataSelect } from "@/lib/dataset-metadata";
import { resolveAiTarget } from "@/lib/ai/ai-target-service";
import { datasetDestination } from "@/lib/datasets/dataset-destination";
import { readVisualizationAccess } from "@/lib/visualization/access";
import { readVisualizationDataset, VisualizationReadError } from "@/lib/visualization/dataset-read";
import { readWorkspacePage, readWorkspaceSelection } from "@/lib/workspace/workspace-read";
import { addWorkspaceMember, cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser, workspaceUnique } from "./helpers";

// Feasibility probe (read-only against disposable fixtures; not G5 evidence): does the current Prisma/web stack already deliver "Dataset.modality drives
// the workspace engine and the AI-detect target" on the frozen 26-migration chain? Each case creates its own Datasets (no G5 history fixtures).
// T025/T026 also exercise fresh selection visibility, revisions and reopened-viewer lifecycle/RBAC below. Browser navigation/flush acceptance remains separate.
const enabled = Boolean(process.env.DATABASE_URL);
const users: string[] = [];
const datasets: string[] = [];
after(async () => { if (users.length || datasets.length) await cleanupWorkspaceFixture(users, datasets); });
const MODALITIES = [Modality.IMAGE, Modality.VIDEO, Modality.AUDIO, Modality.TEXT] as const;
const MIME = { IMAGE: "image/png", VIDEO: "video/mp4", AUDIO: "audio/wav", TEXT: "text/plain" } as const;
const asset = (datasetId: string, modality: Modality, extra: Record<string, unknown> = {}) => db.asset.create({
  data: { datasetId, modality, filename: `${workspaceUnique(modality)}.bin`, mimeType: MIME[modality], sourceFingerprint: `feas:${randomUUID()}`, sizeBytes: BigInt(1234), storageProvider: StorageProvider.MINIO, storageBucket: "feasibility", storageKey: `feasibility/${randomUUID()}`,
    ...(modality === "IMAGE" ? { width: 1, height: 1, imageAsset: { create: { exif: {} } } } : modality === "VIDEO" ? { videoAsset: { create: { metadata: {} } } } : modality === "AUDIO" ? { audioAsset: { create: { metadata: {} } } } : { textAsset: { create: { tokenization: {}, metadata: {} } } }), ...extra },
  select: { id: true },
});

test("F1 every new Dataset carries exactly one modality in the metadata projection the creation/read routes return", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER); users.push(owner.id);
  for (const modality of MODALITIES) {
    const dataset = await createWorkspaceDataset(owner.id, modality); datasets.push(dataset.id);
    const projected = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: datasetMetadataSelect });
    assert.equal(projected.modality, modality);
    assert.equal(JSON.parse(JSON.stringify(projected)).modality, modality, "serialized response contains dataset.modality");
  }
  await assert.rejects(db.dataset.create({ data: { ownerId: owner.id, name: workspaceUnique("null-modality") } }), /DATASET_MODALITY|modality/i, "a new Dataset without a modality is refused by the database");
});

test("F2 the workspace engine comes only from Dataset.modality: four empty shells, own-modality selection, no client override, no cross-Dataset content", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER); users.push(owner.id);
  const actor = { id: owner.id, role: "MANAGER" as const, email: owner.email, name: owner.name };
  const resolved: Record<string, { datasetId: string; assetId: string }> = {};
  for (const modality of MODALITIES) {
    const dataset = await createWorkspaceDataset(owner.id, modality); datasets.push(dataset.id);
    const empty = await readWorkspacePage(actor, dataset.id);
    assert.ok(empty);
    assert.equal(datasetWorkspaceEngine(empty.dataset), modality);
    assert.equal(empty.dataset.modalityResolution, "RESOLVED");
    assert.equal(empty.page.selectedAsset, null); assert.deepEqual(empty.page.items, []);
    const created = await asset(dataset.id, modality);
    const selected = await readWorkspaceSelection(actor, dataset.id, created.id);
    assert.ok(selected); assert.equal(selected.engine, modality); assert.equal(selected.asset.modality, modality);
    resolved[modality] = { datasetId: dataset.id, assetId: created.id };
  }
  const image = resolved.IMAGE!, text = resolved.TEXT!;
  for (const options of [{ selectedAsset: { id: image.assetId, modality: "VIDEO" as const } }, { selectedAsset: { id: text.assetId, modality: "TEXT" as const } }, { modality: "VIDEO" as const }]) {
    const page = await readWorkspacePage(actor, image.datasetId, options);
    assert.ok(page); assert.equal(page.dataset.modality, "IMAGE"); assert.equal(datasetWorkspaceEngine(page.dataset), "IMAGE");
    assert.ok(!page.page.selectedAsset || page.page.selectedAsset.modality === "IMAGE");
  }
  assert.equal(await readWorkspaceSelection(actor, image.datasetId, text.assetId), null);
  await assert.rejects(asset(image.datasetId, Modality.TEXT), /ASSET_MODALITY_MISMATCH/, "a mixed-modality Asset cannot be created in a resolved Dataset (M24 trigger)");
});

test("F3 bulk AI-detect target resolution works per Dataset modality: IMAGE batches resolve, one VIDEO resolves, VIDEO batches/AUDIO/TEXT are explicitly unverified, foreign Assets are refused whole", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER); users.push(owner.id);
  const make = async (modality: Modality) => { const dataset = await createWorkspaceDataset(owner.id, modality); datasets.push(dataset.id); return dataset.id; };
  const code = async (datasetId: string, assetIds: string[]) => { const r = await resolveAiTarget(datasetId, { mode: "BULK_SELECTION", selection: { mode: "EXPLICIT", assetIds } }); return r.ok ? `OK:${r.modality}:${r.targets.length}` : r.code; };
  const imageDs = await make(Modality.IMAGE);
  const images = [await asset(imageDs, Modality.IMAGE), await asset(imageDs, Modality.IMAGE), await asset(imageDs, Modality.IMAGE)];
  assert.equal(await code(imageDs, images.map((a) => a.id)), "OK:IMAGE:3");
  const videoDs = await make(Modality.VIDEO);
  const videos = [await asset(videoDs, Modality.VIDEO), await asset(videoDs, Modality.VIDEO)];
  assert.equal(await code(videoDs, [videos[0]!.id]), "OK:VIDEO:1");
  assert.equal(await code(videoDs, videos.map((a) => a.id)), "AI_CAPABILITY_UNVERIFIED");
  const audioDs = await make(Modality.AUDIO); const audio = await asset(audioDs, Modality.AUDIO);
  assert.equal(await code(audioDs, [audio.id]), "AI_CAPABILITY_UNVERIFIED");
  const textDs = await make(Modality.TEXT); const text = await asset(textDs, Modality.TEXT);
  assert.equal(await code(textDs, [text.id]), "AI_CAPABILITY_UNVERIFIED");
  // a selection that names an Asset of another Dataset is rejected whole, never reduced
  const foreign = await code(imageDs, [images[0]!.id, videos[0]!.id]);
  assert.notEqual(foreign.startsWith("OK"), true, `foreign Asset in an IMAGE Dataset selection: ${foreign}`);
});

async function workspaceFixture(modality: Modality) {
  const owner = await createWorkspaceUser(UserRole.MANAGER); users.push(owner.id);
  const dataset = await createWorkspaceDataset(owner.id, modality); datasets.push(dataset.id);
  return { dataset, actor: { id: owner.id, role: owner.role, email: owner.email, name: owner.name } };
}

function viewerFailure(status: number, code: VisualizationReadError["code"]) {
  return (error: unknown) => error instanceof VisualizationReadError && error.status === status && error.code === code;
}

for (const modality of MODALITIES) {
  test(`T025 ${modality} selection reloads the current revision and excludes unknown, archived and deleted Assets`, { skip: !enabled }, async () => {
    const { dataset, actor } = await workspaceFixture(modality);
    const created = await asset(dataset.id, modality, { revision: 17, status: "IN_PROGRESS" });
    const initial = await readWorkspaceSelection(actor, dataset.id, created.id);
    assert.ok(initial);
    assert.equal(initial.engine, modality);
    assert.equal(initial.engine === "TEXT" ? initial.asset.revision : initial.asset.version, 17);
    assert.equal(await readWorkspaceSelection(actor, dataset.id, randomUUID()), null);

    await db.asset.update({ where: { id: created.id }, data: { revision: { increment: 1 }, description: "Saved after the initial read" } });
    const fresh = await readWorkspaceSelection(actor, dataset.id, created.id);
    assert.ok(fresh);
    assert.equal(fresh.engine, modality);
    assert.equal(fresh.engine === "TEXT" ? fresh.asset.revision : fresh.asset.version, 18);
    assert.equal(fresh.asset.description, "Saved after the initial read");

    for (const unavailable of [{ archivedAt: new Date(), deletedAt: null }, { archivedAt: null, deletedAt: new Date() }]) {
      await db.asset.update({ where: { id: created.id }, data: unavailable });
      assert.equal(await readWorkspaceSelection(actor, dataset.id, created.id), null);
      const page = await readWorkspacePage(actor, dataset.id, { selectedAsset: { id: created.id, modality } });
      assert.ok(page);
      assert.equal(datasetWorkspaceEngine(page.dataset), modality);
      assert.deepEqual(page.page.items, []);
      assert.equal(page.page.selectedAsset, null);
      assert.equal(page.page.total, 0);
    }

    await db.asset.update({ where: { id: created.id }, data: { archivedAt: null, deletedAt: null } });
    const restored = await readWorkspaceSelection(actor, dataset.id, created.id);
    assert.ok(restored);
    assert.equal(restored.engine === "TEXT" ? restored.asset.revision : restored.asset.version, 18);
  });

  test(`T025 ${modality} workspace reads deny revoked membership and hidden Datasets`, { skip: !enabled }, async () => {
    const { dataset, actor } = await workspaceFixture(modality);
    const created = await asset(dataset.id, modality);
    const member = await createWorkspaceUser(UserRole.LABELER); users.push(member.id);
    const memberActor = { id: member.id, role: member.role, email: member.email, name: member.name };
    const membership = await addWorkspaceMember(dataset.id, member.id, "LABELER");
    assert.equal((await readWorkspaceSelection(memberActor, dataset.id, created.id))?.engine, modality);
    assert.ok(await readWorkspacePage(memberActor, dataset.id));

    await db.datasetMember.delete({ where: { id: membership.id } });
    assert.equal(await readWorkspaceSelection(memberActor, dataset.id, created.id), null);
    assert.equal(await readWorkspacePage(memberActor, dataset.id), null);
    assert.equal((await readWorkspaceSelection(actor, dataset.id, created.id))?.engine, modality);

    for (const unavailable of [{ archivedAt: new Date(), deletedAt: null }, { archivedAt: null, deletedAt: new Date() }]) {
      await db.dataset.update({ where: { id: dataset.id }, data: unavailable });
      assert.equal(await readWorkspaceSelection(actor, dataset.id, created.id), null);
      assert.equal(await readWorkspacePage(actor, dataset.id), null);
    }
  });

  test(`T026 ${modality} catalog and viewer destinations use only the exact COMPLETED lifecycle`, { skip: !enabled }, async () => {
    const { dataset, actor } = await workspaceFixture(modality);
    for (const workflowStatus of ["COMPLETED", "IN_PROGRESS", "REVIEWED", "completed", "COMPLETED ", "UNKNOWN"]) {
      await db.dataset.update({ where: { id: dataset.id }, data: { metadata: { workflowStatus } } });
      if (workflowStatus === "COMPLETED") {
        assert.equal(datasetDestination(dataset.id, workflowStatus), `/datasets/visualize/${dataset.id}`);
        assert.deepEqual(await readVisualizationAccess(actor, dataset.id), { kind: "ready", dataset });
        assert.deepEqual(await readVisualizationDataset(actor, dataset.id), dataset);
      } else {
        assert.equal(datasetDestination(dataset.id, workflowStatus), `/workspace/${dataset.id}`);
        assert.deepEqual(await readVisualizationAccess(actor, dataset.id), { kind: "redirect", destination: `/workspace/${dataset.id}` });
        await assert.rejects(readVisualizationDataset(actor, dataset.id), viewerFailure(409, "DATASET_NOT_COMPLETED"));
      }
    }
    for (const missing of [null, undefined]) assert.equal(datasetDestination(dataset.id, missing), `/workspace/${dataset.id}`);
  });

  test(`T026 ${modality} an opened viewer rechecks lifecycle, membership and Dataset visibility`, { skip: !enabled }, async () => {
    const { dataset, actor } = await workspaceFixture(modality);
    const member = await createWorkspaceUser(UserRole.LABELER); users.push(member.id);
    const memberActor = { id: member.id, role: member.role, email: member.email, name: member.name };
    const membership = await addWorkspaceMember(dataset.id, member.id, "LABELER");
    await db.dataset.update({ where: { id: dataset.id }, data: { metadata: { workflowStatus: "COMPLETED" } } });
    assert.deepEqual(await readVisualizationDataset(actor, dataset.id), dataset);
    assert.deepEqual(await readVisualizationDataset(memberActor, dataset.id), dataset);

    await db.dataset.update({ where: { id: dataset.id }, data: { metadata: { workflowStatus: "IN_PROGRESS" } } });
    assert.deepEqual(await readVisualizationAccess(actor, dataset.id), { kind: "redirect", destination: `/workspace/${dataset.id}` });
    await assert.rejects(readVisualizationDataset(actor, dataset.id), viewerFailure(409, "DATASET_NOT_COMPLETED"));
    await assert.rejects(readVisualizationDataset(memberActor, dataset.id), viewerFailure(409, "DATASET_NOT_COMPLETED"));

    await db.dataset.update({ where: { id: dataset.id }, data: { metadata: { workflowStatus: "COMPLETED" } } });
    assert.deepEqual(await readVisualizationDataset(actor, dataset.id), dataset);
    await db.datasetMember.delete({ where: { id: membership.id } });
    assert.deepEqual(await readVisualizationAccess(memberActor, dataset.id), { kind: "not-found" });
    await assert.rejects(readVisualizationDataset(memberActor, dataset.id), viewerFailure(404, "DATASET_NOT_FOUND"));

    for (const unavailable of [{ archivedAt: new Date(), deletedAt: null }, { archivedAt: null, deletedAt: new Date() }]) {
      await db.dataset.update({ where: { id: dataset.id }, data: unavailable });
      assert.deepEqual(await readVisualizationAccess(actor, dataset.id), { kind: "not-found" });
      await assert.rejects(readVisualizationDataset(actor, dataset.id), viewerFailure(404, "DATASET_NOT_FOUND"));
    }
    assert.deepEqual(await readVisualizationAccess(null, dataset.id), { kind: "not-found" });
    await assert.rejects(readVisualizationDataset(null, dataset.id), viewerFailure(401, "AUTH_REQUIRED"));
  });
}
