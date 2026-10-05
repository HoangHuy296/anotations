import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Redis } from "ioredis";

import { ASSET_WRITE_QUIESCENCE_REDIS_KEY, AssetWritesQuiescedError } from "@annotationplatform/domain/asset-write-quiescence";

import { getWorkerConfig } from "../../src/config.js";
import { upsertMirroredRepositoryAsset } from "../../src/jobs/repository-asset-upsert.js";
import { createWorkerDatabase } from "../../src/providers/db.js";

const enabled = Boolean(process.env.DATABASE_URL);

/**
 * specs/027-coco-dataset-export §10a -- permanent regression coverage for
 * the worker-side writer boundary, proving the actual guarded function
 * (not just the standalone guard), mirroring
 * apps/web/tests/asset-write-quiescence/writer-boundaries.test.ts for the
 * web-side boundary. Together these two files are the "both reachable
 * writer boundaries" coverage requested explicitly.
 */
test("PAUSE ON prevents upsertMirroredRepositoryAsset (the worker writer boundary) from creating an Asset; PAUSE OFF restores it", { skip: enabled ? false : "database unavailable" }, async () => {
  const db = createWorkerDatabase(getWorkerConfig());
  const config = getWorkerConfig();
  const redis = new Redis({ host: config.REDIS_HOST, port: config.REDIS_PORT, password: config.REDIS_PASSWORD, db: config.REDIS_DB, maxRetriesPerRequest: 1 });
  const suffix = randomUUID();
  try {
    const owner = await db.user.create({ data: { email: `phase027-pause-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `phase027-pause-${suffix}`, sourceMode: "MIRROR_TO_MINIO" }, select: { id: true } });
    const candidate = { modality: "IMAGE", filename: "paused.png", mimeType: "image/png", path: "fixture/paused.png", sizeBytes: 12, revision: "main", providerFileIdentity: "blob-paused", downloadUrl: "http://fixture.invalid/object" } as const;

    await redis.set(ASSET_WRITE_QUIESCENCE_REDIS_KEY, "1");
    await assert.rejects(
      () => upsertMirroredRepositoryAsset({
        db, datasetId: dataset.id, uploadedById: owner.id, provider: "GITEA", candidate, sourceRootPath: null,
        sourceFingerprint: `phase027-pause-${suffix}`, bucket: "phase027-test", objectKey: `repository-imports/${dataset.id}/paused`,
      }),
      AssetWritesQuiescedError,
    );
    assert.equal(await db.asset.count({ where: { datasetId: dataset.id, sourceFingerprint: `phase027-pause-${suffix}` } }), 0, "no Asset row must exist after a paused attempt");

    await redis.del(ASSET_WRITE_QUIESCENCE_REDIS_KEY);
    const created = await upsertMirroredRepositoryAsset({
      db, datasetId: dataset.id, uploadedById: owner.id, provider: "GITEA", candidate, sourceRootPath: null,
      sourceFingerprint: `phase027-pause-${suffix}`, bucket: "phase027-test", objectKey: `repository-imports/${dataset.id}/paused`,
    });
    assert.ok(created.id, "resumed write succeeds and creates the Asset");
    assert.equal(await db.asset.count({ where: { datasetId: dataset.id, sourceFingerprint: `phase027-pause-${suffix}` } }), 1);
    // specs/027-coco-dataset-export §10 EXPAND-2: a new Asset receives a
    // canonical, non-null relativePath -- proven, not assumed.
    const stored = await db.asset.findUniqueOrThrow({ where: { id: created.id }, select: { relativePath: true } });
    assert.equal(stored.relativePath, "fixture/paused.png");

    await db.dataset.delete({ where: { id: dataset.id } });
    await db.user.delete({ where: { id: owner.id } });
  } finally {
    await redis.del(ASSET_WRITE_QUIESCENCE_REDIS_KEY).catch(() => undefined);
    redis.disconnect();
    await db.$disconnect();
  }
});

test("each modality reconciles to exactly one matching child row", { skip: enabled ? false : "database unavailable" }, async () => {
  const db = createWorkerDatabase(getWorkerConfig());
  const suffix = randomUUID();
  try {
    const owner = await db.user.create({ data: { email: `phase016-modalities-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `phase016-modalities-${suffix}`, sourceMode: "MIRROR_TO_MINIO" }, select: { id: true } });
    const cases = [
      ["IMAGE", "sample.png", "image/png", "imageAsset"],
      ["VIDEO", "sample.mp4", "video/mp4", "videoAsset"],
      ["TEXT", "sample.txt", "text/plain", "textAsset"],
      ["AUDIO", "sample.mp3", "audio/mpeg", "audioAsset"],
    ] as const;
    for (const [modality, filename, mimeType, expected] of cases) {
      const fingerprint = `phase016-${suffix}-${modality}`;
      const asset = await upsertMirroredRepositoryAsset({
        db, datasetId: dataset.id, uploadedById: owner.id, provider: "GITEA", sourceRootPath: null,
        candidate: { modality, filename, mimeType, path: `fixture/${filename}`, sizeBytes: 12, revision: "main", providerFileIdentity: `blob-${modality}`, downloadUrl: "http://fixture.invalid/object" },
        sourceFingerprint: fingerprint, bucket: "phase016-test", objectKey: `repository-imports/${dataset.id}/${modality.toLowerCase()}`,
      });
      await upsertMirroredRepositoryAsset({
        db, datasetId: dataset.id, uploadedById: owner.id, provider: "GITEA", sourceRootPath: null,
        candidate: { modality, filename, mimeType, path: `fixture/${filename}`, sizeBytes: 12, revision: "main", providerFileIdentity: `blob-${modality}`, downloadUrl: "http://fixture.invalid/object" },
        sourceFingerprint: fingerprint, bucket: "phase016-test", objectKey: `repository-imports/${dataset.id}/${modality.toLowerCase()}`,
      });
      const stored = await db.asset.findUniqueOrThrow({ where: { id: asset.id }, include: { imageAsset: true, videoAsset: true, textAsset: true, audioAsset: true } });
      assert.equal(stored.modality, modality);
      assert.ok(stored[expected]);
      assert.equal([stored.imageAsset, stored.videoAsset, stored.textAsset, stored.audioAsset].filter(Boolean).length, 1);
      assert.equal(await db.asset.count({ where: { datasetId: dataset.id, sourceFingerprint: fingerprint } }), 1);
      assert.equal(stored.relativePath, `fixture/${filename}`);
    }
    await db.dataset.delete({ where: { id: dataset.id } });
    await db.user.delete({ where: { id: owner.id } });
  } finally { await db.$disconnect(); }
});
