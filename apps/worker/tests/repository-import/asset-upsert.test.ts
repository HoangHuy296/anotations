import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getWorkerConfig } from "../../src/config.js";
import { upsertMirroredRepositoryAsset } from "../../src/jobs/repository-asset-upsert.js";
import { createWorkerDatabase } from "../../src/providers/db.js";

const enabled = Boolean(process.env.DATABASE_URL);

test("each modality reconciles to exactly one matching child row", { skip: enabled ? false : "database unavailable" }, async () => {
  const db = createWorkerDatabase(getWorkerConfig());
  const suffix = randomUUID();
  try {
    const owner = await db.user.create({ data: { email: `phase016-modalities-${suffix}@test.invalid`, role: "MANAGER" }, select: { id: true } });
    const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `phase016-modalities-${suffix}`, sourceMode: "MIRROR_TO_MINIO" }, select: { id: true } });
    const cases = [
      ["IMAGE", "sample.png", "image/png", "imageAsset"],
      ["VIDEO", "sample.mp4", "video/mp4", "videoAsset"],
      ["TEXT", "sample.txt", "text/plain", "textDocument"],
      ["AUDIO", "sample.mp3", "audio/mpeg", "audioAsset"],
    ] as const;
    for (const [modality, filename, mimeType, expected] of cases) {
      const fingerprint = `phase016-${suffix}-${modality}`;
      const asset = await upsertMirroredRepositoryAsset({
        db, datasetId: dataset.id, uploadedById: owner.id, provider: "GITEA",
        candidate: { modality, filename, mimeType, path: `fixture/${filename}`, sizeBytes: 12, revision: "main", providerFileIdentity: `blob-${modality}`, downloadUrl: "http://fixture.invalid/object" },
        sourceFingerprint: fingerprint, bucket: "phase016-test", objectKey: `repository-imports/${dataset.id}/${modality.toLowerCase()}`,
      });
      await upsertMirroredRepositoryAsset({
        db, datasetId: dataset.id, uploadedById: owner.id, provider: "GITEA",
        candidate: { modality, filename, mimeType, path: `fixture/${filename}`, sizeBytes: 12, revision: "main", providerFileIdentity: `blob-${modality}`, downloadUrl: "http://fixture.invalid/object" },
        sourceFingerprint: fingerprint, bucket: "phase016-test", objectKey: `repository-imports/${dataset.id}/${modality.toLowerCase()}`,
      });
      const stored = await db.asset.findUniqueOrThrow({ where: { id: asset.id }, include: { imageAsset: true, videoAsset: true, textDocument: true, audioAsset: true } });
      assert.equal(stored.modality, modality);
      assert.ok(stored[expected]);
      assert.equal([stored.imageAsset, stored.videoAsset, stored.textDocument, stored.audioAsset].filter(Boolean).length, 1);
      assert.equal(await db.asset.count({ where: { datasetId: dataset.id, sourceFingerprint: fingerprint } }), 1);
    }
    await db.dataset.delete({ where: { id: dataset.id } });
    await db.user.delete({ where: { id: owner.id } });
  } finally { await db.$disconnect(); }
});
