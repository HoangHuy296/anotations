import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { DatasetMemberRole, Modality, UserRole } from "@internal/db";
import { createQueueTransport, readSafeLocalQueueTestConfig } from "@annotationplatform/queue";

import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";
import {
  cleanupAnnotationFixture,
  createAnnotationAsset,
  createAnnotationDataset,
  createAnnotationLabel,
  createAnnotationUser,
} from "./helpers";

const enabled = process.env.ANNOTATION_API_HTTP_TESTS === "1";
const sideEffectSnapshotsEnabled = enabled
  && process.env.ANNOTATION_API_SIDE_EFFECT_TESTS === "1"
  && process.env.QUEUE_INTEGRATION_TESTS === "1"
  && process.env.REDIS_DB === "15"
  && process.env.REDIS_TEST_DB === "15"
  && process.env.BULLMQ_PREFIX === "fieldframe-phase017-test"
  && process.env.REDIS_TEST_PREFIX === "fieldframe-phase017-test";
const baseUrl = process.env.ANNOTATION_API_HTTP_BASE_URL ?? "http://127.0.0.1:3000";
const password = "workspace-test-password";
const suffix = randomBytes(6).toString("hex");
const ids: { users: string[]; datasets: string[] } = { users: [], datasets: [] };
let ownerCookie = "";
let managerCookie = "";
let reviewerCookie = "";
let memberCookie = "";
let outsiderCookie = "";
let imageId = "";
let videoId = "";
let textId = "";
let audioId = "";
let labelId = "";
let crossAssetId = "";
let crossAnnotationId = "";
let foreignAssetId = "";

function sessionCookie(response: Response) {
  const value = response.headers.get("set-cookie") ?? "";
  const token = /^fieldframe_session=([^;]+)/.exec(value)?.[1];
  assert.ok(token, "normal login must issue an opaque cookie");
  return `fieldframe_session=${token}`;
}

async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  return sessionCookie(response);
}

