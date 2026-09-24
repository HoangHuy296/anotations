import { describe, expect, it } from "vitest";

import { buildTextSegments, findLiteralMatches } from "@/lib/workspace/text-dom-segments";

describe("buildTextSegments", () => {
  it("keeps nested entities visible and source offsets intact alongside search", () => {
    const text = "New York University";
    const segments = buildTextSegments(text, [
      { key: "outer", kind: "span", startOffset: 0, endOffset: 19, annotationId: "outer", label: "School" },
      { key: "inner", kind: "span", startOffset: 0, endOffset: 8, annotationId: "inner", label: "Place" },
      { key: "search", kind: "search-match-active", startOffset: 4, endOffset: 8 },
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
    expect(segments.map((segment) => [segment.startOffset, segment.endOffset])).toEqual([[0, 4], [4, 8], [8, 19]]);
    expect(segments[0]).toMatchObject({ annotationId: "inner", label: "School / Place" });
    expect(segments[1].kind).toBe("search-match-active");
    expect(segments[2].annotationId).toBe("outer");
    expect(new Set(segments.map((segment) => segment.key)).size).toBe(segments.length);
  });

  it("returns a single plain segment covering the whole text when there are no highlights", () => {
    const segments = buildTextSegments("OpenAI builds AI.");
    expect(segments).toEqual([{ key: "plain-0", kind: "plain", startOffset: 0, endOffset: 17, text: "OpenAI builds AI." }]);
  });

  it("splits around a single highlight, preserving the exact original substrings on both sides", () => {
    const segments = buildTextSegments("OpenAI builds AI.", [{ key: "m1", kind: "search-match", startOffset: 0, endOffset: 6 }]);
    expect(segments.map((s) => s.text).join("")).toBe("OpenAI builds AI.");
    expect(segments).toEqual([
      { key: "m1", kind: "search-match", startOffset: 0, endOffset: 6, text: "OpenAI" },
      { key: "plain-6", kind: "plain", startOffset: 6, endOffset: 17, text: " builds AI." },
    ]);
  });

  it("handles multiple non-adjacent highlights, including one that ends exactly at the text length", () => {
    const text = "New York University is in New York";
    const secondMatchStart = text.lastIndexOf("New York");
    const segments = buildTextSegments(text, [
      { key: "m1", kind: "search-match", startOffset: 0, endOffset: 8 },
      { key: "m2", kind: "search-match-active", startOffset: secondMatchStart, endOffset: secondMatchStart + 8 },
    ]);
    expect(segments.map((s) => s.text).join("")).toBe(text);
    expect(segments[0]).toMatchObject({ kind: "search-match", text: "New York" });
    expect(segments.at(-1)).toMatchObject({ kind: "search-match-active", text: "New York", endOffset: text.length });
  });

  it("a surrogate-pair emoji highlight round-trips exactly (no split mid-codepoint)", () => {
    const text = "A\u{1F600}B";
    const segments = buildTextSegments(text, [{ key: "m1", kind: "search-match", startOffset: 1, endOffset: 3 }]);
    expect(segments.map((s) => s.text)).toEqual(["A", "\u{1F600}", "B"]);
  });

  it("silently drops a malformed highlight (out of bounds or reversed) rather than corrupting the segment list", () => {
    const segments = buildTextSegments("hello", [{ key: "bad", kind: "search-match", startOffset: 3, endOffset: 100 }]);
    expect(segments.map((s) => s.text).join("")).toBe("hello");
  });

  it("empty source text produces one empty plain segment", () => {
    expect(buildTextSegments("")).toEqual([{ key: "plain-0", kind: "plain", startOffset: 0, endOffset: 0, text: "" }]);
  });
});

describe("findLiteralMatches", () => {
  it("finds every non-overlapping literal occurrence with exact UTF-16 offsets", () => {
    const text = "New York University is in New York";
    const secondMatchStart = text.lastIndexOf("New York");
    expect(findLiteralMatches(text, "New York")).toEqual([
      { startOffset: 0, endOffset: 8 },
      { startOffset: secondMatchStart, endOffset: secondMatchStart + 8 },
    ]);
  });

  it("is case-sensitive (a deliberately literal match, not a fuzzy/case-folded one)", () => {
    expect(findLiteralMatches("OpenAI builds AI.", "openai")).toEqual([]);
    expect(findLiteralMatches("OpenAI builds AI.", "OpenAI")).toEqual([{ startOffset: 0, endOffset: 6 }]);
  });

  it("an empty query matches nothing (not every position)", () => {
    expect(findLiteralMatches("hello", "")).toEqual([]);
  });

  it("adjacent/overlapping candidate matches resolve non-overlapping, left to right (matches String.prototype.indexOf semantics)", () => {
    expect(findLiteralMatches("aaaa", "aa")).toEqual([{ startOffset: 0, endOffset: 2 }, { startOffset: 2, endOffset: 4 }]);
  });

  it("matches a surrogate-pair emoji query as one indivisible unit, at its correct UTF-16 offsets", () => {
    const text = "A\u{1F600}B\u{1F600}C";
    expect(findLiteralMatches(text, "\u{1F600}")).toEqual([{ startOffset: 1, endOffset: 3 }, { startOffset: 4, endOffset: 6 }]);
  });

  it("no match in an empty source", () => {
    expect(findLiteralMatches("", "x")).toEqual([]);
  });
});
