import "../../../../scripts/db-safety/test-entry.cjs"; // G1 gate (offline test: no database is opened).
import assert from "node:assert/strict";
import test from "node:test";

import { repositoryObjectMetadata } from "../../src/jobs/repository-asset-mirror.js";
import { detectRepositoryFile } from "../../src/jobs/repository-import-source.js";

test("repository candidate MIME type is preserved as MinIO object Content-Type", () => {
  for (const [path, expectedMimeType] of [
    ["images/cat.jpg", "image/jpeg"],
    ["images/cat.png", "image/png"],
    ["clips/scene.mp4", "video/mp4"],
  ] as const) {
    const candidate = detectRepositoryFile(path, 12, "main", `blob-${path}`, "http://fixture.invalid/object");
    assert.ok(candidate, `expected a candidate for ${path}`);
    assert.equal(candidate.mimeType, expectedMimeType);
    assert.deepEqual(repositoryObjectMetadata(candidate), { "Content-Type": expectedMimeType });
  }
});
