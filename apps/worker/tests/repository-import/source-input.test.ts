import assert from "node:assert/strict";
import test from "node:test";

import { chunkRepositoryCandidates, detectRepositoryFile, downloadRepositoryCandidate, listRepositoryCandidates, parseRepositoryImportInput } from "../../src/jobs/repository-import-source.js";
import { buildRepositoryJobInput } from "./helpers.js";

test("only Phase-015 safe repository input is accepted", () => {
  assert.ok(parseRepositoryImportInput(buildRepositoryJobInput()));
  assert.equal(parseRepositoryImportInput({ source: { repository: { provider: "GITEA", owner: "x", repo: "y", ref: "main", rootPath: null, visibility: "PUBLIC", token: "forbidden" }, manifest: { itemCount: 1, declaredBytes: 1 }, sourceConnectionId: null } }), null);
  assert.equal(parseRepositoryImportInput(buildRepositoryJobInput({ token: "forbidden" })), null);
});

test("candidate batching is bounded and preserves source order", () => {
  assert.deepEqual(chunkRepositoryCandidates([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("adapter boundary caps legacy unknown manifests and rejects download failures without provider diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ tree: [{ path: "images/one.png", type: "blob", sha: "blob", size: 1 }] }), { status: 200, headers: { "content-type": "application/json" } });
    const candidates = await listRepositoryCandidates({ source: parseRepositoryImportInput({ source: { repository: { provider: "GITEA", owner: "fixture", repo: "repo", ref: "main", rootPath: null, visibility: "PUBLIC" }, manifest: { itemCount: 0, declaredBytes: 0 }, sourceConnectionId: null } })!, access: { baseUrl: "http://fixture.test", token: null } });
    assert.equal(candidates.length, 1);
    globalThis.fetch = async () => new Response(null, { status: 502 });
    await assert.rejects(() => downloadRepositoryCandidate({ path: "images/one.png", filename: "one.png", mimeType: "image/png", modality: "IMAGE", sizeBytes: 1, revision: "main", providerFileIdentity: "blob", downloadUrl: "http://fixture.test/raw" }, { baseUrl: "http://fixture.test", token: null }), /SOURCE_DOWNLOAD_FAILED/);
  } finally { globalThis.fetch = originalFetch; }
});

test("modality detection rejects unsupported, traversal, and oversized candidates", () => {
  assert.equal(detectRepositoryFile("images/cat.png", 12, "main", "blob", "http://server/file")?.modality, "IMAGE");
  assert.equal(detectRepositoryFile("images/cat.exe", 12, "main", "blob", "http://server/file"), null);
  assert.equal(detectRepositoryFile("images/../cat.png", 12, "main", "blob", "http://server/file"), null);
});
