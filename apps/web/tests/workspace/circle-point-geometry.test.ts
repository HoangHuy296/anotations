import assert from "node:assert/strict";
import test from "node:test";

import { fitNormalizedCircle, moveNormalizedCircle, moveNormalizedPoint } from "@/lib/workspace/annotation-geometry";

test("a dragged circle is clamped inside the image instead of snapping to the corner", () => {
  assert.deepEqual(moveNormalizedCircle({ cx: 0.5, cy: 0.5, r: 0.1 }, 1.4, -0.3), { cx: 0.9, cy: 0.1, r: 0.1 });
  assert.deepEqual(moveNormalizedCircle({ cx: 0.5, cy: 0.5, r: 0.1 }, 0.4, 0.6), { cx: 0.4, cy: 0.6, r: 0.1 });
  assert.equal(moveNormalizedCircle({ cx: 0.5, cy: 0.5, r: 0.1 }, Number.NaN, 0.5), null);
  assert.deepEqual(moveNormalizedPoint(1.5, -2), { px: 1, py: 0 });
  const fitted = fitNormalizedCircle(0.95, 0.5, 0.2);
  assert.ok(fitted && Math.abs(fitted.r - 0.05) < 1e-9 && fitted.cx === 0.95 && fitted.cy === 0.5);
  assert.equal(fitNormalizedCircle(1, 0.5, 0.2), null);
});
