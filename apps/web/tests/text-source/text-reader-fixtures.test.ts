import assert from "node:assert/strict";
import test from "node:test";

import { buildTextSegments, findLiteralMatches, nextTextMatchIndex } from "@/lib/workspace/text-dom-segments";

const fixtures = ["OpenAI builds AI.", "A😀B", "e\u0301", "é", "👩‍💻", "中文", "\uFEFFA\r\nB\rC\n", "", "   ", "<script>alert('text')</script>"];
for (const source of fixtures) {
  test(`reader preserves original UTF-16 source ${JSON.stringify(source)}`, () => {
    const query = source.slice(0, source.startsWith("👩") ? 5 : 1);
    const matches = findLiteralMatches(source, query);
    const segments = buildTextSegments(source, matches.map((match, index) => ({ ...match, key: `search-${index}`, kind: index === 0 ? "search-match-active" : "search-match" })));
    assert.equal(segments.map((segment) => segment.text).join(""), source);
    for (const segment of segments) assert.equal(segment.text, source.slice(segment.startOffset, segment.endOffset));
    // Search is presentation only; it never manufactures saved annotation geometry.
    assert.ok(segments.every((segment) => ["plain", "search-match", "search-match-active"].includes(segment.kind)));
  });
}
test("search navigation wraps in both directions using original offsets", () => {
  const source = "😀 AI\r\nAI 中文 AI";
  const matches = findLiteralMatches(source, "AI");
  assert.deepEqual(matches.map((match) => source.slice(match.startOffset, match.endOffset)), ["AI", "AI", "AI"]);
  assert.equal(nextTextMatchIndex(0, matches.length, -1), 2);
  assert.equal(nextTextMatchIndex(2, matches.length, 1), 0);
  assert.equal(nextTextMatchIndex(null, 0, 1), null);
});
