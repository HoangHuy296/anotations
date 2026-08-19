import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { Modality, StorageProvider } from "@internal/db";

import { db } from "@/lib/db";
import { objectExists, hasImportIntegration } from "./helpers";
import { createLocalImportHttpFixture, type LocalImportHttpFixture, type UploadCapability } from "./http-fixtures";

let fixture: LocalImportHttpFixture | undefined;

before(async () => {
  if (hasImportIntegration) fixture = await createLocalImportHttpFixture(3112);
});
after(async () => fixture?.cleanup());

function noSecrets(value: unknown) {
  assert.doesNotMatch(JSON.stringify(value), /(MINIO_(ACCESS|SECRET)_KEY|UPLOAD_CAPABILITY_SECRET|DATABASE_URL|REDIS_PASSWORD|SOURCE_CONNECTION_ENCRYPTION_KEY|stack)/i);
}

test("item capability, MinIO POST, completion, and replay publish one Asset", { skip: !hasImportIntegration }, async () => {
  const app = fixture!;
  const preparation = await app.start({ items: [{ logicalPath: "images/scene.png", contentType: "image/png", body: "png" }] });
  const item = preparation.items[0]!;
  const capabilityResponse = await app.capabilities(preparation.id, [item.id]);
  assert.equal(capabilityResponse.status, 200);
  const capabilityBody = await capabilityResponse.json() as { data: { capabilities: UploadCapability[] } };
  noSecrets(capabilityBody);
  const capability = capabilityBody.data.capabilities[0]!;
  assert.equal(capability.uploadUrl.includes("minio:9000"), false);
  assert.match(capability.uploadUrl, /^http:\/\/localhost:9000\//);
  assert.equal(await db.asset.count({ where: { datasetId: preparation.datasetId } }), 0);

  const upload = await app.postUpload(capability, "image/png", "scene.png");
  assert.ok(upload.ok, "browser-style MinIO POST must succeed");
  const completion = await app.complete(preparation.id, item.id, capability.fileId);
  assert.equal(completion.status, 201);
  const completeBody = await completion.json() as { data: { assetId: string; replayed: boolean } };
  noSecrets(completeBody);
  assert.equal(completeBody.data.replayed, false);
  const asset = await db.asset.findUniqueOrThrow({
    where: { id: completeBody.data.assetId }, include: { imageAsset: true, videoAsset: true, audioAsset: true, textAsset: true },
  });
  assert.equal(asset.storageProvider, StorageProvider.MINIO);
  assert.equal(asset.modality, Modality.IMAGE);
  assert.ok(asset.storageBucket && asset.storageKey && await objectExists(asset.storageKey));
  assert.ok(asset.imageAsset);
  assert.equal(asset.videoAsset, null); assert.equal(asset.audioAsset, null); assert.equal(asset.textAsset, null);

  const replay = await app.complete(preparation.id, item.id, capability.fileId);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { data: { replayed: boolean } }).data.replayed, true);
  assert.equal(await db.asset.count({ where: { datasetId: preparation.datasetId } }), 1);
  assert.equal(await db.imageAsset.count({ where: { assetId: asset.id } }), 1);
});

test("missing object and denied completion do not publish an Asset or child metadata", { skip: !hasImportIntegration }, async () => {
  const app = fixture!;
  const preparation = await app.start({ items: [{ logicalPath: "missing/notes.txt", contentType: "text/plain", body: "text" }] });
  const item = preparation.items[0]!;
  const capability = (await (await app.capabilities(preparation.id, [item.id])).json() as { data: { capabilities: UploadCapability[] } }).data.capabilities[0]!;
  const before = await Promise.all([db.asset.count({ where: { datasetId: preparation.datasetId } }), db.textAsset.count()]);
  const missing = await app.complete(preparation.id, item.id, capability.fileId);
  assert.equal(missing.status, 409);
  noSecrets(await missing.json());
  assert.deepEqual(await Promise.all([db.asset.count({ where: { datasetId: preparation.datasetId } }), db.textAsset.count()]), before);

  const outsider = await app.cookieFor("outsider");
  const denied = await app.complete(preparation.id, item.id, capability.fileId, outsider);
  assert.equal(denied.status, 404);
  noSecrets(await denied.json());
  assert.deepEqual(await Promise.all([db.asset.count({ where: { datasetId: preparation.datasetId } }), db.textAsset.count()]), before);
});

