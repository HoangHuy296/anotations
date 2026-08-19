/**
 * OpenAPI contract check for the Assets tag (specs/api/openapi.yaml,
 * schemas/assets.yaml). Runs against an already-running web service over
 * real HTTP -- set OPENAPI_CONTRACT_TESTS=1 (and, if needed,
 * OPENAPI_CONTRACT_BASE_URL) to enable.
 *
 * This suite checks documented shape/status conformance for the presigned
 * upload -> real MinIO PUT -> complete-upload round trip, view-url, and the
 * dataset asset list. It intentionally does not re-cover the deep
 * capability-forgery/tamper edge cases already in tests/direct-upload.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

import { UserRole } from "@internal/db";

import {
  assertExactKeys,
  cleanupContractFixture,
  contractFetch,
  contractLogin,
  contractTestsEnabled as enabled,
  createContractAsset,
  createContractDataset,
  createContractUser,
} from "./helpers";

const skip = enabled ? false : "Set OPENAPI_CONTRACT_TESTS=1 against a running web service (see tests/openapi-contract/helpers.ts).";
const PRESIGNED_UPLOAD_KEYS = ["uploadUrl", "method", "formFields", "fileId", "expiresInSeconds"] as const;
const ASSET_KEYS = [
  "id", "datasetId", "modality", "filename", "originalFilename", "mimeType", "sizeBytes",
  "width", "height", "durationMs", "textLength", "status", "batchIndex", "orderIndex",
  "description", "revision", "createdAt", "updatedAt",
] as const;

function pngFixture() {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(1, 16);
  bytes.writeUInt32BE(1, 20);
  return bytes;
}

const userIds: string[] = [];
const datasetIds: string[] = [];

after(async () => {
  if (userIds.length || datasetIds.length) await cleanupContractFixture(userIds, datasetIds);
});

test("POST /api/assets/presigned-upload requires authentication and returns the documented capability shape", { skip }, async () => {
  const unauth = await contractFetch("/api/assets/presigned-upload", { method: "POST", body: JSON.stringify({ datasetId: "irrelevant", filename: "x.png", contentType: "image/png", sizeBytes: 10 }) });
  assert.equal(unauth.status, 401);

  const owner = await createContractUser(UserRole.MANAGER);
  const dataset = await createContractDataset(owner.id);
  userIds.push(owner.id); datasetIds.push(dataset.id);
  const cookie = await contractLogin(owner.email);

  const response = await contractFetch("/api/assets/presigned-upload", {
    method: "POST", cookie,
    body: JSON.stringify({ datasetId: dataset.id, filename: "contract.png", contentType: "image/png", sizeBytes: pngFixture().length }),
  });
  assert.equal(response.status, 201);
  const body = await response.json() as { data: Record<string, unknown> };
  assertExactKeys(body.data, PRESIGNED_UPLOAD_KEYS, "presigned-upload response");
  assert.equal(body.data.method, "POST");
  assert.equal(typeof body.data.uploadUrl, "string");
  assert.equal(typeof body.data.fileId, "string");
});

test("full upload round trip: presigned-upload -> real MinIO PUT -> complete-upload returns the documented Asset DTO and replays idempotently", { skip }, async () => {
  const owner = await createContractUser(UserRole.MANAGER);
  const dataset = await createContractDataset(owner.id);
  userIds.push(owner.id); datasetIds.push(dataset.id);
  const cookie = await contractLogin(owner.email);

  const presign = await contractFetch("/api/assets/presigned-upload", {
    method: "POST", cookie,
    body: JSON.stringify({ datasetId: dataset.id, filename: "roundtrip.png", contentType: "image/png", sizeBytes: pngFixture().length }),
  });
  const { uploadUrl, formFields, fileId } = (await presign.json() as { data: { uploadUrl: string; formFields: Record<string, string>; fileId: string } }).data;

  const form = new FormData();
  for (const [key, value] of Object.entries(formFields)) form.append(key, value);
  form.append("file", new Blob([pngFixture()], { type: "image/png" }), "roundtrip.png");
  const minioPut = await fetch(uploadUrl, { method: "POST", body: form });
  assert.ok(minioPut.status >= 200 && minioPut.status < 300, `MinIO upload failed: ${minioPut.status}`);

  const first = await contractFetch("/api/assets/complete-upload", { method: "POST", cookie, body: JSON.stringify({ fileId }) });
  assert.equal(first.status, 201);
  const firstBody = await first.json() as { data: { asset: Record<string, unknown>; replayed: boolean } };
  assertExactKeys(firstBody.data.asset, ASSET_KEYS, "complete-upload asset");
  assert.equal(firstBody.data.replayed, false);
  assert.equal(typeof firstBody.data.asset.sizeBytes, "string", "sizeBytes must serialize as a decimal string, not a number");
  assert.equal(firstBody.data.asset.status, "READY");

  const second = await contractFetch("/api/assets/complete-upload", { method: "POST", cookie, body: JSON.stringify({ fileId }) });
  assert.equal(second.status, 200);
  const secondBody = await second.json() as { data: { asset: { id: string }; replayed: boolean } };
  assert.equal(secondBody.data.replayed, true);
  assert.equal(secondBody.data.asset.id, firstBody.data.asset.id);
});

test("GET /api/assets/{assetId}/view-url: 409 ASSET_UNAVAILABLE for an Asset row with no stored object, 404 for an outsider and for an unknown id", { skip }, async () => {
  const owner = await createContractUser(UserRole.MANAGER);
  const outsider = await createContractUser(UserRole.MANAGER);
  const dataset = await createContractDataset(owner.id);
  userIds.push(owner.id, outsider.id); datasetIds.push(dataset.id);
  const ownerCookie = await contractLogin(owner.email);
  const outsiderCookie = await contractLogin(outsider.email);
  const asset = await createContractAsset(dataset.id);

  const unavailable = await contractFetch(`/api/assets/${asset.id}/view-url`, { cookie: ownerCookie });
  assert.equal(unavailable.status, 409);
  const unavailableBody = await unavailable.json() as { error: { code: string } };
  assert.equal(unavailableBody.error.code, "ASSET_UNAVAILABLE");

  const concealed = await contractFetch(`/api/assets/${asset.id}/view-url`, { cookie: outsiderCookie });
  assert.equal(concealed.status, 404, "an Asset outside the actor's Dataset scope is concealed as not-found");
  const concealedBody = await concealed.json() as { error: { code: string } };
  assert.equal(concealedBody.error.code, "GITEA_NOT_FOUND");

  const unknown = await contractFetch("/api/assets/definitely-not-a-real-asset-id/view-url", { cookie: ownerCookie });
  assert.equal(unknown.status, 404);
});

test("GET /api/datasets/{datasetId}/assets returns the documented cursor-pagination envelope", { skip }, async () => {
  const owner = await createContractUser(UserRole.MANAGER);
  const dataset = await createContractDataset(owner.id);
  userIds.push(owner.id); datasetIds.push(dataset.id);
  const cookie = await contractLogin(owner.email);

  const response = await contractFetch(`/api/datasets/${dataset.id}/assets?limit=5`, { cookie });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { items: unknown[]; page: Record<string, unknown> } };
  assertExactKeys(body.data, ["items", "page"], "asset list response");
  assertExactKeys(body.data.page, ["limit", "nextCursor", "hasNextPage"], "asset list page");
  assert.equal(body.data.page.limit, 5);
  assert.equal(body.data.page.hasNextPage, false);
  assert.equal(body.data.page.nextCursor, null);
});
