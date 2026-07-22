import assert from "node:assert/strict";
import test from "node:test";

import { denormalizeBoundingBox, imagePointToViewport, normalizeBoundingBox, viewportPointToImage } from "@/lib/workspace/geometry";

test("normalized geometry is invariant across fit, pan, and zoom viewport transforms", () => {
  const original = { x: 0.125, y: 0.25, width: 0.5, height: 0.25 };
  const pixels = denormalizeBoundingBox(original, 1600, 800);
  for (const viewport of [{ x: 40, y: 20, scale: 0.5 }, { x: -320, y: 180, scale: 2 }, { x: 0, y: 0, scale: 1 }]) {
    const topLeft = imagePointToViewport({ x: pixels.x, y: pixels.y }, viewport);
    const restoredPoint = viewportPointToImage(topLeft, viewport);
    assert.deepEqual(restoredPoint, { x: pixels.x, y: pixels.y });
    assert.deepEqual(normalizeBoundingBox(pixels, 1600, 800), original);
  }
});

test("invalid viewport scale does not produce image coordinates", () => {
  assert.equal(viewportPointToImage({ x: 1, y: 1 }, { x: 0, y: 0, scale: 0 }), null);
});
