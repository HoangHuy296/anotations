import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";
import { createPreparedImportUploadCapability, UPLOAD_CAPABILITY_TTL_SECONDS } from "@/lib/upload-capability";
import { hasImportIntegration } from "./helpers";
import { createLocalImportHttpFixture, type LocalImportHttpFixture, type UploadCapability } from "./http-fixtures";

let fixture: LocalImportHttpFixture | undefined;
const forbiddenResponseFields = /(MINIO_(ACCESS|SECRET)_KEY|UPLOAD_CAPABILITY_SECRET|SOURCE_CONNECTION_ENCRYPTION_KEY|DATABASE_URL|REDIS_PASSWORD|tokenEncrypted|stack|endPoint|accessKey|secretKey)/i;

before(async () => {
  if (hasImportIntegration) fixture = await createLocalImportHttpFixture(3115);
});
after(async () => fixture?.cleanup());

async function assertRedacted(response: Response) {
  const text = await response.text();
  assert.doesNotMatch(text, forbiddenResponseFields);
  return text;
}

test("upload-capability responses are narrow, host-reachable, and redacted", { skip: !hasImportIntegration }, async () => {
  const app = fixture!;
  const preparation = await app.start({ items: [{ logicalPath: "security/photo.png", contentType: "image/png" }] });
  const item = preparation.items[0]!;
  const success = await app.capabilities(preparation.id, [item.id]);
  assert.equal(success.status, 200);
  const body = JSON.parse(await assertRedacted(success)) as { data: { capabilities: UploadCapability[] } };
  const capability = body.data.capabilities[0]!;
  assert.match(capability.uploadUrl, /^http:\/\/localhost:9000\//);
  assert.equal(capability.uploadUrl.includes("minio:9000"), false);
  assert.equal("objectKey" in capability, false);
  assert.equal("bucket" in capability, false);
  assert.equal("storageKey" in capability, false);
  assert.ok(capability.formFields.key, "signed POST form field is the allowed narrow provider exception");

  const invalidRequest = await app.capabilities(preparation.id, []);
  assert.equal(invalidRequest.status, 400);
  await assertRedacted(invalidRequest);
  const unauthorized = await app.capabilities(preparation.id, [item.id], await app.cookieFor("outsider"));
  assert.equal(unauthorized.status, 404);
  await assertRedacted(unauthorized);
});

test("tampered capability, item mismatch, and unauthenticated responses are rejected without publication", { skip: !hasImportIntegration }, async () => {
  const app = fixture!;
  const preparation = await app.start({ items: [
    { logicalPath: "security/one.png", contentType: "image/png" },
    { logicalPath: "security/two.png", contentType: "image/png" },
  ] });
  const [first, second] = preparation.items;
  const capability = (await (await app.capabilities(preparation.id, [first!.id])).json() as { data: { capabilities: UploadCapability[] } }).data.capabilities[0]!;
  const before = await db.asset.count({ where: { datasetId: preparation.datasetId } });
  const [iv, ciphertext, tag] = capability.fileId.split(".");
  const changed = ciphertext![0] === "A" ? "B" : "A";
  const tampered = `${iv}.${changed}${ciphertext!.slice(1)}.${tag}`;
  const tamperedResponse = await app.complete(preparation.id, first!.id, tampered);
  assert.equal(tamperedResponse.status, 400);
  await assertRedacted(tamperedResponse);
  const wrongItem = await app.complete(preparation.id, second!.id, capability.fileId);
  assert.equal(wrongItem.status, 400);
  await assertRedacted(wrongItem);
  const unauthenticated = await fetch(`${app.baseUrl}/api/imports/${preparation.id}/items/${first!.id}/complete`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileId: capability.fileId }),
  });
  assert.equal(unauthenticated.status, 401);
  await assertRedacted(unauthenticated);
  assert.equal(await db.asset.count({ where: { datasetId: preparation.datasetId } }), before);

  const preparedItem = await db.preparedImportItem.findUniqueOrThrow({ where: { id: first!.id }, select: { filename: true, mimeType: true, sizeBytes: true, storageKey: true } });
  const { config } = getDirectUploadProviders();
  const expired = createPreparedImportUploadCapability(config, {
    actorId: app.users.manager.id, datasetId: preparation.datasetId, filename: preparedItem.filename,
    candidateContentType: preparedItem.mimeType, sizeBytes: Number(preparedItem.sizeBytes), objectKey: preparedItem.storageKey,
    preparedImportId: preparation.id, preparedImportItemId: first!.id,
    nowSeconds: Math.floor(Date.now() / 1000) - UPLOAD_CAPABILITY_TTL_SECONDS - 1,
  });
  const expiredResponse = await app.complete(preparation.id, first!.id, expired.token);
  assert.equal(expiredResponse.status, 400);
  await assertRedacted(expiredResponse);
  assert.equal(await db.asset.count({ where: { datasetId: preparation.datasetId } }), before);

  assert.ok((await app.postUpload(capability, "image/png", "one.png")).ok);
  const completed = await app.complete(preparation.id, first!.id, capability.fileId);
  assert.equal(completed.status, 201);
  const assetId = (await completed.json() as { data: { assetId: string } }).data.assetId;
  const view = await fetch(`${app.baseUrl}/api/assets/${assetId}/view-url`, { headers: { Cookie: await app.cookieFor("manager") } });
  assert.equal(view.status, 200);
  await assertRedacted(view);
  const deniedView = await fetch(`${app.baseUrl}/api/assets/${assetId}/view-url`, { headers: { Cookie: await app.cookieFor("outsider") } });
  assert.equal(deniedView.status, 404);
  await assertRedacted(deniedView);
});
