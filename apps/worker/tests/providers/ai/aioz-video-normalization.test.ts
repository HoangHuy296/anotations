import "../../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeAiozVideoOutput } from "../../../src/providers/ai/aioz-video-normalization.js";
import { AiozAnnotationServicesProvider, digestAiozImageUrl, type AiozTaskResources } from "../../../src/providers/ai/aioz-annotation-services-provider.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/aioz-video-output.json", import.meta.url), "utf8"));
const files = [{ assetId: "video-asset", imageUrl: "https://storage.test/video.mp4" }];
const taskId = "7632d9ff-dc0a-43ac-9bc3-eb291f28c70b";
const modelId = "cb29e022-1ba7-4349-9dce-4fb3074e84d6";
const clone = () => structuredClone(fixture);

test("supplied 850-frame output becomes 10 tracks and 38 frame-accurate observations", () => {
  const predictions = normalizeAiozVideoOutput(fixture, files);
  assert.equal(predictions.length, 38);
  assert.equal(new Set(predictions.map((p) => p.video?.trackId)).size, 10);
  assert.deepEqual(predictions[0], {
    assetId: "video-asset", labelKey: "unknown", confidence: 0.6021,
    boundingBoxes: { kind: "BOUNDING_BOX", x: 728.4 / 1280, y: 473.63 / 720, width: (1041.23 - 728.4) / 1280, height: (719.49 - 473.63) / 720 },
    video: { trackId: 1, frameIndex: 54, timestampMs: Math.round(54 * 1000 / 29.907), classId: 56, fps: 29.907, totalFrames: 850 },
  });
  assert.ok(predictions.every((p) => p.labelKey === "unknown"));
  assert.equal(JSON.stringify(predictions).includes("https://"), false);
});

test("video class_name maps to the Annotation Platform label key", () => {
  const output = clone();
  output[0].frames[54].tracks[0].class_name = "dog";
  const predictions = normalizeAiozVideoOutput(output, files);
  assert.equal(predictions[0].labelKey, "dog");
});

test("empty frames create nothing and reordered videos retain scoped track IDs", () => {
  const empty = clone();
  for (const frame of empty[0].frames) frame.tracks = [];
  assert.deepEqual(normalizeAiozVideoOutput(empty, files), []);
  const second = clone()[0]; second.video_path = "https://storage.test/second.mp4";
  const predictions = normalizeAiozVideoOutput([second, fixture[0]], [...files, { assetId: "second", imageUrl: second.video_path }]);
  assert.equal(predictions.length, 76);
  assert.equal(predictions[0].assetId, "second");
  assert.equal(predictions[38].assetId, "video-asset");
});

test("malformed/truncated frames, invalid boxes, inconsistent classes, and ambiguous mapping fail closed", () => {
  const changes = [
    (v: typeof fixture) => { v[0].fps = 0; },
    (v: typeof fixture) => { v[0].frames.pop(); },
    (v: typeof fixture) => { v[0].frames[0].frame_id = 1; },
    (v: typeof fixture) => { v[0].frames[54].tracks.push(v[0].frames[54].tracks[0]); },
    (v: typeof fixture) => { v[0].frames[56].tracks[0].class_id = 0; },
    (v: typeof fixture) => { v[0].frames[54].tracks[0].bbox_xyxy = [-1, 0, 10, 20]; },
    (v: typeof fixture) => { v[0].frames[54].tracks[0].bbox_xyxy = [1, 0, 1, 20]; },
    (v: typeof fixture) => { v[0].frames[54].tracks[0].bbox_xyxy = [0, 0, 1281, 20]; },
    (v: typeof fixture) => { v[0].video_path = "https://storage.test/wrong.mp4"; },
    (v: typeof fixture) => { v[0].status = "failed"; },
  ];
  for (const change of changes) { const value = clone(); change(value); assert.throws(() => normalizeAiozVideoOutput(value, files), /AIOZ_/); }
  assert.throws(() => normalizeAiozVideoOutput([fixture[0], fixture[0]], [files[0], { assetId: "other", imageUrl: "https://storage.test/other" }]), /AIOZ_ASSET_ASSOCIATION_INVALID/);
});

function resources(): AiozTaskResources {
  return {
    prepare: async () => ({ modelId, mediaType: "video", taskName: "tracking", images: files, options: { classes: ["person", "bicycle", "car"], confidence_threshold: 0.5, iou_threshold: 0.5 } }),
    recordSubmission: async () => {},
    loadImages: async () => files.map((file) => ({ assetId: file.assetId, urlDigest: digestAiozImageUrl(file.imageUrl), mediaType: "video" })),
  };
}
const config = { baseUrl: "http://aioz.test", apiKey: "test-only", timeoutMs: 1000 };
test("video submit uses type=video/task_name=tracking and poll matches video_path against durable digest", async () => {
  let recorded = false;
  const store = resources(); store.recordSubmission = async (_id, external) => { assert.equal(external, taskId); recorded = true; };
  const provider = new AiozAnnotationServicesProvider(config, store, async (_url, init) => {
    if (init?.method === "POST") {
      assert.deepEqual(JSON.parse(String(init.body)), { type: "video", task_name: "tracking", files: [files[0].imageUrl], model_id: modelId, classes: ["person", "bicycle", "car"], confidence_threshold: 0.5, iou_threshold: 0.5 });
      return Response.json({ success: true, data: { task_id: taskId, status: "create", created_at: "2026-09-11T07:05:06Z" } });
    }
    return Response.json({ success: true, data: { task_id: taskId, status: "success", output: fixture, error: null } });
  });
  await provider.submitTask({ aiTaskId: "local", modelKey: modelId, assetIds: [files[0].assetId] });
  assert.equal(recorded, true);
  const result = await provider.getTaskStatus(taskId);
  assert.equal(result.status, "COMPLETED");
  if (result.status === "COMPLETED") assert.equal(provider.normalizePredictions(result.rawPredictions).length, 38);
});

test("video results cannot be interpreted as image results or bypass video validation", async () => {
  for (const mediaType of ["image", "video"] as const) {
    const store = resources();
    store.loadImages = async () => [{ assetId: files[0].assetId, urlDigest: digestAiozImageUrl(files[0].imageUrl), mediaType }];
    const output = clone(); output[0].frames.pop();
    const provider = new AiozAnnotationServicesProvider(config, store, async () => Response.json({ success: true, data: { task_id: taskId, status: "success", output, error: null } }));
    assert.equal((await provider.getTaskStatus(taskId)).status, "FAILED");
  }
});
