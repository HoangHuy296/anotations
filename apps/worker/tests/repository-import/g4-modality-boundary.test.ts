import "../../../../scripts/db-safety/test-entry.cjs"; // G1: fixtures are allowed only on the receipt-pinned disposable DB.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { upsertMirroredRepositoryAsset } from "../../src/jobs/repository-asset-upsert.js";
import { createWorkerDatabase } from "../../src/providers/db.js";

const enabled = Boolean(process.env.DATABASE_URL);
test("G4 repository writer validates Dataset modality, replays exactly, and DB trigger rejects bypasses", { skip: enabled ? false : "database unavailable" }, async () => {
  const db = createWorkerDatabase(getWorkerConfig());
  const suffix = randomUUID();
  try {
    const owner = await db.user.findUniqueOrThrow({ where: { id: "g2-owner" }, select: { id: true } });
    const image = await db.dataset.create({ data: { id: `g4-image-${suffix}`, ownerId: owner.id, name: "G4 image", sourceMode: "MIRROR_TO_MINIO", modality: "IMAGE", primaryModality: "IMAGE", modalityResolverSubject: owner.id }, select: { id: true } });
    const audio = await db.dataset.create({ data: { id: `g4-audio-${suffix}`, ownerId: owner.id, name: "G4 audio", sourceMode: "MIRROR_TO_MINIO", modality: "AUDIO", primaryModality: "AUDIO", modalityResolverSubject: owner.id }, select: { id: true } });
    const candidate = { modality: "IMAGE", filename: "one.png", mimeType: "image/png", path: "g4/one.png", sizeBytes: 16, revision: "r1", providerFileIdentity: "blob-g4-one", downloadUrl: "http://fixture.invalid/ignored" } as const;
    const base = { db, datasetId: image.id, uploadedById: owner.id, provider: "GITEA" as const, candidate, verifiedModality: "IMAGE" as const, sourceFingerprint: `g4:${suffix}:one`, bucket: "g4-fixture", objectKey: `g4/${suffix}/one`, sourceRootPath: null };

    const [first, concurrentReplay] = await Promise.all([upsertMirroredRepositoryAsset(base), upsertMirroredRepositoryAsset(base)]);
    assert.equal(first.id, concurrentReplay.id, "concurrent duplicate delivery resolves to one stable Asset");
    assert.equal(await db.asset.count({ where: { datasetId: image.id, sourceFingerprint: base.sourceFingerprint } }), 1);
    assert.equal(first.modality, "IMAGE");

    await assert.rejects(upsertMirroredRepositoryAsset({ ...base, verifiedModality: "AUDIO", objectKey: `g4/${suffix}/wrong` }), /ASSET_MODALITY_MISMATCH/);
    await assert.rejects(upsertMirroredRepositoryAsset({ ...base, datasetId: audio.id, verifiedModality: "IMAGE", sourceFingerprint: `g4:${suffix}:wrong-parent` }), /ASSET_MODALITY_MISMATCH/);
    await assert.rejects(upsertMirroredRepositoryAsset({ ...base, sourceFingerprint: `g4:${suffix}:one`, candidate: { ...candidate, revision: "r2" } }), /SOURCE_RECONCILIATION_CONFLICT/);

    // Bypass application helpers: the PostgreSQL trigger remains authoritative.
    await assert.rejects(db.asset.create({ data: { id: `g4-db-bypass-${suffix}`, datasetId: image.id, uploadedById: owner.id, modality: "AUDIO", filename: "spoof.wav", relativePath: "spoof.wav", mimeType: "audio/wav", sourceFingerprint: `g4:${suffix}:db-bypass` }, select: { id: true } }));
    await assert.rejects(db.asset.create({ data: { id: `g4-unresolved-${suffix}`, datasetId: "g2-mixed", uploadedById: owner.id, modality: "IMAGE", filename: "legacy.png", relativePath: "legacy.png", mimeType: "image/png", sourceFingerprint: `g4:${suffix}:unresolved` }, select: { id: true } }));
    const concurrentFingerprint = `g4:${suffix}:race`;
    const concurrentValid = { ...base, sourceFingerprint: concurrentFingerprint, objectKey: `g4/${suffix}/race` };
    const race = await Promise.allSettled([
      upsertMirroredRepositoryAsset(concurrentValid),
      db.asset.create({ data: { id: `g4-race-bypass-${suffix}`, datasetId: image.id, uploadedById: owner.id, modality: "AUDIO", filename: "race.wav", relativePath: "race.wav", mimeType: "audio/wav", sourceFingerprint: `g4:${suffix}:race-bypass` }, select: { id: true } }),
    ]);
    assert.equal(race[0]?.status, "fulfilled");
    assert.equal(race[1]?.status, "rejected", "database rejects a concurrent incompatible writer");
    await assert.rejects(db.asset.update({ where: { id: first.id }, data: { modality: "AUDIO" }, select: { id: true } }));
    await assert.rejects(db.asset.update({ where: { id: first.id }, data: { datasetId: audio.id }, select: { id: true } }));
    await assert.rejects(db.dataset.update({ where: { id: image.id }, data: { modality: "VIDEO" }, select: { id: true } }));
    const stillOne = await db.asset.findUniqueOrThrow({ where: { id: first.id }, select: { datasetId: true, modality: true } });
    assert.deepEqual(stillOne, { datasetId: image.id, modality: "IMAGE" });
    assert.equal(await db.asset.count({ where: { datasetId: image.id } }), 2);
    assert.equal(await db.asset.count({ where: { datasetId: audio.id } }), 0);

    await db.dataset.deleteMany({ where: { id: { in: [image.id, audio.id] } } });
  } finally {
    await db.$disconnect();
  }
});
