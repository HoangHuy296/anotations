import assert from "node:assert/strict";
import test from "node:test";

import { normalizeBoundingBox, denormalizeBoundingBox } from "@/lib/workspace/geometry";
import { normalizedBoundingBoxSchema } from "@/lib/validation/image-workspace";

test("pixel-to-normalized geometry round trips relative to original image dimensions", () => {
  const normalized = normalizeBoundingBox({ x: 200, y: 100, width: 400, height: 200 }, 1000, 500);
  assert.deepEqual(normalized, { x: 0.2, y: 0.2, width: 0.4, height: 0.4 });
  assert.deepEqual(denormalizeBoundingBox(normalized!, 1000, 500), { x: 200, y: 100, width: 400, height: 200 });
});

test("zero, out-of-bound, and missing-dimension boxes cannot become canonical geometry", () => {
  assert.equal(normalizeBoundingBox({ x: 0, y: 0, width: 0, height: 10 }, 100, 100), null);
  assert.equal(normalizeBoundingBox({ x: 0, y: 0, width: 10, height: 10 }, 0, 100), null);
  assert.equal(normalizedBoundingBoxSchema.safeParse({ x: -0.1, y: 0, width: 0.1, height: 0.1 }).success, false);
  assert.equal(normalizedBoundingBoxSchema.safeParse({ x: 0.8, y: 0, width: 0.3, height: 0.1 }).success, false);
});
