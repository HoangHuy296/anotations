import assert from "node:assert/strict";
import test from "node:test";

import { deriveInterpolationAt, interpolateBoundingBox } from "@/lib/annotations/video-interpolation";

const first = { kind: "BOUNDING_BOX" as const, x: 0.1, y: 0.2, width: 0.2, height: 0.3 };
const second = { kind: "BOUNDING_BOX" as const, x: 0.5, y: 0.4, width: 0.4, height: 0.2 };
const frames = [
  { trackId: "track-a", timestampMs: 1_000, geometry: first },
  { trackId: "track-a", timestampMs: 3_000, geometry: second },
];

test("linear interpolation is deterministic at midpoint and non-midpoint", () => {
  assert.deepEqual(interpolateBoundingBox(first, second, 0.5), {
    kind: "BOUNDING_BOX", x: 0.30000000000000004, y: 0.30000000000000004, width: 0.30000000000000004, height: 0.25,
  });
  assert.deepEqual(deriveInterpolationAt(frames, 1_500), {
    kind: "BOUNDING_BOX", x: 0.2, y: 0.25, width: 0.25, height: 0.275,
    timestampMs: 1_500, trackId: "track-a", derived: true,
  });
  assert.deepEqual(deriveInterpolationAt(frames, 2_000), {
    kind: "BOUNDING_BOX", x: 0.30000000000000004, y: 0.30000000000000004, width: 0.30000000000000004, height: 0.25,
    timestampMs: 2_000, trackId: "track-a", derived: true,
  });
});

test("derived interpolation never replaces exact keyframes or crosses boundaries", () => {
  assert.equal(deriveInterpolationAt(frames, 1_000), null);
  assert.equal(deriveInterpolationAt(frames, 3_000), null);
  assert.equal(deriveInterpolationAt(frames, 999), null);
  assert.equal(deriveInterpolationAt(frames, 3_001), null);
  assert.equal(deriveInterpolationAt(frames, 2_000, "NONE"), null);
  assert.equal(deriveInterpolationAt([frames[0]], 1_500), null);
});
