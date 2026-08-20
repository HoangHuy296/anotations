import assert from "node:assert/strict";
import test from "node:test";

import { jobQueuePayloadSchema, queueNameForJobType } from "@annotationplatform/queue";

import { appendLocalFolderImportSchema, startLocalFolderImportSchema } from "@/lib/validation/local-folder-import";
import { safeManifestItem } from "./helpers";

test("local-folder manifest rejects absolute paths and duplicate logical paths", () => {
  assert.equal(startLocalFolderImportSchema.safeParse({ name: "x", idempotencyKey: "a".repeat(16), items: [safeManifestItem("/tmp/private.txt")] }).success, false);
  const item = safeManifestItem("folder/a.txt");
  assert.equal(startLocalFolderImportSchema.safeParse({ name: "x", idempotencyKey: "a".repeat(16), items: [item, item] }).success, false);
});

test("IMPORT_DATASET is delivered with the strict canonical payload", () => {
  assert.equal(queueNameForJobType("IMPORT_DATASET"), "fieldframe-jobs");
  assert.deepEqual(jobQueuePayloadSchema.parse({ jobId: "job-1" }), { jobId: "job-1" });
  assert.equal(jobQueuePayloadSchema.safeParse({ jobId: "job-1", input: {} }).success, false);
});

test("safe import request schema admits all supported modalities without a binary field", () => {
  const types = ["image/png", "video/mp4", "text/plain", "audio/wav"] as const;
  for (const contentType of types) {
    const parsed = startLocalFolderImportSchema.safeParse({ name: "mixed", idempotencyKey: "b".repeat(16), items: [safeManifestItem(`folder/file-${contentType.replace("/", "-")}`, contentType)] });
    assert.equal(parsed.success, true);
    if (parsed.success) assert.equal("binary" in parsed.data.items[0]!, false);
  }
});

test("workspace append schema accepts only a bounded manifest and never a browser Dataset id", () => {
  const item = safeManifestItem("append/photo.png", "image/png");
  assert.equal(appendLocalFolderImportSchema.safeParse({ idempotencyKey: "c".repeat(16), items: [item] }).success, true);
  assert.equal(appendLocalFolderImportSchema.safeParse({ datasetId: "browser-controlled", idempotencyKey: "c".repeat(16), items: [item] }).success, false);
});
