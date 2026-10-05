import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAssetRelativePath } from "../src/asset-relative-path.js";

test("case is preserved -- Cat.jpg and cat.jpg are distinct identities", () => {
  assert.equal(normalizeAssetRelativePath("Cat.jpg"), "Cat.jpg");
  assert.equal(normalizeAssetRelativePath("cat.jpg"), "cat.jpg");
  assert.notEqual(normalizeAssetRelativePath("Cat.jpg"), normalizeAssetRelativePath("cat.jpg"));
});

test("NFKC-equivalent inputs normalize to the same identity despite differing byte lengths", () => {
  const precomposed = "café.png"; // single precomposed é (U+00E9)
  const decomposed = "café.png"; // e + combining acute accent (U+0065 U+0301)
  assert.notEqual(precomposed, decomposed, "fixture sanity: inputs must be byte-distinct before normalization");
  assert.equal(normalizeAssetRelativePath(precomposed), normalizeAssetRelativePath(decomposed));
});

test("backslashes are converted to forward slashes", () => {
  assert.equal(normalizeAssetRelativePath("a\\b\\c.png"), "a/b/c.png");
  assert.equal(normalizeAssetRelativePath("a\\\\b.png"), null, "a doubled backslash becomes a duplicate separator, which is rejected");
});

test("leading and trailing separators are stripped", () => {
  assert.equal(normalizeAssetRelativePath("/a/b"), "a/b");
  assert.equal(normalizeAssetRelativePath("a/b/"), "a/b");
  assert.equal(normalizeAssetRelativePath("///a/b///"), "a/b");
});

test("duplicate separators are REJECTED, not collapsed -- resolves §4's original ambiguity explicitly", () => {
  assert.equal(normalizeAssetRelativePath("a//b"), null);
  assert.equal(normalizeAssetRelativePath("a///b"), null);
  assert.equal(normalizeAssetRelativePath("//"), null);
});

test("'.' segments are rejected", () => {
  assert.equal(normalizeAssetRelativePath("a/./b"), null);
  assert.equal(normalizeAssetRelativePath("."), null);
});

test("'..' segments are rejected (no traversal)", () => {
  assert.equal(normalizeAssetRelativePath("a/../b"), null);
  assert.equal(normalizeAssetRelativePath(".."), null);
  assert.equal(normalizeAssetRelativePath("../../etc/passwd"), null);
});

test("empty results are rejected", () => {
  assert.equal(normalizeAssetRelativePath(""), null);
  assert.equal(normalizeAssetRelativePath("/"), null);
  assert.equal(normalizeAssetRelativePath("   ".trim()), null);
});

test("length bound: 1024 characters is the maximum accepted length", () => {
  const ok = "a".repeat(1024);
  const tooLong = "a".repeat(1025);
  assert.equal(normalizeAssetRelativePath(ok), ok);
  assert.equal(normalizeAssetRelativePath(tooLong), null);
});

test("ordinary multi-segment paths pass through unchanged apart from separator normalization", () => {
  assert.equal(normalizeAssetRelativePath("images/train/photo-01.jpg"), "images/train/photo-01.jpg");
});
