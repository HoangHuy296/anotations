import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { computeTextBoundaryArtifact } from "../../src/source/text-boundary.js";
import { verifyTextSourceBytes } from "../../src/source/text-source-verify.js";
import { isTextBoundaryOffset } from "@annotationplatform/domain/text-boundary-contract";

// research.md D1 fixture table: decoded source, UTF-16 length, valid endpoints.
const fixtures: Array<{ name: string; text: string; validEndpoints: number[] }> = [
  { name: "ascii sentence", text: "OpenAI builds AI.", validEndpoints: Array.from({ length: 18 }, (_, i) => i) },
  { name: "surrogate-pair emoji", text: "A\u{1F600}B", validEndpoints: [0, 1, 3, 4] },
  { name: "combining mark", text: "é", validEndpoints: [0, 2] },
  { name: "precomposed accent", text: "é", validEndpoints: [0, 1] },
  { name: "ZWJ emoji sequence", text: "\u{1F469}‍\u{1F4BB}", validEndpoints: [0, 5] },
  { name: "CJK", text: "中文", validEndpoints: [0, 1, 2] },
  { name: "BOM + mixed line endings", text: "﻿A\r\nB\rC\n", validEndpoints: [0, 1, 2, 4, 5, 6, 7, 8] },
  { name: "empty string", text: "", validEndpoints: [0] },
];

for (const fixture of fixtures) {
  test(`computeTextBoundaryArtifact: ${fixture.name} produces exactly the documented valid endpoints`, () => {
    const artifact = computeTextBoundaryArtifact({ text: fixture.text, sourceIdentity: "sha256:test" });
    assert.deepEqual(artifact.boundaryOffsets, fixture.validEndpoints);
    assert.equal(artifact.sourceCodeUnitLength, fixture.text.length);
    for (const offset of fixture.validEndpoints) {
      assert.equal(isTextBoundaryOffset(artifact, offset), true, `expected ${offset} to be a valid boundary`);
    }
    // Every integer strictly between two consecutive valid endpoints must be rejected.
    for (let i = 0; i < fixture.validEndpoints.length - 1; i += 1) {
      for (let offset = fixture.validEndpoints[i] + 1; offset < fixture.validEndpoints[i + 1]; offset += 1) {
        assert.equal(isTextBoundaryOffset(artifact, offset), false, `expected ${offset} to be rejected (splits a grapheme cluster)`);
      }
    }
  });
}

test("computeTextBoundaryArtifact records the actual runtime profile, not a hardcoded one", () => {
  const artifact = computeTextBoundaryArtifact({ text: "hi", sourceIdentity: "sha256:test" });
  assert.equal(artifact.profile.nodeVersion, process.versions.node);
  assert.equal(artifact.profile.algorithm, "EXTENDED_GRAPHEME_CLUSTER");
});

test("verifyTextSourceBytes: full Unicode fixture matrix decodes to the exact original source and a stable sha256 identity", () => {
  for (const fixture of fixtures) {
    const bytes = new TextEncoder().encode(fixture.text);
    const result = verifyTextSourceBytes(bytes, { maxSourceBytes: 1_048_576, maxCodeUnits: 100_000, maxAnnotations: 5000 });
    assert.equal(result.kind, "verified");
    if (result.kind !== "verified") continue;
    assert.equal(result.text, fixture.text);
    assert.equal(result.codeUnitLength, fixture.text.length);
    assert.match(result.sourceIdentity, /^sha256:[0-9a-f]{64}$/);
    // Digest is deterministic and byte-exact, not derived from the decoded string.
    const again = verifyTextSourceBytes(bytes, { maxSourceBytes: 1_048_576, maxCodeUnits: 100_000, maxAnnotations: 5000 });
    assert.equal(again.kind === "verified" ? again.sourceIdentity : null, result.sourceIdentity);
  }
});

test("verifyTextSourceBytes rejects invalid UTF-8 and oversized inputs without a partial identity", () => {
  const invalid = verifyTextSourceBytes(new Uint8Array([0x41, 0xff]), { maxSourceBytes: 1_048_576, maxCodeUnits: 100_000, maxAnnotations: 5000 });
  assert.equal(invalid.kind, "invalid_encoding");

  const oversizedBytes = verifyTextSourceBytes(new TextEncoder().encode("abcdef"), { maxSourceBytes: 3, maxCodeUnits: 100_000, maxAnnotations: 5000 });
  assert.equal(oversizedBytes.kind, "oversized_bytes");

  const oversizedCodeUnits = verifyTextSourceBytes(new TextEncoder().encode("abcdef"), { maxSourceBytes: 1_048_576, maxCodeUnits: 3, maxAnnotations: 5000 });
  assert.equal(oversizedCodeUnits.kind, "oversized_code_units");
});
