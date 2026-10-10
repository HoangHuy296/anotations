import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { DatasetMemberRole, UserRole } from "@internal/db";

import { reconcileAiLabels } from "@/lib/ai/ai-label-reconcile";
import { db } from "@/lib/db";
import { addWorkspaceMember, cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser, workspaceUnique } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const box = { kind: "BOUNDING_BOX", x: 0.1, y: 0.2, width: 0.3, height: 0.4 };

async function videoFixture(datasetId: string, ownerId: string, tracks: Array<{ cls: string | null; frames: number; trackRevision?: number }>) {
  const asset = await db.asset.create({ data: { datasetId, modality: "VIDEO", filename: `${workspaceUnique("v")}.mp4`, mimeType: "video/mp4", durationMs: 10_000, sourceFingerprint: workspaceUnique("fp") }, select: { id: true } });
  const video = await db.videoAsset.create({ data: { assetId: asset.id }, select: { id: true } });
  const created: Array<{ trackId: string; annotationIds: string[] }> = [];
  for (const [index, t] of tracks.entries()) {
    const props = t.cls === null ? {} : { predictedClass: t.cls, providerTrackId: index + 1 };
    const track = await db.videoObjectTrack.create({ data: { videoAssetId: video.id, createdById: ownerId, name: `AI track ${index + 1}`, annotationType: "BOUNDING_BOX", interpolationMode: "NONE", properties: props, revision: t.trackRevision ?? 1 }, select: { id: true } });
    const annotationIds: string[] = [];
    for (let f = 0; f < t.frames; f++) {
      annotationIds.push((await db.annotation.create({ data: { datasetId, assetId: asset.id, createdById: ownerId, modality: "VIDEO", type: "BOUNDING_BOX", source: "AI", status: "DRAFT", trackId: track.id, isKeyframe: true, frameIndex: f, timestampMs: f * 100, geometry: box, properties: props }, select: { id: true } })).id);
    }
    created.push({ trackId: track.id, annotationIds });
  }
  return { assetId: asset.id, tracks: created };
}

