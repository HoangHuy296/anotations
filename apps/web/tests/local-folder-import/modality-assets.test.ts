import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { Modality } from "@internal/db";

import { db } from "@/lib/db";
import { hasImportIntegration } from "./helpers";
import { createLocalImportHttpFixture, type LocalImportHttpFixture, type UploadCapability } from "./http-fixtures";

let fixture: LocalImportHttpFixture | undefined;

before(async () => {
  if (hasImportIntegration) fixture = await createLocalImportHttpFixture(3113);
});
after(async () => fixture?.cleanup());

test("each supported local-folder modality creates exactly its canonical child row and remains idempotent", { skip: !hasImportIntegration }, async () => {
  const app = fixture!;
  const cases = [
    { contentType: "image/png", filename: "image.png", modality: Modality.IMAGE, child: "imageAsset" },
    { contentType: "video/mp4", filename: "video.mp4", modality: Modality.VIDEO, child: "videoAsset" },
    { contentType: "text/plain", filename: "notes.txt", modality: Modality.TEXT, child: "textDocument" },
    { contentType: "audio/wav", filename: "audio.wav", modality: Modality.AUDIO, child: "audioAsset" },
  ] as const;
  const preparation = await app.start({ items: cases.map(({ contentType, filename }) => ({ logicalPath: `mixed/${filename}`, contentType })) });

  for (const [index, expected] of cases.entries()) {
    const item = preparation.items[index]!;
    const capabilityResponse = await app.capabilities(preparation.id, [item.id]);
    assert.equal(capabilityResponse.status, 200);
    const capability = (await capabilityResponse.json() as { data: { capabilities: UploadCapability[] } }).data.capabilities[0]!;
    assert.ok((await app.postUpload(capability, expected.contentType, expected.filename)).ok);
    const completion = await app.complete(preparation.id, item.id, capability.fileId);
    assert.equal(completion.status, 201);
    const assetId = (await completion.json() as { data: { assetId: string } }).data.assetId;
    const asset = await db.asset.findUniqueOrThrow({
      where: { id: assetId }, include: { imageAsset: true, videoAsset: true, textDocument: true, audioAsset: true },
    });
    assert.equal(asset.modality, expected.modality);
    assert.ok(asset[expected.child]);
    for (const child of ["imageAsset", "videoAsset", "textDocument", "audioAsset"] as const) {
      if (child !== expected.child) assert.equal(asset[child], null, `${expected.modality} must not create ${child}`);
    }
    const replay = await app.complete(preparation.id, item.id, capability.fileId);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { data: { replayed: boolean } }).data.replayed, true);
    const childCount = expected.child === "imageAsset"
      ? await db.imageAsset.count({ where: { assetId } })
      : expected.child === "videoAsset"
        ? await db.videoAsset.count({ where: { assetId } })
        : expected.child === "textDocument"
          ? await db.textDocument.count({ where: { assetId } })
          : await db.audioAsset.count({ where: { assetId } });
    assert.equal(childCount, 1);
  }

  const dataset = await db.dataset.findUniqueOrThrow({ where: { id: preparation.datasetId }, select: { primaryModality: true } });
  assert.equal(dataset.primaryModality, Modality.IMAGE, "first published Asset is only the UI default");
  assert.equal(await db.asset.count({ where: { datasetId: preparation.datasetId } }), cases.length);
  // MULTI_MODAL is a derived Dataset property, not an Asset.modality enum
  // value. The per-asset assertions above prove this mixed Dataset stores
  // only concrete IMAGE/VIDEO/TEXT/AUDIO modalities.
});
