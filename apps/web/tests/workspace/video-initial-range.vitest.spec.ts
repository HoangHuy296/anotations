import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import { describe, expect, it } from "vitest";

import { initialLoadedRange, isCovered } from "@/lib/annotations/video-window-ranges";

const page = (hasMore: boolean, stamps: number[]) => ({ effectiveFromMs: 0, effectiveToMs: 30_000, hasMore, keyframes: stamps.map((timestampMs) => ({ timestampMs })) });

describe("initial loaded range of a server-rendered annotation page", () => {
  it("a complete page covers its whole requested window", () => {
    expect(initialLoadedRange(page(false, [0, 120, 29_960]))).toEqual({ fromMs: 0, toMs: 30_000 });
    expect(initialLoadedRange(page(false, []))).toEqual({ fromMs: 0, toMs: 30_000 });
  });

  it("a truncated page covers only up to its last keyframe (minus 1 ms), so the remainder is fetched instead of silently empty", () => {
    const range = initialLoadedRange(page(true, [0, 40, 6_800, 6_760]));
    expect(range).toEqual({ fromMs: 0, toMs: 6_799 });
    expect(isCovered([range], 12_000, 8_000, 78_000)).toBe(false); // 12 s is not claimed as loaded: the engine fetches the window around it
    expect(isCovered([range], 3_000, 3_000, 78_000)).toBe(true);
  });

  it("never reaches beyond the requested window or before its start", () => {
    expect(initialLoadedRange(page(true, [45_000]))).toEqual({ fromMs: 0, toMs: 30_000 });
    expect(initialLoadedRange(page(true, []))).toEqual({ fromMs: 0, toMs: 0 });
  });
});

describe("window bookkeeping that matches a re-applied server page", () => {
  it("seeds exactly the page's ranges and ids; a truncated page is not claimed as a full window", async () => {
    const { seedWindowBookkeeping } = await import("@/lib/annotations/video-window-ranges");
    const seeded = seedWindowBookkeeping({ effectiveFromMs: 0, effectiveToMs: 30_000, hasMore: true, keyframes: [{ id: "k1", timestampMs: 100 }, { id: "k2", timestampMs: 6_800 }], tracks: [{ id: "t1" }] });
    expect(seeded.loadedRanges).toEqual([{ fromMs: 0, toMs: 6_799 }]);
    expect(seeded.ledger).toEqual([{ range: { fromMs: 0, toMs: 6_799 }, keyframeIds: ["k1", "k2"], trackIds: ["t1"] }]);
    const complete = seedWindowBookkeeping({ effectiveFromMs: 0, effectiveToMs: 30_000, hasMore: false, keyframes: [], tracks: [] });
    expect(complete.loadedRanges).toEqual([{ fromMs: 0, toMs: 30_000 }]);
  });
});
