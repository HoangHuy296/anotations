import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { handleAiTaskCompleted } from "../../src/jobs/ai-prediction-writer.js";
import { normalizeAiozVideoOutput } from "../../src/providers/ai/aioz-video-normalization.js";

// An in-memory database with exactly the behaviour the writers rely on: the (datasetId, normalizedName) unique key, INSERT .. ON CONFLICT DO NOTHING,
// the Job completion claim, and the track/annotation tables. No SQL is involved; the real-database proof is the web workspace-integration suite.
type Label = { id: string; datasetId: string; normalizedName: string; name: string; modality: string | null; scope: string; color: string };
function world(seedLabels: Array<Partial<Label> & { normalizedName: string }> = []) {
  const labels: Label[] = seedLabels.map((l, i) => ({ id: `seed-${i}`, datasetId: "ds", name: l.normalizedName, modality: "VIDEO", scope: "OBJECT", color: "#000000", ...l }));
  const tracks: Array<{ id: string; videoAssetId: string; labelId: string | null; properties: Record<string, unknown>; name: string }> = [];
  const annotations: Array<Record<string, any>> = [];
  const claims = new Map<string, number>();
  const tx: any = {
    job: { updateMany: async ({ where }: any) => { const used = claims.get(where.id) ?? 0; if (used >= 1 || where.status !== "RUNNING") return { count: 0 }; claims.set(where.id, used + 1); return { count: 1 }; } },
    label: {
      findMany: async ({ where }: any) => labels.filter((l) => l.datasetId === where.datasetId && where.normalizedName.in.includes(l.normalizedName)),
      createMany: async () => { throw new Error("A Label row must never be created because a class was predicted"); },
      create: async () => { throw new Error("A Label row must never be created because a class was predicted"); },
    },
    asset: { updateMany: async () => ({ count: 1 }) },
    videoAsset: { upsert: async () => ({ id: "va-1" }), updateMany: async () => ({ count: 0 }) },
    videoObjectTrack: {
      findMany: async ({ where }: any) => tracks.filter((t) => t.videoAssetId === where.videoAssetId).map((t) => ({ properties: t.properties })),
      create: async ({ data }: any) => { const row = { id: `t-${tracks.length + 1}`, videoAssetId: data.videoAssetId, labelId: data.labelId, properties: data.properties, name: data.name }; tracks.push(row); return { id: row.id }; },
    },
    annotation: {
      createMany: async ({ data }: any) => { annotations.push(...data); return { count: data.length }; },
      create: async ({ data }: any) => { annotations.push(data); return data; },
      findMany: async ({ where }: any) => annotations.filter((a) => a.assetId === where.assetId && a.source === "AI").map((a) => ({ properties: a.properties })),
    },
    aiTask: { update: async ({ data }: any) => { outputs.push(data.output); return {}; } },
  };
  const outputs: any[] = [];
  const db: any = { $transaction: async (fn: any) => fn(tx), job: { updateMany: async () => ({ count: 1 }) } };
  return { db, labels, tracks, annotations, outputs };
}

const live = JSON.parse(readFileSync(new URL("../providers/ai/fixtures/aioz-video-output-live-empty.json", import.meta.url), "utf8"));
const files = [{ assetId: "vid", imageUrl: live[0].video_path }];
const D = ["object", "person", "animal", "vehicle", "text", "aidetect"].map((normalizedName) => ({ normalizedName, modality: "VIDEO" }));
function providerOutput(tracks: Array<{ id: number; cls: number; name: string; frames: number[] }>) {
  const output = structuredClone(live);
  for (const t of tracks) for (const f of t.frames) output[0].frames[f].tracks = [...output[0].frames[f].tracks, { track_id: t.id, class_id: t.cls, class_name: t.name, score: 0.9, bbox_xyxy: [32 + f, 24 + f, 160 + f, 120 + f] }];
  return normalizeAiozVideoOutput(output, files);
}
const videoTask = { id: "task-1", datasetId: "ds", createdById: "u1", modality: "VIDEO", type: "TRACKING", modelKeySnapshot: "cb29e022", input: { assetIds: ["vid"] } } as any;
const run = (w: ReturnType<typeof world>, predictions: unknown, jobId = "job-1", task = videoTask) => handleAiTaskCompleted(w.db, jobId, task, predictions, "lock", "worker");

