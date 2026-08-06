import assert from "node:assert/strict";
import test from "node:test";

import { replacePathVertex, resizeNormalizedCircle, translateImageGeometry } from "@/lib/workspace/annotation-geometry";

test("polygon and polyline vertex changes remain normalized and reject duplicate vertices", () => {
  const polygon = { points: [[0.1, 0.1], [0.6, 0.1], [0.2, 0.6]] as [number, number][] };
  assert.deepEqual(replacePathVertex(polygon, 1, [0.7, 0.1]), { points: [[0.1, 0.1], [0.7, 0.1], [0.2, 0.6]] });
  assert.equal(replacePathVertex(polygon, 1, [0.1, 0.1]), null);
  assert.equal(replacePathVertex(polygon, 5, [0.5, 0.5]), null);
});

test("circle resize and whole-shape movement reject normalized bounds violations", () => {
  const circle = { cx: 0.5, cy: 0.5, r: 0.2 };
  assert.ok(Math.abs((resizeNormalizedCircle(circle, [0.8, 0.5])?.r ?? 0) - 0.3) < 1e-9);
  assert.equal(resizeNormalizedCircle(circle, [1.1, 0.5]), null);
  assert.deepEqual(translateImageGeometry({ px: 0.3, py: 0.3 }, 0.2, 0.1), { px: 0.5, py: 0.4 });
  assert.equal(translateImageGeometry({ points: [[0.9, 0.1], [0.8, 0.2]] }, 0.2, 0), null);
});
