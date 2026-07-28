import assert from "node:assert/strict";
import test from "node:test";

import { buildMirrorObjectKey, buildSourceFingerprint, normalizeRepositoryPath } from "../../src/jobs/source-fingerprint.js";

test("repository fingerprints are stable, credential-free, and path-normalized", () => {
  const first = buildSourceFingerprint({ provider: "GITEA", owner: "owner", repository: "repo", path: "images\\cat.png" });
  const same = buildSourceFingerprint({ provider: "GITEA", owner: "owner", repository: "repo", path: "images/cat.png" });
  const changed = buildSourceFingerprint({ provider: "GITEA", owner: "owner", repository: "repo", path: "images/dog.png" });
  assert.equal(first, same);
  assert.notEqual(first, changed);
  assert.throws(() => normalizeRepositoryPath("images/../private.png"));
});

test("mirror keys are dataset-scoped and revision-aware", () => {
  const fingerprint = buildSourceFingerprint({ provider: "GITEA", owner: "owner", repository: "repo", path: "images/cat.png" });
  const one = buildMirrorObjectKey({ datasetId: "dataset-a", sourceFingerprint: fingerprint, revision: "commit-a", providerFileIdentity: "blob-a" });
  const same = buildMirrorObjectKey({ datasetId: "dataset-a", sourceFingerprint: fingerprint, revision: "commit-a", providerFileIdentity: "blob-a" });
  const changed = buildMirrorObjectKey({ datasetId: "dataset-a", sourceFingerprint: fingerprint, revision: "commit-b", providerFileIdentity: "blob-b" });
  assert.equal(one, same);
  assert.notEqual(one, changed);
  assert.match(one, /^repository-imports\/dataset-a\/[a-f0-9]{64}$/);
});
