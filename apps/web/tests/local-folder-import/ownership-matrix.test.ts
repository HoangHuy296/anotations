import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { DatasetMemberRole } from "@internal/db";

import { db } from "@/lib/db";
import { hasImportIntegration } from "./helpers";
import { addDatasetMember, createLocalImportHttpFixture, type LocalImportHttpFixture, type UploadCapability } from "./http-fixtures";

let fixture: LocalImportHttpFixture | undefined;

before(async () => {
  if (hasImportIntegration) fixture = await createLocalImportHttpFixture(3114);
});
after(async () => fixture?.cleanup());

async function errorCode(response: Response) {
  return (await response.json() as { error: { code: string } }).error.code;
}

test("HTTP role matrix follows the current import policy and denials have no durable side effect", { skip: !hasImportIntegration }, async () => {
  const app = fixture!;
  const manager = await app.cookieFor("manager");
  const labeler = await app.cookieFor("labeler");
  const reviewer = await app.cookieFor("reviewer");
  const outsider = await app.cookieFor("outsider");
  const admin = await app.cookieFor("admin");

  const preparation = await app.start({ items: [{ logicalPath: "owned/photo.png", contentType: "image/png" }] });
  await addDatasetMember(preparation.datasetId, app.users.labeler.id, DatasetMemberRole.LABELER);
  await addDatasetMember(preparation.datasetId, app.users.reviewer.id, DatasetMemberRole.REVIEWER);
  const item = preparation.items[0]!;
  const before = await Promise.all([
    db.asset.count({ where: { datasetId: preparation.datasetId } }),
    db.preparedImportItem.count({ where: { preparedImportId: preparation.id, assetId: { not: null } } }),
    db.jobEvent.count({ where: { jobId: preparation.jobId } }),
    db.job.count(),
  ]);

  assert.equal((await app.capabilities(preparation.id, [item.id], manager)).status, 200, "owner manager may create a capability");
  for (const cookie of [labeler, reviewer, outsider, admin]) {
    const denied = await app.capabilities(preparation.id, [item.id], cookie);
    assert.equal(denied.status, 404, "non-creator or non-member must be concealed");
    assert.equal(await errorCode(denied), "JOB_NOT_FOUND");
  }
  assert.deepEqual(await Promise.all([
    db.asset.count({ where: { datasetId: preparation.datasetId } }),
    db.preparedImportItem.count({ where: { preparedImportId: preparation.id, assetId: { not: null } } }),
    db.jobEvent.count({ where: { jobId: preparation.jobId } }),
    db.job.count(),
  ]), before);

  for (const cookie of [labeler, reviewer]) {
    const deniedStart = await fetch(`${app.baseUrl}/api/imports/local-folder`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "denied", idempotencyKey: randomBytes(20).toString("hex"), items: [{ logicalPath: "x.txt", contentType: "text/plain", sizeBytes: 1, fingerprint: "a".repeat(64) }] }),
    });
    assert.equal(deniedStart.status, 403);
    assert.equal(await errorCode(deniedStart), "FORBIDDEN");
  }
  const adminStart = await fetch(`${app.baseUrl}/api/imports/local-folder`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: admin },
    body: JSON.stringify({ name: "admin", idempotencyKey: randomBytes(20).toString("hex"), items: [{ logicalPath: "admin.txt", contentType: "text/plain", sizeBytes: 1, fingerprint: "b".repeat(64) }] }),
  });
  assert.ok([201, 202].includes(adminStart.status), "system admin may start its own import");
});

test("capabilities cannot cross preparation, Dataset, object, or view boundaries", { skip: !hasImportIntegration }, async () => {
  const app = fixture!;
  const first = await app.start({ items: [{ logicalPath: "one/photo.png", contentType: "image/png" }] });
  const second = await app.start({ items: [{ logicalPath: "two/photo.png", contentType: "image/png" }] });
  const firstItem = first.items[0]!; const secondItem = second.items[0]!;
  const firstCapability = (await (await app.capabilities(first.id, [firstItem.id])).json() as { data: { capabilities: UploadCapability[] } }).data.capabilities[0]!;
  const initialAssets = await db.asset.count({ where: { datasetId: second.datasetId } });
  const crossed = await app.complete(second.id, secondItem.id, firstCapability.fileId);
  assert.equal(crossed.status, 400, "capability is bound to exactly one prepared item and Dataset");
  assert.equal(await errorCode(crossed), "INVALID_REQUEST");
  assert.equal(await db.asset.count({ where: { datasetId: second.datasetId } }), initialAssets);

  assert.ok((await app.postUpload(firstCapability, "image/png", "photo.png")).ok);
  const completed = await app.complete(first.id, firstItem.id, firstCapability.fileId);
  assert.equal(completed.status, 201);
  const assetId = (await completed.json() as { data: { assetId: string } }).data.assetId;
  const asset = await db.asset.findUniqueOrThrow({ where: { id: assetId }, select: { datasetId: true, storageKey: true, imageAsset: { select: { id: true } } } });
  assert.equal(asset.datasetId, first.datasetId);
  assert.match(asset.storageKey ?? "", new RegExp(`^prepared-imports/${first.id}/`));
  assert.ok(asset.imageAsset);
  const deniedView = await fetch(`${app.baseUrl}/api/assets/${assetId}/view-url`, { headers: { Cookie: await app.cookieFor("outsider") } });
  assert.equal(deniedView.status, 404);
  assert.equal(await errorCode(deniedView), "GITEA_NOT_FOUND");
});

