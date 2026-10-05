import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DatasetMemberRole, Modality, UserRole } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { getWebProviders } from "../../src/lib/providers.js";
import { readTextSource } from "../../src/lib/annotations/text-source-read-service.js";
import { __resetTextBoundaryCacheForTests } from "../../src/lib/annotations/text-boundary-loader.js";
import { createWorkspaceUser, createWorkspaceDataset, addWorkspaceMember, cleanupWorkspaceFixture, workspaceUnique } from "../workspace/helpers.js";

const enabled = Boolean(process.env.DATABASE_URL && process.env.MINIO_ENDPOINT && process.env.MINIO_ACCESS_KEY);
const skip = "text source service integration skipped: PostgreSQL/MinIO configuration is unavailable";

const SOURCE_TEXT = "OpenAI builds AI.";

async function seedPreparedTextAsset(datasetId: string) {
  const { config, minio } = getWebProviders();
  const marker = workspaceUnique("text-source-service");
  const storageKey = `text-sources/__test-fixtures__/${marker}/source.txt`;
  const boundaryArtifactKey = `text-boundaries/__test-fixtures__/${marker}/artifact.json`;

  const sourceBytes = Buffer.from(SOURCE_TEXT, "utf8");
  await minio.putObject(config.MINIO_BUCKET, storageKey, sourceBytes, sourceBytes.length, { "Content-Type": "text/plain" });
  const sourceIdentity = `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`;

  const boundaryProfile = { schemaVersion: 1, algorithm: "EXTENDED_GRAPHEME_CLUSTER", nodeVersion: process.versions.node, icuVersion: process.versions.icu ?? "unknown", unicodeVersion: process.versions.unicode ?? "unknown" };
  const artifact = {
    schemaVersion: 1,
    profile: boundaryProfile,
    sourceIdentity,
    offsetUnit: "UTF16_CODE_UNIT",
    sourceCodeUnitLength: SOURCE_TEXT.length,
    boundaryOffsets: Array.from({ length: SOURCE_TEXT.length + 1 }, (_, i) => i),
  };
  const artifactBytes = Buffer.from(JSON.stringify(artifact), "utf8");
  await minio.putObject(config.MINIO_BUCKET, boundaryArtifactKey, artifactBytes, artifactBytes.length, { "Content-Type": "application/json" });
  const boundaryArtifactDigest = `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`;

  const asset = await db.asset.create({
    data: {
      datasetId,
      modality: Modality.TEXT,
      filename: `${marker}.txt`,
      mimeType: "text/plain",
      storageProvider: "MINIO",
      storageBucket: config.MINIO_BUCKET,
      storageKey,
      sourceFingerprint: marker,
      textAsset: {
        create: {
          sourceIdentity,
          sourceEncoding: "UTF8",
          offsetUnit: "UTF16_CODE_UNIT",
          sourceByteLength: sourceBytes.length,
          sourceCodeUnitLength: SOURCE_TEXT.length,
          boundaryArtifactKey,
          boundaryArtifactDigest,
          boundaryProfile,
          preparedSourceFingerprint: marker,
          preparedAt: new Date(),
        },
      },
    },
    select: { id: true },
  });

  return { assetId: asset.id, storageKey, boundaryArtifactKey, config, minio, sourceBytes };
}

test(enabled ? "readTextSource returns READY with the exact decoded source and full boundary map for a real prepared fixture" : skip, { skip: !enabled }, async (t) => {
  __resetTextBoundaryCacheForTests();
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  await addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER);
  const fixture = await seedPreparedTextAsset(dataset.id);

  t.after(async () => {
    await Promise.all([
      fixture.minio.removeObject(fixture.config.MINIO_BUCKET, fixture.storageKey).catch(() => undefined),
      fixture.minio.removeObject(fixture.config.MINIO_BUCKET, fixture.boundaryArtifactKey).catch(() => undefined),
    ]);
    await cleanupWorkspaceFixture([owner.id, labeler.id], [dataset.id]);
  });

  const outcome = await readTextSource(labeler, fixture.assetId);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.readiness, "READY");
  if (outcome.readiness !== "READY") return;
  assert.equal(outcome.text, SOURCE_TEXT);
  assert.equal(outcome.sourceCodeUnitLength, SOURCE_TEXT.length);
  assert.equal(outcome.offsetUnit, "UTF16_CODE_UNIT");
  assert.deepEqual(outcome.boundaryOffsets, Array.from({ length: SOURCE_TEXT.length + 1 }, (_, i) => i));
});

test(enabled ? "readTextSource degrades to SOURCE_MISMATCH when the object is replaced after preparation" : skip, { skip: !enabled }, async (t) => {
  __resetTextBoundaryCacheForTests();
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const fixture = await seedPreparedTextAsset(dataset.id);

  t.after(async () => {
    await Promise.all([
      fixture.minio.removeObject(fixture.config.MINIO_BUCKET, fixture.storageKey).catch(() => undefined),
      fixture.minio.removeObject(fixture.config.MINIO_BUCKET, fixture.boundaryArtifactKey).catch(() => undefined),
    ]);
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  });

  const replaced = Buffer.from("this is not the original source", "utf8");
  await fixture.minio.putObject(fixture.config.MINIO_BUCKET, fixture.storageKey, replaced, replaced.length, { "Content-Type": "text/plain" });

  const outcome = await readTextSource(owner, fixture.assetId);
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.readiness, "SOURCE_MISMATCH");
});

test(enabled ? "readTextSource conceals a TEXT asset from a non-member as NOT_FOUND, never a source excerpt" : skip, { skip: !enabled }, async (t) => {
  __resetTextBoundaryCacheForTests();
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const outsider = await createWorkspaceUser(UserRole.LABELER);
  const fixture = await seedPreparedTextAsset(dataset.id);

  t.after(async () => {
    await Promise.all([
      fixture.minio.removeObject(fixture.config.MINIO_BUCKET, fixture.storageKey).catch(() => undefined),
      fixture.minio.removeObject(fixture.config.MINIO_BUCKET, fixture.boundaryArtifactKey).catch(() => undefined),
    ]);
    await cleanupWorkspaceFixture([owner.id, outsider.id], [dataset.id]);
  });

  const outcome = await readTextSource(outsider, fixture.assetId);
  assert.deepEqual(outcome, { ok: false, reason: "NOT_FOUND" });
});

test(enabled ? "readTextSource reports UNPREPARED for a TEXT asset with an object but no verified metadata yet" : skip, { skip: !enabled }, async (t) => {
  __resetTextBoundaryCacheForTests();
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const { config, minio } = getWebProviders();
  const marker = workspaceUnique("text-source-unprepared");
  const storageKey = `text-sources/__test-fixtures__/${marker}/source.txt`;
  const sourceBytes = Buffer.from("not yet prepared", "utf8");
  await minio.putObject(config.MINIO_BUCKET, storageKey, sourceBytes, sourceBytes.length, { "Content-Type": "text/plain" });
  const asset = await db.asset.create({
    data: { datasetId: dataset.id, modality: Modality.TEXT, filename: `${marker}.txt`, mimeType: "text/plain", storageProvider: "MINIO", storageBucket: config.MINIO_BUCKET, storageKey, sourceFingerprint: marker },
    select: { id: true },
  });

  t.after(async () => {
    await minio.removeObject(config.MINIO_BUCKET, storageKey).catch(() => undefined);
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  });

  const outcome = await readTextSource(owner, asset.id);
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.readiness, "UNPREPARED");
});
