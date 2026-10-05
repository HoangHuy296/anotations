import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { Redis } from "ioredis";

import { Modality, StorageProvider } from "@internal/db";
import { readProviderConfig } from "@annotationplatform/domain";
import { ASSET_WRITE_QUIESCENCE_REDIS_KEY, AssetWritesQuiescedError } from "@annotationplatform/domain/asset-write-quiescence";

import { db } from "@/lib/db";
import { publishUploadedAsset } from "@/lib/asset-upload";
import type { UploadCapability } from "@/lib/upload-capability";
import type { VerifiedUpload } from "@/lib/upload-verification";

/**
 * specs/027-coco-dataset-export §10 -- permanent regression coverage for the
 * one reachable web-side writer boundary (§10a's inventory), proving the
 * actual guarded function, not just the standalone guard in isolation
 * (guard.test.ts). No MinIO/HTTP dependency: publishUploadedAsset itself is
 * pure DB (its one MinIO-adjacent check, findPublishedObject, is a plain
 * Asset lookup by storageKey) -- fake but well-typed capability/verified
 * inputs are enough to exercise the real create path this session wired.
 */
const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);
const connection = hasIntegrationDatabase ? new Redis({
  host: readProviderConfig().REDIS_HOST,
  port: readProviderConfig().REDIS_PORT,
  password: readProviderConfig().REDIS_PASSWORD,
  db: readProviderConfig().REDIS_DB,
  maxRetriesPerRequest: 1,
}) : undefined;

let ownerId = "";
let datasetId = "";

before(async () => {
  if (!hasIntegrationDatabase) return;
  const owner = await db.user.create({ data: { email: `writer-boundary-${Date.now()}@test.invalid`, role: "MANAGER" }, select: { id: true } });
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: `writer-boundary-${Date.now()}` }, select: { id: true } });
  ownerId = owner.id;
  datasetId = dataset.id;
});

after(async () => {
  await connection?.del(ASSET_WRITE_QUIESCENCE_REDIS_KEY);
  if (hasIntegrationDatabase && ownerId) {
    await db.asset.deleteMany({ where: { datasetId } });
    await db.dataset.deleteMany({ where: { id: datasetId } });
    await db.user.deleteMany({ where: { id: ownerId } });
  }
  await connection?.quit().catch(() => undefined);
});

function capability(objectKey: string): UploadCapability {
  return {
    purpose: "upload", actorId: ownerId, datasetId, objectKey, filename: "guarded.png",
    candidateContentType: "image/png", sizeBytes: 24, nonce: randomBytes(8).toString("hex"), expiresAt: Date.now() + 60_000,
  };
}
const verified: VerifiedUpload = { modality: Modality.IMAGE, mimeType: "image/png", sizeBytes: BigInt(24), sourceFingerprint: `writer-boundary-${randomUUID()}` };

test("PAUSE ON prevents publishUploadedAsset (the web writer boundary) from creating an Asset", { skip: !hasIntegrationDatabase }, async () => {
  await connection!.set(ASSET_WRITE_QUIESCENCE_REDIS_KEY, "1");
  const objectKey = `direct-uploads/${datasetId}/paused-${randomUUID()}`;
  await assert.rejects(
    () => publishUploadedAsset({ capability: capability(objectKey), verified, bucket: "annotation-assets" }),
    AssetWritesQuiescedError,
  );
  const count = await db.asset.count({ where: { storageKey: objectKey } });
  assert.equal(count, 0, "no Asset row must exist after a paused attempt");
});

test("PAUSE OFF restores publishUploadedAsset -- the exact same call now succeeds", { skip: !hasIntegrationDatabase }, async () => {
  await connection!.del(ASSET_WRITE_QUIESCENCE_REDIS_KEY);
  const objectKey = `direct-uploads/${datasetId}/resumed-${randomUUID()}`;
  const published = await publishUploadedAsset({ capability: capability(objectKey), verified, bucket: "annotation-assets" });
  assert.equal(published.replayed, false);
  const row = await db.asset.findUnique({ where: { id: published.asset.id }, select: { storageKey: true, storageProvider: true, datasetId: true, relativePath: true } });
  assert.equal(row?.storageKey, objectKey);
  assert.equal(row?.storageProvider, StorageProvider.MINIO);
  assert.equal(row?.datasetId, datasetId);
  // specs/027-coco-dataset-export §10 EXPAND-2: a new Asset receives a
  // canonical, non-null relativePath -- proven, not assumed.
  assert.equal(row?.relativePath, "guarded.png");
});
