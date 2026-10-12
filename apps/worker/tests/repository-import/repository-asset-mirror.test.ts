import "../../../../scripts/db-safety/test-entry.cjs"; // G1 gate (offline test: no database is opened).
import assert from "node:assert/strict";
import test from "node:test";

import { REPOSITORY_OBJECT_CONTENT_TYPES, repositoryObjectMetadata } from "../../src/jobs/repository-asset-mirror.js";
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

test("every extension the importer maps is an allowed stored Content-Type, and any other value is stored as an opaque download", () => {
  for (const path of ["a.jpg", "a.jpeg", "a.png", "a.webp", "a.mp4", "a.webm", "a.txt", "a.json", "a.csv", "a.mp3", "a.ogg", "a.wav"]) {
    const candidate = detectRepositoryFile(path, 12, "main", `blob-${path}`, "http://fixture.invalid/object");
    assert.ok(candidate && REPOSITORY_OBJECT_CONTENT_TYPES.has(candidate.mimeType), path);
    assert.equal(repositoryObjectMetadata(candidate)["Content-Type"], candidate.mimeType, path);
  }
  for (const forged of ["text/html", "image/svg+xml", "application/javascript", "video/mp4\r\nX-Injected: 1", "", "VIDEO/MP4"]) {
    assert.deepEqual(repositoryObjectMetadata({ mimeType: forged }), { "Content-Type": "application/octet-stream" }, JSON.stringify(forged));
  }
});
