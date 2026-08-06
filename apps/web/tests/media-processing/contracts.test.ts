import assert from "node:assert/strict";
import test from "node:test";

import {
  MEDIA_PROCESSOR_VERSION,
  createMediaRequestIdentity,
  mediaSourceIdentitySchema,
} from "@/lib/media-processing/contracts";

const source = {
  sourceFingerprint: "source-fingerprint-v1",
  checksum: "sha256:abc123",
  sizeBytes: "42",
  sourceRevision: "commit-123",
};

test("media request identity is stable and credential-free", () => {
  const first = createMediaRequestIdentity({
    assetId: "asset-1",
    type: "EXTRACT_VIDEO_METADATA",
    source,
  });
  const repeated = createMediaRequestIdentity({
    assetId: "asset-1",
    type: "EXTRACT_VIDEO_METADATA",
    source: { ...source },
  });
  const changedRevision = createMediaRequestIdentity({
    assetId: "asset-1",
    type: "EXTRACT_VIDEO_METADATA",
    source: { ...source, sourceRevision: "commit-124" },
  });

  assert.equal(MEDIA_PROCESSOR_VERSION, "fieldframe.media.v1");
  assert.equal(first, repeated);
  assert.notEqual(first, changedRevision);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("media source identity rejects storage and credential-bearing fields", () => {
  const parsed = mediaSourceIdentitySchema.safeParse({
    ...source,
    storageKey: "private/object",
  });

  assert.equal(parsed.success, false);
});