async function request(path: string, cookie: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Cookie: cookie, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function snapshot() {
  const [annotations, jobs, events] = await Promise.all([
    db.annotation.findMany({ where: { assetId: imageId }, select: { id: true, revision: true, geometry: true }, orderBy: { id: "asc" } }),
    db.job.count(),
    db.jobEvent.count(),
  ]);
  return { annotations, jobs, events };
}

async function isolatedExternalSnapshot() {
  const queueConfig = readSafeLocalQueueTestConfig();
  const queue = createQueueTransport({ host: queueConfig.REDIS_HOST, port: queueConfig.REDIS_PORT, password: queueConfig.REDIS_PASSWORD, db: queueConfig.REDIS_TEST_DB, prefix: queueConfig.REDIS_TEST_PREFIX, failFast: true });
  const { config, minio } = getDirectUploadProviders();
  const objectKeys: string[] = [];
  try {
    for await (const object of minio.listObjectsV2(config.MINIO_BUCKET, "phase017-annotation-api/", true)) if (object.name) objectKeys.push(object.name);
    return { queue: await queue.getJobCounts("wait", "active", "delayed", "completed", "failed"), objectKeys: objectKeys.sort() };
  } finally {
    await queue.close();
  }
}

function assertRedacted(payload: unknown) {
  const encoded = JSON.stringify(payload).toLowerCase();
  for (const forbidden of ["passwordhash", "refreshtokenhash", "fieldframe_session", "sourceconnection", "storagekey", "storagebucket", "stack", "database_url", "redis_password", "minio_secret"]) {
    assert.equal(encoded.includes(forbidden), false, `response leaked ${forbidden}`);
  }
}

before(async () => {
  if (!enabled) return;
  const owner = await createAnnotationUser(UserRole.MANAGER);
  const manager = await createAnnotationUser(UserRole.MANAGER);
  const reviewer = await createAnnotationUser(UserRole.REVIEWER);
  const member = await createAnnotationUser(UserRole.LABELER);
  const outsider = await createAnnotationUser(UserRole.LABELER);
  ids.users = [owner.id, manager.id, reviewer.id, member.id, outsider.id];
  const dataset = await createAnnotationDataset(owner.id);
  const foreignDataset = await createAnnotationDataset(outsider.id);
  ids.datasets = [dataset.id, foreignDataset.id];
  const [image, label, video, text, audio] = await Promise.all([
    createAnnotationAsset(dataset.id),
    createAnnotationLabel(dataset.id),
    db.asset.create({ data: { datasetId: dataset.id, modality: Modality.VIDEO, filename: `video-${suffix}.mp4`, mimeType: "video/mp4", sourceFingerprint: `video-${suffix}` }, select: { id: true } }),
    db.asset.create({ data: { datasetId: dataset.id, modality: Modality.TEXT, filename: `text-${suffix}.txt`, mimeType: "text/plain", sourceFingerprint: `text-${suffix}` }, select: { id: true } }),
    db.asset.create({ data: { datasetId: dataset.id, modality: Modality.AUDIO, filename: `audio-${suffix}.mp3`, mimeType: "audio/mpeg", sourceFingerprint: `audio-${suffix}` }, select: { id: true } }),
  ]);
  const crossAsset = await createAnnotationAsset(dataset.id, { filename: `cross-${suffix}.png` });
  const foreignAsset = await createAnnotationAsset(foreignDataset.id, { filename: `foreign-${suffix}.png` });
  const crossAnnotation = await db.annotation.create({ data: { id: `cross-${suffix}`, datasetId: dataset.id, assetId: crossAsset.id, createdById: owner.id, modality: Modality.IMAGE, type: "POINT", source: "MANUAL", status: "DRAFT", geometry: { px: 0.4, py: 0.4 }, properties: {} }, select: { id: true } });
  imageId = image.id; labelId = label.id; videoId = video.id; textId = text.id; audioId = audio.id; crossAssetId = crossAsset.id; crossAnnotationId = crossAnnotation.id; foreignAssetId = foreignAsset.id;
  await db.datasetMember.createMany({ data: [
    { datasetId: dataset.id, userId: manager.id, role: DatasetMemberRole.MANAGER },
    { datasetId: dataset.id, userId: reviewer.id, role: DatasetMemberRole.REVIEWER },
    { datasetId: dataset.id, userId: member.id, role: DatasetMemberRole.LABELER },
  ] });
  ownerCookie = await login(owner.email);
  managerCookie = await login(manager.email);
  reviewerCookie = await login(reviewer.email);
  memberCookie = await login(member.email);
  outsiderCookie = await login(outsider.email);
});

after(async () => {
  if (ids.datasets.length || ids.users.length) await cleanupAnnotationFixture(ids.users, ids.datasets);
});

test("cookie-authenticated GET reads all modalities and conceals a foreign Asset", { skip: enabled ? false : "Set ANNOTATION_API_HTTP_TESTS=1 with PostgreSQL and a running web service." }, async () => {
  for (const assetId of [imageId, videoId, textId, audioId]) {
    const response = await request(`/api/assets/${assetId}/annotations`, ownerCookie);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload, { data: { annotations: [] } });
    assertRedacted(payload);
  }
  assert.equal((await request(`/api/assets/${imageId}/annotations`, memberCookie)).status, 200);
  const concealed = await request(`/api/assets/${imageId}/annotations`, outsiderCookie);
  assert.equal(concealed.status, 404);
  assertRedacted(await concealed.json());
  for (const assetId of [foreignAssetId, "not-a-valid-asset-id", `missing-${suffix}`]) {
    const response = await request(`/api/assets/${assetId}/annotations`, ownerCookie);
    assert.equal(response.status, 404);
    assertRedacted(await response.json());
  }
});

