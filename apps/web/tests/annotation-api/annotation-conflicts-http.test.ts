import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { AnnotationSource, AnnotationStatus, AnnotationType, Modality, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { cleanupAnnotationFixture, createAnnotationAsset, createAnnotationDataset, createAnnotationUser } from "./helpers";

const enabled = process.env.ANNOTATION_API_HTTP_TESTS === "1";
const baseUrl = process.env.ANNOTATION_API_HTTP_BASE_URL ?? "http://127.0.0.1:3000";
const password = "workspace-test-password";
const suffix = randomBytes(6).toString("hex");
let userIds: string[] = [];
let datasetIds: string[] = [];
let assetId = "";
let annotationId = "";
let cookie = "";

async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200);
  const token = /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token);
  return `fieldframe_session=${token}`;
}

function put(body: unknown) {
  return fetch(`${baseUrl}/api/assets/${assetId}/annotations`, { method: "PUT", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
}

before(async () => {
  if (!enabled) return;
  const user = await createAnnotationUser(UserRole.MANAGER);
  userIds = [user.id];
  const dataset = await createAnnotationDataset(user.id);
  datasetIds = [dataset.id];
  const asset = await createAnnotationAsset(dataset.id);
  assetId = asset.id;
  const annotation = await db.annotation.create({ data: {
    id: `phase017-conflict-${suffix}`, datasetId: dataset.id, assetId, createdById: user.id, modality: Modality.IMAGE,
    type: AnnotationType.BOUNDING_BOX, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT,
    geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, properties: {},
  }, select: { id: true } });
  annotationId = annotation.id;
  cookie = await login(user.email);
});

after(async () => { if (datasetIds.length || userIds.length) await cleanupAnnotationFixture(userIds, datasetIds); });

test("one revision-guarded write wins and a stale mixed change set rolls back", { skip: enabled ? false : "Set ANNOTATION_API_HTTP_TESTS=1 with PostgreSQL and a running web service." }, async () => {
  const first = { updates: [{ id: annotationId, revision: 1, geometry: { x: 0.2, y: 0.1, width: 0.2, height: 0.2 } }] };
  const second = { updates: [{ id: annotationId, revision: 1, geometry: { x: 0.3, y: 0.1, width: 0.2, height: 0.2 } }] };
  const [one, two] = await Promise.all([put(first), put(second)]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
  const durable = await db.annotation.findUniqueOrThrow({ where: { id: annotationId }, select: { revision: true, geometry: true } });
  assert.equal(durable.revision, 2);
  const beforeCount = await db.annotation.count({ where: { assetId } });
  const staleMixed = await put({
    creates: [{ id: `rollback-${suffix}`, type: "POINT", geometry: { px: 0.5, py: 0.5 } }],
    updates: [{ id: annotationId, revision: 1, geometry: { x: 0.4, y: 0.1, width: 0.2, height: 0.2 } }],
  });
  assert.equal(staleMixed.status, 409);
  assert.equal(await db.annotation.count({ where: { assetId } }), beforeCount);
  const after = await db.annotation.findUniqueOrThrow({ where: { id: annotationId }, select: { revision: true, geometry: true } });
  assert.deepEqual(after, durable);
});
