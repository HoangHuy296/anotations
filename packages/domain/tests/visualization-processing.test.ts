import assert from "node:assert/strict";
import test from "node:test";
import { artifactIdentity, canonicalJson, captureIdentity, deriveVisualizationProfile, type CapturedContent } from "../src/visualization-processing.js";

const content: CapturedContent = {
  dataset: { id: "dataset", name: "Images", description: null },
  assets: [{ id: "asset", filename: "image.png", modality: "IMAGE", mimeType: "image/png", width: 100, height: 50, sourceIdentity: "a".repeat(64), sourceSha256: "b".repeat(64), sourceBytes: 500 }],
  labels: [{ id: "label", name: "Object", color: "#e11d48", modality: "IMAGE", scope: "OBJECT", description: null }],
  annotations: [{ id: "annotation", assetId: "asset", labelId: "label", type: "BOUNDING_BOX", modality: "IMAGE", geometry: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, revision: 1, status: "DRAFT", source: "MANUAL" }],
};
test("capture identity is deterministic and independent of object-key ordering", () => {
  const first = captureIdentity("dataset", "1", content);
  assert.deepEqual(captureIdentity("dataset", "1", structuredClone(content)), first);
  assert.equal(canonicalJson({ b: 1, a: { y: 2, x: 3 } }), canonicalJson({ a: { x: 3, y: 2 }, b: 1 }));
  assert.notEqual(captureIdentity("dataset", "2", content).snapshotId, first.snapshotId);
  assert.notEqual(captureIdentity("dataset", "1", content, "capture-v2").snapshotId, first.snapshotId);
});
test("all required content axes invalidate capture identity without modifying old input", () => {
  const before = canonicalJson(content), baseline = captureIdentity("dataset", "1", content).snapshotId;
  const mutate: Array<(copy: CapturedContent) => void> = [
    c => { c.assets[0].sourceSha256 = "c".repeat(64); },
    c => { c.assets.push({ ...c.assets[0], id: "second" }); },
    c => { c.assets = []; c.annotations = []; },
    c => { c.labels[0].color = "#000000"; },
    c => { c.annotations[0].revision++; },
    c => { c.annotations[0].geometry = { x: 0, y: 0, width: 1, height: 1 }; },
  ];
  for (const change of mutate) { const copy = structuredClone(content); change(copy); assert.notEqual(captureIdentity("dataset", "1", copy).snapshotId, baseline); }
  assert.equal(canonicalJson(content), before);
});
test("artifact identity includes dataset, snapshot/generation, kind, algorithm and scope", () => {
  const snapshotId = captureIdentity("dataset", "1", content).snapshotId;
  const input = { datasetId: "dataset", snapshotId, generation: "1", kind: "THUMBNAIL" as const, algorithm: "preview-v1", scope: "asset" };
  const expected = artifactIdentity(input);
  assert.equal(artifactIdentity({ ...input }), expected);
  for (const change of [{ datasetId: "other" }, { generation: "2" }, { algorithm: "preview-v2" }, { scope: "other" }, { kind: "PREVIEW" as const }]) assert.notEqual(artifactIdentity({ ...input, ...change }), expected);
});
test("derived profile uses only captured records, preserves label colors and discloses invalid boxes", () => {
  const profile = deriveVisualizationProfile(content);
  assert.equal(profile.annotationCount, 1); assert.equal(profile.validBoundingBoxCount, 1);
  assert.deepEqual(profile.labels, [{ id: "label", name: "Object", color: "#e11d48", count: 1 }]);
  assert.equal(profile.boxAreaHistogram[1].count, 1);
  const changed = structuredClone(content); changed.annotations[0].geometry = { x: 50, y: 10, width: 20, height: 30 };
  assert.equal(deriveVisualizationProfile(changed).invalidBoundingBoxCount, 1);
  assert.equal(profile.invalidBoundingBoxCount, 0);
});