test("cookie-authenticated PUT creates the five image shapes and rejects non-image writes without durable side effects", { skip: enabled ? false : "Set ANNOTATION_API_HTTP_TESTS=1 with PostgreSQL and a running web service." }, async () => {
  const response = await request(`/api/assets/${imageId}/annotations`, ownerCookie, {
    method: "PUT",
    body: JSON.stringify({ creates: [
      { id: `box-${suffix}`, type: "BOUNDING_BOX", labelId, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
      { id: `polygon-${suffix}`, type: "POLYGON", labelId, geometry: { points: [[0.1, 0.1], [0.3, 0.1], [0.2, 0.3]] } },
      { id: `circle-${suffix}`, type: "CIRCLE", labelId, geometry: { cx: 0.5, cy: 0.5, r: 0.2 } },
      { id: `point-${suffix}`, type: "POINT", labelId, geometry: { px: 0.2, py: 0.2 } },
      { id: `line-${suffix}`, type: "POLYLINE", labelId, geometry: { points: [[0.1, 0.1], [0.3, 0.3]] } },
    ] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { annotations: Array<{ id: string; type: string; labelId: string | null; revision: number; geometry: unknown }> } };
  assert.equal(body.data.annotations.length, 5);
  assertRedacted(body);
  const point = body.data.annotations.find((annotation) => annotation.type === "POINT");
  const line = body.data.annotations.find((annotation) => annotation.type === "POLYLINE");
  assert.ok(point); assert.ok(line);
  const geometryOnly = await request(`/api/assets/${imageId}/annotations`, ownerCookie, { method: "PUT", body: JSON.stringify({ updates: [{ id: point.id, revision: point.revision, geometry: { px: 0.25, py: 0.2 } }] }) });
  assert.equal(geometryOnly.status, 200);
  const geometryBody = await geometryOnly.json() as { data: { annotations: Array<{ id: string; labelId: string | null; revision: number; geometry: unknown }> } };
  const movedPoint = geometryBody.data.annotations.find((annotation) => annotation.id === point.id);
  assert.deepEqual(movedPoint?.geometry, { px: 0.25, py: 0.2 });
  assert.equal(movedPoint?.labelId, labelId);
  const relabel = await request(`/api/assets/${imageId}/annotations`, ownerCookie, { method: "PUT", body: JSON.stringify({ updates: [{ id: point.id, revision: movedPoint?.revision, labelId: null }] }) });
  assert.equal(relabel.status, 200);
  const replay = await request(`/api/assets/${imageId}/annotations`, ownerCookie, { method: "PUT", body: JSON.stringify({ creates: [{ id: `box-${suffix}`, type: "BOUNDING_BOX", labelId, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }] }) });
  assert.equal(replay.status, 200);
  const deleted = await request(`/api/assets/${imageId}/annotations`, ownerCookie, { method: "PUT", body: JSON.stringify({ deletes: [{ id: line.id, revision: line.revision }] }) });
  assert.equal(deleted.status, 200);
  const before = await snapshot();
  const nonImage = await request(`/api/assets/${videoId}/annotations`, ownerCookie, { method: "PUT", body: JSON.stringify({ creates: [] }) });
  assert.equal(nonImage.status, 422);
  assert.equal((await nonImage.json() as { error: { code: string } }).error.code, "ANNOTATION_WRITE_UNSUPPORTED_FOR_MODALITY");
  assert.deepEqual(await snapshot(), before);
});

test("invalid geometry and cross-Asset references are concealed and have no durable side effect", { skip: enabled ? false : "Set ANNOTATION_API_HTTP_TESTS=1 with PostgreSQL and a running web service." }, async () => {
  const before = await snapshot();
  const invalid = await request(`/api/assets/${imageId}/annotations`, ownerCookie, {
    method: "PUT", body: JSON.stringify({ creates: [{ id: `bad-${suffix}`, type: "BOUNDING_BOX", geometry: { x: 0.9, y: 0.1, width: 0.2, height: 0.2 } }] }),
  });
  assert.equal(invalid.status, 400);
  assertRedacted(await invalid.json());
  const cross = await request(`/api/assets/${imageId}/annotations`, ownerCookie, {
    method: "PUT", body: JSON.stringify({ updates: [{ id: crossAnnotationId, revision: 1, geometry: { px: 0.5, py: 0.5 } }] }),
  });
  assert.equal(cross.status, 404);
  assertRedacted(await cross.json());
  assert.deepEqual(await snapshot(), before);
  assert.ok(crossAssetId);
});

test("manager and reviewer may update any annotation; a labeler may update only their own", { skip: enabled ? false : "Set ANNOTATION_API_HTTP_TESTS=1 with PostgreSQL and a running web service." }, async () => {
  const listed = await request(`/api/assets/${imageId}/annotations`, ownerCookie);
  const annotations = (await listed.json() as { data: { annotations: Array<{ id: string; type: string; revision: number }> } }).data.annotations;
  const box = annotations.find((annotation) => annotation.type === "BOUNDING_BOX");
  assert.ok(box);
  const managerUpdate = await request(`/api/assets/${imageId}/annotations`, managerCookie, { method: "PUT", body: JSON.stringify({ updates: [{ id: box.id, revision: box.revision, geometry: { x: 0.15, y: 0.1, width: 0.2, height: 0.2 } }] }) });
  assert.equal(managerUpdate.status, 200);
  const reviewerUpdate = await request(`/api/assets/${imageId}/annotations`, reviewerCookie, { method: "PUT", body: JSON.stringify({ updates: [{ id: box.id, revision: box.revision + 1, geometry: { x: 0.2, y: 0.1, width: 0.2, height: 0.2 } }] }) });
  assert.equal(reviewerUpdate.status, 200);
  const labelerDenied = await request(`/api/assets/${imageId}/annotations`, memberCookie, { method: "PUT", body: JSON.stringify({ updates: [{ id: box.id, revision: box.revision + 2, geometry: { x: 0.25, y: 0.1, width: 0.2, height: 0.2 } }] }) });
  assert.equal(labelerDenied.status, 403);
  assertRedacted(await labelerDenied.json());
  const ownId = `labeler-${suffix}`;
  const labelerCreate = await request(`/api/assets/${imageId}/annotations`, memberCookie, { method: "PUT", body: JSON.stringify({ creates: [{ id: ownId, type: "POINT", geometry: { px: 0.6, py: 0.6 } }] }) });
  assert.equal(labelerCreate.status, 200);
  const labelerOwnUpdate = await request(`/api/assets/${imageId}/annotations`, memberCookie, { method: "PUT", body: JSON.stringify({ updates: [{ id: ownId, revision: 1, geometry: { px: 0.65, py: 0.6 } }] }) });
  assert.equal(labelerOwnUpdate.status, 200);
});

test("rejected annotation requests leave PostgreSQL, isolated Redis, and MinIO unchanged", { skip: sideEffectSnapshotsEnabled ? false : "Require explicit isolated Redis DB 15/prefix and ANNOTATION_API_SIDE_EFFECT_TESTS=1." }, async () => {
  const beforeBusiness = await snapshot();
  const beforeExternal = await isolatedExternalSnapshot();
  const rejectedRequests = [
    request(`/api/assets/${imageId}/annotations`, ownerCookie, {
      method: "PUT",
      body: JSON.stringify({ creates: [{ id: `invalid-side-effect-${suffix}`, type: "BOUNDING_BOX", geometry: { x: 0.9, y: 0.1, width: 0.2, height: 0.2 } }] }),
    }),
    request(`/api/assets/${imageId}/annotations`, ownerCookie, {
      method: "PUT",
      body: JSON.stringify({ updates: [{ id: crossAnnotationId, revision: 1, geometry: { px: 0.5, py: 0.5 } }] }),
    }),
    request(`/api/assets/${imageId}/annotations`, outsiderCookie, {
      method: "PUT",
      body: JSON.stringify({ creates: [{ id: `denied-side-effect-${suffix}`, type: "POINT", geometry: { px: 0.2, py: 0.2 } }] }),
    }),
  ];
  const responses = await Promise.all(rejectedRequests);
  assert.deepEqual(responses.map((response) => response.status), [400, 404, 404]);
  for (const response of responses) assertRedacted(await response.json());
  assert.deepEqual(await snapshot(), beforeBusiness);
  assert.deepEqual(await isolatedExternalSnapshot(), beforeExternal);
});
