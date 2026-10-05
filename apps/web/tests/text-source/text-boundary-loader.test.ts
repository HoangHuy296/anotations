import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { getWebProviders } from "../../src/lib/providers.js";
import { loadVerifiedTextBoundaryArtifact, __resetTextBoundaryCacheForTests } from "../../src/lib/annotations/text-boundary-loader.js";

const enabled = Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT && process.env.MINIO_ACCESS_KEY);
const skip = "text boundary loader integration skipped: MinIO configuration is unavailable";

// A unique key per test run so parallel/repeated runs never collide, and so
// cleanup only ever removes objects this test itself created.
const testRunId = `test-run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const artifactKey = `text-boundaries/__test-fixtures__/${testRunId}/artifact.json`;

const validArtifactBody = {
  schemaVersion: 1,
  profile: { schemaVersion: 1, algorithm: "EXTENDED_GRAPHEME_CLUSTER", nodeVersion: process.versions.node, icuVersion: process.versions.icu ?? "unknown", unicodeVersion: process.versions.unicode ?? "unknown" },
  sourceIdentity: "sha256:test-identity",
  offsetUnit: "UTF16_CODE_UNIT",
  sourceCodeUnitLength: 5,
  boundaryOffsets: [0, 5],
};

function digestOf(bytes: Buffer) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

test(enabled ? "loadVerifiedTextBoundaryArtifact loads, validates and caches a real derivative from MinIO" : skip, { skip: !enabled }, async (t) => {
  __resetTextBoundaryCacheForTests();
  const { config, minio } = getWebProviders();
  const bytes = Buffer.from(JSON.stringify(validArtifactBody), "utf8");
  await minio.putObject(config.MINIO_BUCKET, artifactKey, bytes, bytes.length, { "Content-Type": "application/json" });
  t.after(async () => {
    await minio.removeObject(config.MINIO_BUCKET, artifactKey).catch(() => undefined);
  });

  const baseInput = {
    datasetId: "dataset_test",
    assetId: "asset_test",
    storageBucket: config.MINIO_BUCKET,
    boundaryArtifactKey: artifactKey,
    boundaryArtifactDigest: digestOf(bytes),
    sourceIdentity: validArtifactBody.sourceIdentity,
    offsetUnit: validArtifactBody.offsetUnit,
    sourceCodeUnitLength: validArtifactBody.sourceCodeUnitLength,
    boundaryProfile: { algorithm: validArtifactBody.profile.algorithm, schemaVersion: validArtifactBody.profile.schemaVersion },
  };

  const first = await loadVerifiedTextBoundaryArtifact(baseInput);
  assert.equal(first.kind, "loaded");
  if (first.kind === "loaded") assert.deepEqual(first.artifact.boundaryOffsets, [0, 5]);

  // Delete the object, then confirm a cache hit still serves it (proves it is
  // actually reading from cache, not re-fetching every call).
  await minio.removeObject(config.MINIO_BUCKET, artifactKey);
  const cached = await loadVerifiedTextBoundaryArtifact(baseInput);
  assert.equal(cached.kind, "loaded");

  // A different sourceIdentity/digest is a different cache key: this must
  // miss and fail (object is gone), proving the cache cannot serve content
  // under an identity it was never verified against.
  const mismatched = await loadVerifiedTextBoundaryArtifact({ ...baseInput, sourceIdentity: "sha256:different-identity", boundaryArtifactDigest: digestOf(Buffer.from("{}")) });
  assert.equal(mismatched.kind, "missing");
});

test(enabled ? "loadVerifiedTextBoundaryArtifact rejects a digest mismatch and a schema-invalid object" : skip, { skip: !enabled }, async (t) => {
  __resetTextBoundaryCacheForTests();
  const { config, minio } = getWebProviders();
  const tamperedKey = `${artifactKey}.tampered`;
  const invalidKey = `${artifactKey}.invalid`;
  const bytes = Buffer.from(JSON.stringify(validArtifactBody), "utf8");
  const invalidBytes = Buffer.from(JSON.stringify({ not: "a boundary artifact" }), "utf8");
  await minio.putObject(config.MINIO_BUCKET, tamperedKey, bytes, bytes.length, { "Content-Type": "application/json" });
  await minio.putObject(config.MINIO_BUCKET, invalidKey, invalidBytes, invalidBytes.length, { "Content-Type": "application/json" });
  t.after(async () => {
    await Promise.all([
      minio.removeObject(config.MINIO_BUCKET, tamperedKey).catch(() => undefined),
      minio.removeObject(config.MINIO_BUCKET, invalidKey).catch(() => undefined),
    ]);
  });

  const digestMismatch = await loadVerifiedTextBoundaryArtifact({
    datasetId: "dataset_test",
    assetId: "asset_test",
    storageBucket: config.MINIO_BUCKET,
    boundaryArtifactKey: tamperedKey,
    boundaryArtifactDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    sourceIdentity: validArtifactBody.sourceIdentity,
    offsetUnit: validArtifactBody.offsetUnit,
    sourceCodeUnitLength: validArtifactBody.sourceCodeUnitLength,
    boundaryProfile: { algorithm: validArtifactBody.profile.algorithm, schemaVersion: validArtifactBody.profile.schemaVersion },
  });
  assert.equal(digestMismatch.kind, "digest_mismatch");

  const schemaInvalid = await loadVerifiedTextBoundaryArtifact({
    datasetId: "dataset_test",
    assetId: "asset_test",
    storageBucket: config.MINIO_BUCKET,
    boundaryArtifactKey: invalidKey,
    boundaryArtifactDigest: digestOf(invalidBytes),
    sourceIdentity: "sha256:whatever",
    offsetUnit: "UTF16_CODE_UNIT",
    sourceCodeUnitLength: 0,
    boundaryProfile: { algorithm: "EXTENDED_GRAPHEME_CLUSTER", schemaVersion: 1 },
  });
  assert.equal(schemaInvalid.kind, "schema_invalid");
});

test(enabled ? "loadVerifiedTextBoundaryArtifact reports missing for a nonexistent object" : skip, { skip: !enabled }, async () => {
  __resetTextBoundaryCacheForTests();
  const { config } = getWebProviders();
  const result = await loadVerifiedTextBoundaryArtifact({
    datasetId: "dataset_test",
    assetId: "asset_test",
    storageBucket: config.MINIO_BUCKET,
    boundaryArtifactKey: `text-boundaries/__test-fixtures__/${testRunId}/does-not-exist.json`,
    boundaryArtifactDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    sourceIdentity: "sha256:whatever",
    offsetUnit: "UTF16_CODE_UNIT",
    sourceCodeUnitLength: 0,
    boundaryProfile: { algorithm: "EXTENDED_GRAPHEME_CLUSTER", schemaVersion: 1 },
  });
  assert.equal(result.kind, "missing");
});