test("C: legacy AI annotations whose class has no label definition are reconciled: label created once, tracks and keyframes linked, boxes untouched, idempotent", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id, "VIDEO");
  try {
    const fx = await videoFixture(dataset.id, owner.id, [{ cls: "person", frames: 3 }, { cls: "Person", frames: 2 }, { cls: "motorcycle", frames: 2 }]);
    const preview = await reconcileAiLabels({ id: owner.id, email: owner.email, name: owner.name, role: UserRole.MANAGER }, dataset.id, { dryRun: true });
    assert.ok(preview.ok);
    assert.equal(preview.scanned, 7); assert.equal(preview.annotationsUpdated, 0);
    assert.equal(await db.label.count({ where: { datasetId: dataset.id } }), 0, "a dry run writes nothing");
    const actor = { id: owner.id, email: owner.email, name: owner.name, role: UserRole.MANAGER };
    const applied = await reconcileAiLabels(actor, dataset.id, { dryRun: false });
    assert.ok(applied.ok);
    assert.equal(applied.annotationsUpdated, 7); assert.equal(applied.tracksUpdated, 3); assert.equal(applied.labelsCreated, 1, "motorcycle; person comes from the six VIDEO defaults");
    const labels = await db.label.findMany({ where: { datasetId: dataset.id }, select: { id: true, normalizedName: true, modality: true } });
    assert.deepEqual(labels.map((l) => l.normalizedName).sort(), ["aidetect", "animal", "motorcycle", "object", "person", "text", "vehicle"]);
    assert.ok(labels.every((l) => l.modality === "VIDEO"));
    const person = labels.find((l) => l.normalizedName === "person")!;
    for (const track of fx.tracks.slice(0, 2)) {
      assert.equal((await db.videoObjectTrack.findUniqueOrThrow({ where: { id: track.trackId }, select: { labelId: true } })).labelId, person.id);
      assert.equal(await db.annotation.count({ where: { trackId: track.trackId, labelId: person.id } }), track.annotationIds.length);
    }
    const geometries = await db.annotation.findMany({ where: { datasetId: dataset.id }, select: { geometry: true, revision: true } });
    for (const g of geometries) { assert.deepEqual(g.geometry, box, "boxes are unchanged"); assert.equal(g.revision, 1, "revisions are unchanged"); }
    const again = await reconcileAiLabels(actor, dataset.id, { dryRun: false });
    assert.ok(again.ok); assert.equal(again.scanned, 0); assert.equal(again.annotationsUpdated, 0);
    assert.equal(await db.label.count({ where: { datasetId: dataset.id } }), 7);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("F: manual edits are preserved: a relabeled, an edited (revision > 1) and an already-labeled row are never touched; rows without recorded class metadata are not guessed", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id, "VIDEO");
  const actor = { id: owner.id, email: owner.email, name: owner.name, role: UserRole.MANAGER };
  try {
    const mine = await db.label.create({ data: { datasetId: dataset.id, modality: "VIDEO", name: "My Person", normalizedName: "my person", color: "#112233" }, select: { id: true } });
    const fx = await videoFixture(dataset.id, owner.id, [{ cls: "person", frames: 2 }, { cls: "person", frames: 2 }, { cls: "person", frames: 2, trackRevision: 3 }, { cls: null, frames: 2 }]);
    await db.annotation.updateMany({ where: { trackId: fx.tracks[0]!.trackId }, data: { labelId: mine.id } });           // user assigned a label
    await db.videoObjectTrack.update({ where: { id: fx.tracks[0]!.trackId }, data: { labelId: mine.id } });
    await db.annotation.update({ where: { id: fx.tracks[1]!.annotationIds[0]! }, data: { revision: 2 } });             // user edited one keyframe
    const result = await reconcileAiLabels(actor, dataset.id, { dryRun: false });
    assert.ok(result.ok);
    assert.equal(result.skipped.noOriginalClass, 2, "no metadata -> not guessed");
    assert.equal(await db.annotation.count({ where: { trackId: fx.tracks[0]!.trackId, labelId: mine.id } }), 2, "the user's label stays");
    assert.equal(await db.annotation.count({ where: { id: fx.tracks[1]!.annotationIds[0]!, labelId: null } }), 1, "the edited keyframe is untouched");
    assert.equal(await db.annotation.count({ where: { trackId: fx.tracks[2]!.trackId, labelId: null } }), 2, "a track revised by a human is skipped entirely");
    assert.equal(await db.annotation.count({ where: { trackId: fx.tracks[3]!.trackId, labelId: null } }), 2);
    assert.equal((await db.label.findUniqueOrThrow({ where: { id: mine.id }, select: { name: true, color: true } })).color, "#112233", "user label settings preserved");
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("J: an incompatible same-key label is a reported conflict (never reused or modified); invalid class metadata is reported, not applied", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id, "VIDEO");
  const actor = { id: owner.id, email: owner.email, name: owner.name, role: UserRole.MANAGER };
  try {
    const imageOnly = await db.label.create({ data: { datasetId: dataset.id, modality: "IMAGE", name: "Car", normalizedName: "car", color: "#abcdef" }, select: { id: true } });
    const fx = await videoFixture(dataset.id, owner.id, [{ cls: "car", frames: 2 }, { cls: "   ", frames: 1 }, { cls: "dog", frames: 1 }]);
    const result = await reconcileAiLabels(actor, dataset.id, { dryRun: false });
    assert.ok(result.ok);
    assert.deepEqual(result.classes.map((c) => [c.predictedClass, c.outcome]).sort(), [["", "INVALID"], ["car", "CONFLICT"], ["dog", "CREATED"]].sort());
    assert.equal(await db.annotation.count({ where: { trackId: fx.tracks[0]!.trackId, labelId: null } }), 2, "the conflicting class is left unlabeled, not forced onto an IMAGE label");
    assert.equal((await db.label.findUniqueOrThrow({ where: { id: imageOnly.id }, select: { modality: true, color: true } })).modality, "IMAGE");
    assert.equal(await db.label.count({ where: { datasetId: dataset.id, normalizedName: "car" } }), 1);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});

test("isolation and authorization: other datasets are untouched; a labeler cannot manage labels; TEXT and AUDIO datasets are refused", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  const outsider = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id, "VIDEO");
  const other = await createWorkspaceDataset(owner.id, "VIDEO");
  const text = await createWorkspaceDataset(owner.id, "TEXT");
  const audio = await createWorkspaceDataset(owner.id, "AUDIO");
  const actor = { id: owner.id, email: owner.email, name: owner.name, role: UserRole.MANAGER };
  try {
    await addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER);
    const mine = await videoFixture(dataset.id, owner.id, [{ cls: "person", frames: 1 }]);
    const theirs = await videoFixture(other.id, owner.id, [{ cls: "person", frames: 1 }]);
    const asLabeler = await reconcileAiLabels({ id: labeler.id, email: labeler.email, name: labeler.name, role: UserRole.LABELER }, dataset.id, { dryRun: false });
    assert.deepEqual(asLabeler.ok ? null : [asLabeler.status, asLabeler.code], [403, "FORBIDDEN"]);
    const asOutsider = await reconcileAiLabels({ id: outsider.id, email: outsider.email, name: outsider.name, role: UserRole.MANAGER }, dataset.id, { dryRun: false });
    assert.deepEqual(asOutsider.ok ? null : [asOutsider.status, asOutsider.code], [404, "NOT_FOUND"]);
    for (const refused of [text, audio]) { const r = await reconcileAiLabels(actor, refused.id, { dryRun: false }); assert.deepEqual(r.ok ? null : [r.status, r.code], [409, "UNSUPPORTED_MODALITY"]); }
    assert.equal(await db.annotation.count({ where: { datasetId: dataset.id, labelId: null } }), 1, "nothing changed after the refusals");
    const ok = await reconcileAiLabels(actor, dataset.id, { dryRun: false });
    assert.ok(ok.ok && ok.annotationsUpdated === 1);
    assert.equal(await db.annotation.count({ where: { id: theirs.tracks[0]!.annotationIds[0]!, labelId: null } }), 1, "the other dataset is untouched");
    assert.equal(await db.label.count({ where: { datasetId: other.id } }), 0);
    void mine;
  } finally { await cleanupWorkspaceFixture([owner.id, labeler.id, outsider.id], [dataset.id, other.id, text.id, audio.id]); }
});

