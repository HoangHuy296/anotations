import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { generateReferenceCorpus } from "./generate-reference-corpus";

const reference = JSON.parse(readFileSync(path.resolve(__dirname, "../../../../specs/025-text-workspace-engine/benchmark/reference.json"), "utf8"));

test("reference corpus preserves exact Unicode source and produces valid nested spans and directed relations", () => {
  const result = generateReferenceCorpus(reference);
  assert.equal(result.text.length, reference.corpus.codeUnitLength);
  assert.equal(Buffer.byteLength(result.text), reference.corpus.sourceByteLength);
  assert.equal(`sha256:${createHash("sha256").update(result.text).digest("hex")}`, reference.corpus.sourceIdentity);
  assert.ok(result.text.startsWith("\uFEFF"));
  assert.ok(result.text.includes("\r\n"));
  assert.equal(result.spans.length, reference.corpus.spans);
  const boundaries = new Set(result.boundaries);
  for (const span of result.spans) {
    assert.ok(boundaries.has(span.startOffset));
    assert.ok(boundaries.has(span.endOffset));
    assert.ok(span.startOffset < span.endOffset);
  }
  for (let i = 0; i < result.spans.length; i += 2) {
    assert.equal(result.spans[i].startOffset, result.spans[i + 1].startOffset);
    assert.ok(result.spans[i].endOffset < result.spans[i + 1].endOffset);
  }
  assert.equal(result.relations.length, reference.corpus.relations);
  assert.equal(new Set(result.relations.flatMap((r) => [r.from, r.to])).size, reference.corpus.relations * 2);
  assert.deepEqual(generateReferenceCorpus(reference), result);
});

test("a changed runtime or source identity cannot silently produce another acceptance corpus", () => {
  assert.throws(() => generateReferenceCorpus({ ...reference, runtime: { ...reference.runtime, unicode: "wrong" } }), /profile/);
  assert.throws(() => generateReferenceCorpus({ ...reference, corpus: { ...reference.corpus, sourceIdentity: "sha256:wrong" } }), /identity/);
});
