import { describe, expect, it } from "vitest";

import { boundedTemporalDraft, translateTemporalDraft } from "@/components/workspace/video-temporal-labels";

describe("video temporal boundary draft", () => {
  it("never allows boundaries to cross or leave the preview duration", () => {
    expect(boundedTemporalDraft({ startMs: 900, endMs: 100, labelId: "" }, 1000)).toMatchObject({ startMs: 900, endMs: 901 });
    expect(boundedTemporalDraft({ startMs: -50, endMs: 9_000, labelId: "" }, 1000)).toMatchObject({ startMs: 0, endMs: 1000 });
  });

  it("keeps the interval valid while moving a whole draft beyond either edge", () => {
    expect(boundedTemporalDraft({ startMs: -100, endMs: 100, labelId: "" }, 1000)).toMatchObject({ startMs: 0, endMs: 100 });
    expect(boundedTemporalDraft({ startMs: 950, endMs: 1_200, labelId: "" }, 1000)).toMatchObject({ startMs: 950, endMs: 1000 });
  });

  it("preserves interval length while a whole-interval drag reaches an edge", () => {
    expect(translateTemporalDraft({ startMs: 800, endMs: 900, labelId: "" }, 500, 1000)).toMatchObject({ startMs: 900, endMs: 1000 });
    expect(translateTemporalDraft({ startMs: 100, endMs: 200, labelId: "" }, -500, 1000)).toMatchObject({ startMs: 0, endMs: 100 });
  });
});