test("legacy defaults: a VIDEO dataset holding the six defaults as IMAGE labels is repaired in place first, then `person` annotations link to that same label row (dry run reports it without writing)", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id, "VIDEO");
  const actor = { id: owner.id, email: owner.email, name: owner.name, role: UserRole.MANAGER };
  try {
    const legacy = await db.label.create({ data: { datasetId: dataset.id, modality: "IMAGE", name: "person", normalizedName: "person", color: "#ff99fc" }, select: { id: true } });
    await videoFixture(dataset.id, owner.id, [{ cls: "person", frames: 2 }]);
    const preview = await reconcileAiLabels(actor, dataset.id, { dryRun: true });
    assert.ok(preview.ok); assert.deepEqual(preview.classes.map((c) => [c.predictedClass, c.outcome]), [["person", "REUSED"]]);
    assert.equal((await db.label.findUniqueOrThrow({ where: { id: legacy.id }, select: { modality: true } })).modality, "IMAGE", "a dry run writes nothing");
    const applied = await reconcileAiLabels(actor, dataset.id, { dryRun: false });
    assert.ok(applied.ok); assert.equal(applied.annotationsUpdated, 2);
    const row = await db.label.findUniqueOrThrow({ where: { id: legacy.id }, select: { modality: true, color: true, name: true } });
    assert.deepEqual([row.modality, row.color, row.name], ["VIDEO", "#ff99fc", "person"]);
    assert.equal(await db.annotation.count({ where: { datasetId: dataset.id, labelId: legacy.id } }), 2);
    assert.equal(await db.label.count({ where: { datasetId: dataset.id, normalizedName: "person" } }), 1);
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});
