import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { distanceFromRange, isCovered, mergeRange, windowAround } from "@/lib/annotations/video-window-ranges";

test("isCovered exempts the timeline's true start/end from their own margin", () => {
  const ranges = [{ fromMs: 0, toMs: 30_000 }];
  assert.equal(isCovered(ranges, 0, 8_000), true, "range starts at 0 -- nothing earlier to preload");
  assert.equal(isCovered(ranges, 22_000, 8_000), true, "exactly at the margin boundary");
  assert.equal(isCovered(ranges, 22_001, 8_000), false, "inside the margin -- should trigger a refetch");
  assert.equal(isCovered(ranges, 30_000, 8_000, 30_000), true, "range end matches the known duration -- nothing later to preload");
  assert.equal(isCovered(ranges, 30_000, 8_000, 90_000), false, "range end is not the real end -- margin still applies");
  assert.equal(isCovered(ranges, 40_000, 8_000), false, "outside the range entirely");
});

test("mergeRange coalesces overlapping and touching ranges, keeps disjoint ones separate", () => {
  const merged = mergeRange([{ fromMs: 0, toMs: 30_000 }], { fromMs: 22_000, toMs: 60_000 });
  assert.deepEqual(merged, [{ fromMs: 0, toMs: 60_000 }]);
  const touching = mergeRange([{ fromMs: 0, toMs: 30_000 }], { fromMs: 30_000, toMs: 40_000 });
  assert.deepEqual(touching, [{ fromMs: 0, toMs: 40_000 }]);
  const disjoint = mergeRange([{ fromMs: 0, toMs: 10_000 }], { fromMs: 50_000, toMs: 60_000 });
  assert.deepEqual(disjoint, [{ fromMs: 0, toMs: 10_000 }, { fromMs: 50_000, toMs: 60_000 }]);
});

test("windowAround clamps to [0, durationMs] and never produces a zero/negative span", () => {
  assert.deepEqual(windowAround(5_000, 30_000, 8_000, null), { fromMs: 0, toMs: 43_000 });
  assert.deepEqual(windowAround(70_000, 30_000, 8_000, 78_600), { fromMs: 62_000, toMs: 78_600 });
  const atEnd = windowAround(78_600, 30_000, 8_000, 78_600);
  assert.equal(atEnd.toMs, 78_600);
  assert.ok(atEnd.toMs > atEnd.fromMs);
});

test("distanceFromRange is 0 inside a range and the gap to the nearest edge outside it", () => {
  const range = { fromMs: 30_000, toMs: 60_000 };
  assert.equal(distanceFromRange(45_000, range), 0);
  assert.equal(distanceFromRange(30_000, range), 0);
  assert.equal(distanceFromRange(60_000, range), 0);
  assert.equal(distanceFromRange(20_000, range), 10_000);
  assert.equal(distanceFromRange(70_000, range), 10_000);
});
