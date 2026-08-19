/**
 * OpenAPI contract check for the Annotations tag (specs/api/openapi.yaml,
 * schemas/annotations.yaml), IMAGE batch endpoint only. Runs against an
 * already-running web service over real HTTP -- set OPENAPI_CONTRACT_TESTS=1
 * (and, if needed, OPENAPI_CONTRACT_BASE_URL) to enable.
 *
 * This is a thin conformance pass (status, envelope, exact field set) on top
 * of an already deep business-logic suite (tests/annotation-api); it
 * deliberately does not re-cover every geometry type, permission tier, or
 * label-reassignment case already exercised there.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

import { Modality, UserRole } from "@internal/db";

import {
  assertExactKeys,
  cleanupContractFixture,
  contractFetch,
  contractLogin,
  contractTestsEnabled as enabled,
  contractUnique,
  createContractAsset,
  createContractDataset,
  createContractLabel,
  createContractUser,
} from "./helpers";

const skip = enabled ? false : "Set OPENAPI_CONTRACT_TESTS=1 against a running web service (see tests/openapi-contract/helpers.ts).";
const ANNOTATION_KEYS = ["id", "assetId", "labelId", "label", "modality", "type", "geometry", "status", "properties", "revision", "createdAt", "updatedAt"] as const;

const userIds: string[] = [];
const datasetIds: string[] = [];

after(async () => {
  if (userIds.length || datasetIds.length) await cleanupContractFixture(userIds, datasetIds);
});

test("GET /api/assets/{assetId}/annotations requires authentication and returns an empty documented envelope for a fresh Asset", { skip }, async () => {
  const owner = await createContractUser(UserRole.MANAGER);
  const dataset = await createContractDataset(owner.id);
  userIds.push(owner.id); datasetIds.push(dataset.id);
  const asset = await createContractAsset(dataset.id);

  const unauth = await contractFetch(`/api/assets/${asset.id}/annotations`);
  assert.equal(unauth.status, 401);

  const cookie = await contractLogin(owner.email);
  const response = await contractFetch(`/api/assets/${asset.id}/annotations`, { cookie });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { annotations: unknown[] } };
  assertExactKeys(body.data, ["annotations"], "annotation list response");
  assert.deepEqual(body.data.annotations, []);
});

test("PUT creates a BOUNDING_BOX annotation matching the exact documented Annotation DTO", { skip }, async () => {
  const owner = await createContractUser(UserRole.MANAGER);
  const dataset = await createContractDataset(owner.id);
  userIds.push(owner.id); datasetIds.push(dataset.id);
  const asset = await createContractAsset(dataset.id);
  const label = await createContractLabel(dataset.id);
  const cookie = await contractLogin(owner.email);

  const response = await contractFetch(`/api/assets/${asset.id}/annotations`, {
    method: "PUT", cookie,
    body: JSON.stringify({ creates: [{ id: contractUnique("box"), type: "BOUNDING_BOX", labelId: label.id, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { annotations: Array<Record<string, unknown>> } };
  assert.equal(body.data.annotations.length, 1);
  const annotation = body.data.annotations[0];
  assertExactKeys(annotation, ANNOTATION_KEYS, "created annotation");
  assert.equal(annotation.modality, "IMAGE");
  assert.equal(annotation.type, "BOUNDING_BOX");
  assert.equal(annotation.revision, 1);
  assert.equal(annotation.labelId, label.id);
  assertExactKeys(annotation.label as object, ["id", "name", "color"], "embedded annotation label");
  assert.equal((annotation.label as Record<string, unknown>).id, label.id);
});

test("PUT rejects a stale revision with 409 ANNOTATION_REVISION_CONFLICT", { skip }, async () => {
  const owner = await createContractUser(UserRole.MANAGER);
  const dataset = await createContractDataset(owner.id);
  userIds.push(owner.id); datasetIds.push(dataset.id);
  const asset = await createContractAsset(dataset.id);
  const cookie = await contractLogin(owner.email);

  const create = await contractFetch(`/api/assets/${asset.id}/annotations`, {
    method: "PUT", cookie,
    body: JSON.stringify({ creates: [{ id: contractUnique("box"), type: "BOUNDING_BOX", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }] }),
  });
  const created = (await create.json() as { data: { annotations: Array<{ id: string; revision: number }> } }).data.annotations[0];

  const conflict = await contractFetch(`/api/assets/${asset.id}/annotations`, {
    method: "PUT", cookie,
    body: JSON.stringify({ updates: [{ id: created.id, revision: created.revision + 1, labelId: null }] }),
  });
  assert.equal(conflict.status, 409);
  const body = await conflict.json() as { error: { code: string } };
  assert.equal(body.error.code, "ANNOTATION_REVISION_CONFLICT");
});

test("PUT on a non-IMAGE Asset returns 422 ANNOTATION_WRITE_UNSUPPORTED_FOR_MODALITY; GET still works for it", { skip }, async () => {
  const owner = await createContractUser(UserRole.MANAGER);
  const dataset = await createContractDataset(owner.id);
  userIds.push(owner.id); datasetIds.push(dataset.id);
  const videoAsset = await createContractAsset(dataset.id, Modality.VIDEO);
  const cookie = await contractLogin(owner.email);

  const get = await contractFetch(`/api/assets/${videoAsset.id}/annotations`, { cookie });
  assert.equal(get.status, 200, "GET is not IMAGE-only");

  const put = await contractFetch(`/api/assets/${videoAsset.id}/annotations`, {
    method: "PUT", cookie,
    body: JSON.stringify({ creates: [{ id: contractUnique("box"), type: "BOUNDING_BOX", geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }] }),
  });
  assert.equal(put.status, 422);
  const body = await put.json() as { error: { code: string } };
  assert.equal(body.error.code, "ANNOTATION_WRITE_UNSUPPORTED_FOR_MODALITY");
});

test("a foreign Asset and an unknown assetId are both concealed identically as 404 ANNOTATION_NOT_FOUND", { skip }, async () => {
  const owner = await createContractUser(UserRole.MANAGER);
  const outsider = await createContractUser(UserRole.MANAGER);
  const dataset = await createContractDataset(owner.id);
  const foreignDataset = await createContractDataset(outsider.id);
  userIds.push(owner.id, outsider.id); datasetIds.push(dataset.id, foreignDataset.id);
  const foreignAsset = await createContractAsset(foreignDataset.id);
  const cookie = await contractLogin(owner.email);

  const foreign = await contractFetch(`/api/assets/${foreignAsset.id}/annotations`, { cookie });
  assert.equal(foreign.status, 404);
  const foreignBody = await foreign.json() as { error: { code: string } };
  assert.equal(foreignBody.error.code, "ANNOTATION_NOT_FOUND");

  const unknown = await contractFetch("/api/assets/not-a-real-asset-id/annotations", { cookie });
  assert.equal(unknown.status, 404);
  const unknownBody = await unknown.json() as { error: { code: string } };
  assert.equal(unknownBody.error.code, "ANNOTATION_NOT_FOUND");
});
