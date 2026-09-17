import assert from "node:assert/strict";
import test from "node:test";

import { AiozResultError, normalizeAiozOutput } from "../../../src/providers/ai/aioz-annotation-services-normalization.js";

// Verbatim numeric predictions from the user's successful two-file AIOZ result,
// 2026-09-09. Markdown link formatting is presentation, not part of image_path.
const bus = "https://ultralytics.com/images/bus.jpg";
const video = "https://i.ytimg.com/vi/5ku7npMrW40/maxresdefault.jpg";
const images = [{ assetId: "asset-bus", imageUrl: bus }, { assetId: "asset-video", imageUrl: video }];
const fixture = [
  { width: 810, height: 1080, image_path: bus, class_names: ["person", "bicycle", "car"], outputs: [
    { box: [668.0579109191895, 392.17174530029297, 809, 880.3952407836914], score: 0.9430617690086365, class_id: 0, class_name: "person" },
    { box: [49.440871238708496, 398.9389715194702, 246.68424797058105, 902.9632873535156], score: 0.9376829266548157, class_id: 0, class_name: "person" },
    { box: [222.07892417907715, 406.97751331329346, 344.1694564819336, 861.3714694976807], score: 0.9113631248474121, class_id: 0, class_name: "person" },
    { box: [0, 550.282585144043, 77.80166530609131, 874.8715209960938], score: 0.629833996295929, class_id: 0, class_name: "person" },
  ] },
  { width: 1280, height: 720, image_path: video, class_names: ["person", "bicycle", "car"], outputs: [
    { box: [637.1444702148438, 52.26556396484375, 1274.0462646484375, 715.6981201171875], score: 0.9733365774154663, class_id: 0, class_name: "person" },
    { box: [300.7989501953125, 422.13262939453125, 396.3006591796875, 661.6748046875], score: 0.9292691349983215, class_id: 0, class_name: "person" },
  ] },
];

test("real AIOZ sample produces six full-precision top-left normalized boxes", () => {
  const result = normalizeAiozOutput(fixture, images);
  assert.equal(result.length, 6);
  assert.deepEqual(result[0], {
    assetId: "asset-bus", labelKey: "person", confidence: 0.9430617690086365,
    boundingBoxes: { x: 668.0579109191895 / 810, y: 392.17174530029297 / 1080, width: (809 - 668.0579109191895) / 810, height: (880.3952407836914 - 392.17174530029297) / 1080 },
  });
  const first = result[0].boundingBoxes as Record<string, number>;
  for (const [key, expected] of Object.entries({ x: 0.824763, y: 0.363122, width: 0.174002, height: 0.452059 })) assert.ok(Math.abs(first[key] - expected) < 0.000001);
  assert.equal("kind" in first, false);
  assert.equal(JSON.stringify(result).includes("https://"), false);
});

test("reordered multi-image output associates by exact URL, never array index", () => {
  const result = normalizeAiozOutput([...fixture].reverse(), images);
  assert.deepEqual(result.map((prediction) => prediction.assetId), ["asset-video", "asset-video", "asset-bus", "asset-bus", "asset-bus", "asset-bus"]);
});

test("unknown, duplicate, missing, or ambiguous image association fails closed", () => {
  for (const output of [fixture.slice(0, 1), [fixture[0], fixture[0]], [fixture[0], { ...fixture[1], image_path: "https://example.test/unknown" }], []]) {
    assert.throws(() => normalizeAiozOutput(output, images), AiozResultError);
  }
  assert.throws(() => normalizeAiozOutput(fixture, [images[0], images[0]]), AiozResultError);
  assert.throws(() => normalizeAiozOutput(fixture, [images[0], { ...images[1], assetId: images[0].assetId }]), AiozResultError);
});

test("invalid coordinates, zero-area boxes and unsupported geometry are rejected without clamping", () => {
  for (const box of [[-1, 0, 2, 3], [0, -1, 2, 3], [0, 0, 811, 2], [0, 0, 2, 1081], [4, 0, 2, 3], [0, 4, 2, 3], [0, 0, 0, 3], [0, 0, 2, 0], [0, 0, Infinity, 3], [0, NaN, 2, 3], [0, 0, 2], [0, 0, 2, 3, 4], { x: 0, y: 0, width: 2, height: 3 }]) {
    const output = [{ ...fixture[0], outputs: [{ ...fixture[0].outputs[0], box }] }, fixture[1]];
    assert.throws(() => normalizeAiozOutput(output, images), AiozResultError);
  }
});

test("malformed outputs, dimensions, label and score fail with sanitized errors", () => {
  for (const output of [null, {}, [{ ...fixture[0], width: 0 }, fixture[1]], [{ ...fixture[0], height: -1 }, fixture[1]], [{ ...fixture[0], width: Infinity }, fixture[1]], [{ ...fixture[0], outputs: null }, fixture[1]], [{ ...fixture[0], outputs: [{ ...fixture[0].outputs[0], score: 1.1 }] }, fixture[1]], [{ ...fixture[0], outputs: [{ ...fixture[0].outputs[0], class_name: "" }] }, fixture[1]]]) {
    assert.throws(() => normalizeAiozOutput(output, images), (error: unknown) => error instanceof AiozResultError && !error.message.includes(bus));
  }
});

test("explicit empty detections are valid only when every expected image is present", () => {
  assert.deepEqual(normalizeAiozOutput(fixture.map((image) => ({ ...image, outputs: [] })), images), []);
});
