import assert from "node:assert/strict";
import test from "node:test";
import { decodeUtf8SourceBytes, TextSourceDecodeError } from "../src/text-source-decode.js";
import { readTextSourceLimits, TEXT_SOURCE_LIMIT_DEFAULTS } from "../src/text-source-limits.js";

// research.md D1 fixture table: decoded source, UTF-16 length.
const unicodeFixtures: Array<{ name: string; text: string; codeUnitLength: number }> = [
  { name: "ascii sentence", text: "OpenAI builds AI.", codeUnitLength: 17 },
  { name: "surrogate-pair emoji", text: "A\u{1F600}B", codeUnitLength: 4 },
  { name: "combining mark", text: "é", codeUnitLength: 2 },
  { name: "precomposed accent", text: "é", codeUnitLength: 1 },
  { name: "ZWJ emoji sequence", text: "\u{1F469}‍\u{1F4BB}", codeUnitLength: 5 },
  { name: "CJK", text: "中文", codeUnitLength: 2 },
  { name: "BOM + mixed line endings", text: "﻿A\r\nB\rC\n", codeUnitLength: 8 },
  { name: "empty string", text: "", codeUnitLength: 0 },
];

for (const fixture of unicodeFixtures) {
  test(`decodeUtf8SourceBytes: ${fixture.name} decodes to the exact original source`, () => {
    const bytes = new TextEncoder().encode(fixture.text);
    const decoded = decodeUtf8SourceBytes(bytes);
    assert.equal(decoded.text, fixture.text);
    assert.equal(decoded.codeUnitLength, fixture.codeUnitLength);
    assert.equal(decoded.byteLength, bytes.byteLength);
  });
}

test("decodeUtf8SourceBytes preserves a UTF-8 BOM as U+FEFF instead of stripping it (ignoreBOM: true)", () => {
  const decoded = decodeUtf8SourceBytes(new TextEncoder().encode("﻿hello"));
  assert.equal(decoded.text.codePointAt(0), 0xfeff);
  assert.equal(decoded.text, "﻿hello");
});

test("decodeUtf8SourceBytes rejects invalid UTF-8 fatally instead of substituting U+FFFD", () => {
  const invalid = new Uint8Array([0x41, 0xff, 0x42]); // 'A', invalid byte, 'B'
  assert.throws(() => decodeUtf8SourceBytes(invalid), TextSourceDecodeError);
});

test("decodeUtf8SourceBytes rejects a truncated multi-byte sequence", () => {
  const truncated = new Uint8Array([0xe2, 0x82]); // incomplete 3-byte sequence (should be U+20AC)
  assert.throws(() => decodeUtf8SourceBytes(truncated), TextSourceDecodeError);
});

test("decodeUtf8SourceBytes rejects an overlong / lone continuation byte", () => {
  const loneContinuation = new Uint8Array([0x80]);
  assert.throws(() => decodeUtf8SourceBytes(loneContinuation), TextSourceDecodeError);
});

// Config override fixtures for readTextSourceLimits (FR-042 boundary values).
test("readTextSourceLimits: boundary-value overrides", () => {
  assert.deepEqual(readTextSourceLimits({ TEXT_WORKSPACE_MAX_SOURCE_BYTES: "1" }), {
    ...TEXT_SOURCE_LIMIT_DEFAULTS,
    maxSourceBytes: 1,
  });
  assert.deepEqual(
    readTextSourceLimits({
      TEXT_WORKSPACE_MAX_SOURCE_BYTES: String(TEXT_SOURCE_LIMIT_DEFAULTS.maxSourceBytes),
      TEXT_WORKSPACE_MAX_CODE_UNITS: String(TEXT_SOURCE_LIMIT_DEFAULTS.maxCodeUnits),
      TEXT_WORKSPACE_MAX_ANNOTATIONS: String(TEXT_SOURCE_LIMIT_DEFAULTS.maxAnnotations),
    }),
    TEXT_SOURCE_LIMIT_DEFAULTS,
  );
});

test("readTextSourceLimits: invalid overrides throw rather than silently falling back", () => {
  for (const invalid of ["0", "-1", "1.5", "abc", "NaN", "Infinity"]) {
    assert.throws(
      () => readTextSourceLimits({ TEXT_WORKSPACE_MAX_CODE_UNITS: invalid }),
      undefined,
      `expected ${JSON.stringify(invalid)} to be rejected`,
    );
  }
});

test("readTextSourceLimits: each variable is independently overridable", () => {
  const limits = readTextSourceLimits({ TEXT_WORKSPACE_MAX_ANNOTATIONS: "1" });
  assert.equal(limits.maxAnnotations, 1);
  assert.equal(limits.maxSourceBytes, TEXT_SOURCE_LIMIT_DEFAULTS.maxSourceBytes);
  assert.equal(limits.maxCodeUnits, TEXT_SOURCE_LIMIT_DEFAULTS.maxCodeUnits);
});
