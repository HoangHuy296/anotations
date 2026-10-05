import assert from "node:assert/strict";
import test from "node:test";

import { resolveHistoricalCandidateRelativePath } from "../src/asset-relative-path-backfill.js";

test("PreparedImportItem.normalizedPath takes precedence when present", () => {
  const result = resolveHistoricalCandidateRelativePath({
    preparedImportNormalizedPath: "a/b/1.png", sourcePath: "ignored/path", datasetSourceRootPath: "ignored", filename: "1.png",
  });
  assert.deepEqual(result, { ok: true, relativePath: "a/b/1.png", source: "PREPARED_IMPORT_ITEM" });
});

test("sourcePath minus a non-empty sourceRootPath prefix, when sourcePath is under it", () => {
  const result = resolveHistoricalCandidateRelativePath({
    preparedImportNormalizedPath: null, sourcePath: "images/train/a/1.png", datasetSourceRootPath: "images/train", filename: "1.png",
  });
  assert.deepEqual(result, { ok: true, relativePath: "a/1.png", source: "REPOSITORY_SOURCE_PATH" });
});

test("sourcePath equal to sourceRootPath (single-file import) falls back to filename", () => {
  const result = resolveHistoricalCandidateRelativePath({
    preparedImportNormalizedPath: null, sourcePath: "images/single.png", datasetSourceRootPath: "images/single.png", filename: "single.png",
  });
  assert.deepEqual(result, { ok: true, relativePath: "single.png", source: "REPOSITORY_SOURCE_PATH" });
});

test("sourcePath used as-is when sourceRootPath is empty or null (matches §8 audit: 73/73 real rows)", () => {
  assert.deepEqual(
    resolveHistoricalCandidateRelativePath({ preparedImportNormalizedPath: null, sourcePath: "a/1.png", datasetSourceRootPath: "", filename: "1.png" }),
    { ok: true, relativePath: "a/1.png", source: "REPOSITORY_SOURCE_PATH" },
  );
  assert.deepEqual(
    resolveHistoricalCandidateRelativePath({ preparedImportNormalizedPath: null, sourcePath: "a/1.png", datasetSourceRootPath: null, filename: "1.png" }),
    { ok: true, relativePath: "a/1.png", source: "REPOSITORY_SOURCE_PATH" },
  );
});

test("filename is the final fallback for a plain upload (no PreparedImportItem, no sourcePath)", () => {
  const result = resolveHistoricalCandidateRelativePath({
    preparedImportNormalizedPath: null, sourcePath: null, datasetSourceRootPath: null, filename: "photo.jpg",
  });
  assert.deepEqual(result, { ok: true, relativePath: "photo.jpg", source: "PLAIN_UPLOAD_FILENAME" });
});

test("an unnormalizable candidate (e.g. traversal-only) is reported, not silently coerced", () => {
  const result = resolveHistoricalCandidateRelativePath({
    preparedImportNormalizedPath: "../escape", sourcePath: null, datasetSourceRootPath: null, filename: "x.jpg",
  });
  assert.deepEqual(result, { ok: false, reason: "UNNORMALIZABLE" });
});

test("case is preserved end-to-end through the resolver, not just the normalizer", () => {
  const result = resolveHistoricalCandidateRelativePath({
    preparedImportNormalizedPath: null, sourcePath: null, datasetSourceRootPath: null, filename: "Cat.jpg",
  });
  assert.deepEqual(result, { ok: true, relativePath: "Cat.jpg", source: "PLAIN_UPLOAD_FILENAME" });
});