test("A + G: several classes (two persons, motorcycle, sports ball, tennis racket): every track and keyframe is persisted with its exact predicted class; only a class with an existing compatible Label links to it; no Label is created", async () => {
  const w = world(D);
  const predictions = providerOutput([{ id: 1, cls: 0, name: "person", frames: [10, 11, 12] }, { id: 2, cls: 0, name: "person", frames: [20, 21] }, { id: 3, cls: 3, name: "motorcycle", frames: [30, 31] }, { id: 4, cls: 32, name: "sports ball", frames: [40] }, { id: 5, cls: 38, name: "tennis racket", frames: [41] }]);
  await run(w, predictions);
  assert.equal(w.tracks.length, 5);
  assert.equal(w.labels.length, 6, "the Label row count is unchanged by detecting new classes");
  const personId = w.labels.find((l) => l.normalizedName === "person")!.id;
  for (const track of w.tracks) {
    const cls = track.properties.predictedClass as string;
    assert.equal(track.labelId, cls === "person" ? personId : null, `${cls}: linked only to an existing Label`);
  }
  assert.deepEqual([...new Set(w.annotations.map((a) => a.properties.predictedClass))].sort(), ["motorcycle", "person", "sports ball", "tennis racket"], "the exact AI classes are recorded on every keyframe");
  assert.equal(w.annotations.filter((a) => a.properties.predictedClass === "sports ball").every((a) => a.labelId === null), true);
  assert.deepEqual(w.outputs[0].labelConflicts, []);
});

test("track consistency: every keyframe of a track shares one trackId and label; boxes and timestamps equal the provider's", async () => {
  const w = world(D);
  const predictions = providerOutput([{ id: 7, cls: 0, name: "person", frames: [5, 6, 7] }]);
  await run(w, predictions);
  assert.equal(new Set(w.annotations.map((a) => a.trackId)).size, 1);
  assert.equal(new Set(w.annotations.map((a) => a.labelId)).size, 1);
  assert.deepEqual(w.annotations.map((a) => a.geometry), predictions.map((p) => p.boundingBoxes));
  assert.deepEqual(w.annotations.map((a) => a.timestampMs), predictions.map((p) => p.video!.timestampMs));
  assert.ok(w.annotations.every((a) => a.source === "AI" && a.revision === 1 && a.isKeyframe === true));
});

test("E: a duplicate delivery of the same Job writes nothing; a second task with an identical result creates no label, track or annotation", async () => {
  const w = world(D);
  const predictions = providerOutput([{ id: 1, cls: 0, name: "person", frames: [10, 11] }, { id: 3, cls: 3, name: "motorcycle", frames: [30] }]);
  await run(w, predictions, "job-1");
  const snapshot = [w.labels.length, w.tracks.length, w.annotations.length];
  await run(w, predictions, "job-1");
  assert.deepEqual([w.labels.length, w.tracks.length, w.annotations.length], snapshot, "same job delivered twice");
  await run(w, predictions, "job-2", { ...videoTask, id: "task-2" });
  assert.deepEqual([w.labels.length, w.tracks.length, w.annotations.length], snapshot, "a repeated AI task over the same asset");
  assert.equal(w.outputs.at(-1).tracksSkippedAsDuplicate, 2);
});

