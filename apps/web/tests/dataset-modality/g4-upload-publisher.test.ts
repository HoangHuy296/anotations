import "../../../../scripts/db-safety/test-entry.cjs"; // G1: only run against a registered disposable database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { db } from "@/lib/db";
import { publishUploadedAsset, UploadPublicationFailure } from "@/lib/asset-upload";

const enabled = Boolean(process.env.DATABASE_URL);
test("G4 direct/prepared upload publisher validates Dataset modality on publish and replay", { skip: enabled ? false : "database unavailable" }, async () => {
  const suffix = randomUUID();
  try {
    const owner = await db.user.findUniqueOrThrow({ where: { id: "g2-owner" }, select: { id: true } });
    const dataset = await db.dataset.create({ data: { id: `g4-web-${suffix}`, ownerId: owner.id, name: "G4 web upload", modality: "IMAGE", primaryModality: "IMAGE", modalityResolverSubject: owner.id }, select: { id: true } });
    const capability = { purpose: "upload" as const, actorId: owner.id, datasetId: dataset.id, objectKey: `direct-uploads/${dataset.id}/${suffix}.png`, filename: "scene.png", candidateContentType: "image/png", sizeBytes: 16, nonce: suffix, expiresAt: Math.floor(Date.now() / 1000) + 300 };
    const verified = { modality: "IMAGE" as const, mimeType: "image/png", sizeBytes: BigInt(16), sourceFingerprint: `g4-web:${suffix}:image`, width: 2, height: 2 };
    const first = await publishUploadedAsset({ capability, verified, bucket: "g4-fixture" });
    const replay = await publishUploadedAsset({ capability, verified, bucket: "g4-fixture" });
    assert.equal(first.asset.id, replay.asset.id);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(await db.asset.count({ where: { datasetId: dataset.id } }), 1);
    await assert.rejects(publishUploadedAsset({ capability: { ...capability, objectKey: `${capability.objectKey}.wrong`, filename: "wrong.wav" }, verified: { ...verified, modality: "AUDIO", mimeType: "audio/wav", sourceFingerprint: `g4-web:${suffix}:audio` }, bucket: "g4-fixture" }), (error) => error instanceof UploadPublicationFailure && error.code === "ASSET_MODALITY_MISMATCH");
    assert.equal(await db.asset.count({ where: { datasetId: dataset.id } }), 1);
    await db.dataset.delete({ where: { id: dataset.id } });
  } finally {
    await db.$disconnect();
  }
});
