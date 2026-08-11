import assert from "node:assert/strict";
import test from "node:test";
import { deriveFrameIndex, resolveVideoTimelineDurationMs } from "@/lib/annotations/video-time";
import { deriveInterpolationAt, interpolateBoundingBox } from "@/lib/annotations/video-interpolation";
import { addKeyframeHere } from "@/lib/workspace/video-annotation-client";
import { videoBoundingBoxSchema, videoKeyframeCreateSchema, videoKeyframeDeleteSchema, videoTemporalLabelCreateSchema } from "@/lib/validation/video-annotation";

test("video bounding box validation enforces normalized bounds", () => {
  assert.equal(videoBoundingBoxSchema.safeParse({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }).success, true);
  assert.equal(videoBoundingBoxSchema.safeParse({ x: 0.8, y: 0, width: 0.3, height: 0.1 }).success, false);
  assert.equal(videoBoundingBoxSchema.safeParse({ x: Number.NaN, y: 0, width: 0.1, height: 0.1 }).success, false);
});

test("temporal labels require a positive interval", () => {
  assert.equal(videoTemporalLabelCreateSchema.safeParse({ type: "EVENT", startMs: 0, endMs: 10 }).success, true);
  assert.equal(videoTemporalLabelCreateSchema.safeParse({ type: "EVENT", startMs: 10, endMs: 10 }).success, false);
});

test("frame index is derived only from reliable fps", () => {
  assert.equal(deriveFrameIndex(1000, 25), 25);
  assert.equal(deriveFrameIndex(1000, null), null);
  assert.equal(deriveFrameIndex(1000, 0), null);
});

test("timeline duration prefers totalFrames/fps as authoritative over durationMs", () => {
  assert.equal(resolveVideoTimelineDurationMs({ totalFrames: 300, fps: 30, durationMs: 5000 }), 10000);
  assert.equal(resolveVideoTimelineDurationMs({ totalFrames: null, fps: 30, durationMs: 8000 }), 8000);
  assert.equal(resolveVideoTimelineDurationMs({ totalFrames: 300, fps: null, durationMs: 8000 }), 8000);
  assert.equal(resolveVideoTimelineDurationMs({ totalFrames: 300, fps: 0, durationMs: 8000 }), 8000);
  assert.equal(resolveVideoTimelineDurationMs({ totalFrames: 0, fps: null, durationMs: 0 }), null);
  assert.equal(resolveVideoTimelineDurationMs(null), null);
  assert.equal(resolveVideoTimelineDurationMs(undefined), null);
});

test("linear interpolation is deterministic and not persisted", () => {
  const first = { kind: "BOUNDING_BOX" as const, x: 0, y: 0, width: 0.2, height: 0.2 };
  const second = { kind: "BOUNDING_BOX" as const, x: 0.4, y: 0.4, width: 0.4, height: 0.4 };
  assert.deepEqual(interpolateBoundingBox(first, second, 0.5), { kind: "BOUNDING_BOX", x: 0.2, y: 0.2, width: 0.30000000000000004, height: 0.30000000000000004 });
  assert.equal(deriveInterpolationAt([{ trackId: "t", timestampMs: 0, geometry: first }, { trackId: "t", timestampMs: 1000, geometry: second }], 500)?.derived, true);
  assert.equal(deriveInterpolationAt([{ trackId: "t", timestampMs: 0, geometry: first }], 500), null);
});

test("track-linked keyframe DTO accepts only the track revision authority", () => {
  const base = { expectedTrackRevision: 1, timestampMs: 100, geometry: { x: 0, y: 0, width: 0.25, height: 0.25 } };
  assert.equal(videoKeyframeCreateSchema.safeParse(base).success, true);
  for (const field of ["revision", "expectedRevision", "trackId", "assetId", "datasetId", "labelId", "modality", "isKeyframe", "isInterpolated", "createdById"]) {
    assert.equal(videoKeyframeCreateSchema.safeParse({ ...base, [field]: field === "revision" || field === "expectedRevision" ? 1 : "forbidden" }).success, false, field);
  }
  assert.equal(videoKeyframeDeleteSchema.safeParse({ expectedTrackRevision: 1 }).success, true);
  assert.equal(videoKeyframeDeleteSchema.safeParse({ expectedTrackRevision: 1, expectedRevision: 1 }).success, false);
});

test("Add Keyframe Here sends only the derived geometry and track revision", async () => {
  const originalFetch = globalThis.fetch;
  let sent: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ data: { keyframe: {}, track: {} } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await addKeyframeHere("track-1", { trackId: "track-1", timestampMs: 500, x: 0.2, y: 0.3, width: 0.4, height: 0.2, kind: "BOUNDING_BOX", derived: true }, 7);
    assert.deepEqual(sent, { expectedTrackRevision: 7, timestampMs: 500, geometry: { kind: "BOUNDING_BOX", x: 0.2, y: 0.3, width: 0.4, height: 0.2 } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