test("F: a track a human relabeled or edited is left exactly as is when the AI task is repeated; a genuinely new result is still appended", async () => {
  const w = world(D);
  await run(w, providerOutput([{ id: 1, cls: 0, name: "person", frames: [10, 11] }]));
  const edited = w.tracks[0]!; edited.labelId = "user-chosen-label"; w.annotations.forEach((a) => { a.labelId = "user-chosen-label"; a.revision = 4; a.geometry = { kind: "BOUNDING_BOX", x: 0.5, y: 0.5, width: 0.1, height: 0.1 }; });
  await run(w, providerOutput([{ id: 1, cls: 0, name: "person", frames: [10, 11] }, { id: 9, cls: 3, name: "motorcycle", frames: [42] }]), "job-2", { ...videoTask, id: "task-2" });
  assert.equal(edited.labelId, "user-chosen-label");
  assert.ok(w.annotations.filter((a) => a.trackId === edited.id).every((a) => a.labelId === "user-chosen-label" && a.revision === 4 && a.geometry.x === 0.5));
  assert.equal(w.tracks.length, 2, "only the new motorcycle track was appended");
});

test("J: an incompatible same-key label is reported and never reused; the track keeps its geometry unlabeled; `unknown` stays unlabeled", async () => {
  const w = world([{ normalizedName: "car", modality: "IMAGE", color: "#abcdef" }]);
  await run(w, providerOutput([{ id: 1, cls: 2, name: "car", frames: [10] }, { id: 2, cls: 0, name: "unknown", frames: [12] }, { id: 3, cls: 3, name: "motorcycle", frames: [14] }]));
  assert.equal(w.labels.filter((l) => l.normalizedName === "car").length, 1);
  assert.deepEqual([w.labels[0]!.modality, w.labels[0]!.color], ["IMAGE", "#abcdef"]);
  const byClass = new Map(w.annotations.map((a) => [a.properties.predictedClass, a.labelId]));
  assert.equal(byClass.get("car"), null); assert.equal(byClass.get("unknown"), null); assert.equal(byClass.get("motorcycle"), null, "no Label for motorcycle and none is created");
  assert.equal(w.labels.length, 1);
  assert.deepEqual(w.outputs[0].labelConflicts.map((c: any) => c.classKey), ["car"]);
  assert.equal(w.annotations.length, 3, "no detection is dropped");
});

test("J: a malformed class rejects the whole result with nothing persisted", async () => {
  const w = world(D);
  const predictions = providerOutput([{ id: 1, cls: 0, name: "person", frames: [10] }]);
  (predictions[0] as any).labelKey = "bad\u0000class";
  await assert.rejects(run(w, predictions), /AI_LABEL_CLASS_INVALID/);
  assert.equal(w.tracks.length + w.annotations.length + w.labels.length, 6 /* seeded defaults only */);
});

const imageTask = { id: "task-i", datasetId: "ds", createdById: "u1", modality: "IMAGE", type: "DETECTION", modelKeySnapshot: "68d7f474", input: { assetIds: ["img"] } } as any;
const imagePredictions = [
  { assetId: "img", labelKey: "Person", confidence: 0.9, boundingBoxes: { kind: "BOUNDING_BOX", x: 0.1, y: 0.1, width: 0.2, height: 0.3 } },
  { assetId: "img", labelKey: "Fire Hydrant", confidence: 0.8, boundingBoxes: { kind: "BOUNDING_BOX", x: 0.5, y: 0.5, width: 0.1, height: 0.2 } },
  { assetId: "img", labelKey: "fire hydrant", confidence: 0.7, boundingBoxes: { kind: "BOUNDING_BOX", x: 0.7, y: 0.1, width: 0.1, height: 0.2 } },
];

test("IMAGE keeps its original contract: a detection is persisted only for a class that matches an existing compatible Label; others are skipped; no Label is ever created; a repeat is idempotent", async () => {
  const w = world([{ normalizedName: "person", modality: "IMAGE" }]);
  await run(w, imagePredictions, "job-i1", imageTask);
  assert.equal(w.annotations.length, 1, "only the Person detection matched an existing label");
  assert.equal(w.annotations[0]!.properties.predictedClass, "Person");
  assert.ok(w.annotations[0]!.labelId);
  assert.equal(w.labels.length, 1);
  await run(w, imagePredictions, "job-i2", { ...imageTask, id: "task-i2" });
  assert.equal(w.annotations.length, 1, "an identical repeated task adds nothing");
});
