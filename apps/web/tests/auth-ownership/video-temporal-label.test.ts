import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { AnnotationSource, AnnotationStatus, AnnotationType, DatasetMemberRole, Modality, UserRole } from "@internal/db";
import { createQueueTransport } from "@fieldframe/queue";
import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";
import { cleanupAnnotationFixture, createAnnotationDataset, createAnnotationUser } from "../annotation-api/helpers";

const enabled = process.env.VIDEO_ANNOTATION_HTTP_TESTS === "1";
const baseUrl = process.env.VIDEO_ANNOTATION_HTTP_BASE_URL ?? "http://127.0.0.1:3000";
const password = "workspace-test-password";
const externalSnapshotsEnabled = process.env.PHASE019_EXTERNAL_SIDE_EFFECT_TESTS === "1";
const githubFixtureUrl = process.env.GITHUB_FIXTURE_BASE_URL;
const suffix = randomBytes(6).toString("hex");
let userId = "";
let datasetId = "";
let assetId = "";
let noDurationAssetId = "";
let imageAssetId = "";
let labelId = "";
let foreignLabelId = "";
let session = "";
let foreignSession = "";
let foreignUserId = "";
let foreignDatasetId = "";
let managerUserId = "";
let labelerUserId = "";
let reviewerUserId = "";
let managerSession = "";
let labelerSession = "";
let reviewerSession = "";

async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200);
  const token = /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token);
  return `fieldframe_session=${token}`;
}

function request(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", Cookie: session, ...(init.headers ?? {}) } });
}

async function externalSnapshot() {
  if (!externalSnapshotsEnabled) return null;
  const queue = createQueueTransport({ host: process.env.REDIS_HOST ?? "127.0.0.1", port: Number(process.env.REDIS_PORT ?? 6379), password: process.env.REDIS_PASSWORD ?? "", db: Number(process.env.REDIS_TEST_DB ?? 15), prefix: process.env.REDIS_TEST_PREFIX ?? "fieldframe-phase019-test", failFast: true });
  const { config, minio } = getDirectUploadProviders();
  try {
    const objects: string[] = [];
    for await (const object of minio.listObjectsV2(config.MINIO_BUCKET, "phase019-video/", true)) if (object.name) objects.push(object.name);
    return { queue: await queue.getJobCounts("wait", "active", "delayed", "completed", "failed"), objects: objects.sort() };
  } finally { await queue.close(); }
}

async function githubCounter() {
  if (!githubFixtureUrl) return null;
  try {
    const response = await fetch(`${githubFixtureUrl}/__test/counter`);
    const body = await response.json() as { requests?: unknown; count?: unknown };
    const value = body.requests ?? body.count;
    return response.ok && typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

function assertRedacted(payload: unknown) {
  const text = JSON.stringify(payload).toLowerCase();
  for (const forbidden of ["storagebucket", "storagekey", "token", "sourceconnection", "fieldframe_session", "authorization", "database_url", "redis_password", "prisma", "p2002", "postgres", "sql", "stack", "constraint"]) {
    assert.equal(text.includes(forbidden), false, `response leaked ${forbidden}`);
  }
}

before(async () => {
  if (!enabled) return;
  const user = await createAnnotationUser(UserRole.MANAGER);
  userId = user.id;
  const dataset = await createAnnotationDataset(user.id);
  datasetId = dataset.id;
  const [asset, noDuration] = await Promise.all([
    db.asset.create({ data: { datasetId, modality: Modality.VIDEO, filename: `temporal-${suffix}.mp4`, mimeType: "video/mp4", durationMs: 10_000, sourceFingerprint: `temporal-${suffix}` }, select: { id: true } }),
    db.asset.create({ data: { datasetId, modality: Modality.VIDEO, filename: `temporal-no-duration-${suffix}.mp4`, mimeType: "video/mp4", sourceFingerprint: `temporal-no-duration-${suffix}` }, select: { id: true } }),
  ]);
  assetId = asset.id;
  noDurationAssetId = noDuration.id;
  imageAssetId = (await db.asset.create({ data: { datasetId, modality: Modality.IMAGE, filename: `temporal-image-${suffix}.png`, mimeType: "image/png", sourceFingerprint: `temporal-image-${suffix}` }, select: { id: true } })).id;
  await db.videoAsset.createMany({ data: [{ assetId }, { assetId: noDurationAssetId }] });
  const label = await db.label.create({ data: { datasetId, modality: Modality.VIDEO, name: `temporal-${suffix}`, normalizedName: `temporal-${suffix}`, color: "#0EA5E9" }, select: { id: true } });
  labelId = label.id;
  session = await login(user.email);
  const foreign = await createAnnotationUser(UserRole.MANAGER);
  foreignUserId = foreign.id;
  const foreignDataset = await createAnnotationDataset(foreign.id);
  foreignDatasetId = foreignDataset.id;
  foreignLabelId = (await db.label.create({ data: { datasetId: foreignDatasetId, modality: Modality.VIDEO, name: `foreign-label-${suffix}`, normalizedName: `foreign-label-${suffix}`, color: "#F97316" }, select: { id: true } })).id;
  foreignSession = await login(foreign.email);
  const [manager, labeler, reviewer] = await Promise.all([
    createAnnotationUser(UserRole.MANAGER), createAnnotationUser(UserRole.LABELER), createAnnotationUser(UserRole.REVIEWER),
  ]);
  managerUserId = manager.id; labelerUserId = labeler.id; reviewerUserId = reviewer.id;
  await db.datasetMember.createMany({ data: [
    { datasetId, userId: manager.id, role: DatasetMemberRole.MANAGER },
    { datasetId, userId: labeler.id, role: DatasetMemberRole.LABELER },
    { datasetId, userId: reviewer.id, role: DatasetMemberRole.REVIEWER },
  ] });
  managerSession = await login(manager.email);
  labelerSession = await login(labeler.email);
  reviewerSession = await login(reviewer.email);
});

test("temporal denial matrix conceals foreign/non-video/cross-label requests without durable side effects", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1 with PostgreSQL and a running web service." }, async () => {
  const snapshot = async () => ({
    annotations: await db.annotation.findMany({ where: { assetId: { in: [assetId, imageAssetId] } }, select: { id: true, revision: true }, orderBy: { id: "asc" } }),
    tracks: await db.videoObjectTrack.findMany({ select: { id: true, revision: true }, orderBy: { id: "asc" } }),
    jobs: await db.job.count(),
    events: await db.jobEvent.count(),
  });
  const before = await snapshot();
  const externalBefore = await externalSnapshot();
  const foreign = await request(`/api/assets/${assetId}/temporal-labels`, { method: "POST", headers: { Cookie: foreignSession }, body: JSON.stringify({ type: "EVENT", startMs: 0, endMs: 100 }) });
  assert.equal(foreign.status, 404);
  const nonVideo = await request(`/api/assets/${imageAssetId}/temporal-labels`, { method: "POST", body: JSON.stringify({ type: "EVENT", startMs: 0, endMs: 100 }) });
  assert.equal(nonVideo.status, 404);
  const crossLabel = await request(`/api/assets/${assetId}/temporal-labels`, { method: "POST", body: JSON.stringify({ type: "EVENT", labelId: foreignLabelId, startMs: 0, endMs: 100 }) });
  assert.equal(crossLabel.status, 404);
  const validationCases = [
    { body: { type: "UNSUPPORTED", startMs: 0, endMs: 100 }, status: 400 },
    { body: { type: "EVENT", startMs: -1, endMs: 100 }, status: 400 },
    { body: { type: "EVENT", startMs: 100, endMs: 100 }, status: 400 },
    { body: { type: "EVENT", startMs: 100, endMs: 10_001 }, status: 400 },
    { body: { type: "EVENT", startMs: 0, endMs: 100, expectedRevision: 1 }, status: 400 },
    { body: { type: "EVENT", startMs: 0, endMs: 100, trackId: "browser-authority" }, status: 400 },
    { body: { type: "EVENT", startMs: 0, endMs: 100, labelId: "" }, status: 400 },
    { body: { type: "EVENT", startMs: 0, endMs: 100, labelId: randomBytes(8).toString("hex") }, status: 404 },
  ];
  const validationResponses = await Promise.all(validationCases.map(async ({ body, status }) => {
    const response = await request(`/api/assets/${assetId}/temporal-labels`, { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, status);
    return response;
  }));
  for (const response of [foreign, nonVideo, crossLabel, ...validationResponses]) {
    const text = JSON.stringify(await response.clone().json());
    assert.equal(/Prisma|postgres|stack|token|secret|storage/i.test(text), false);
  }
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await externalSnapshot(), externalBefore, "temporal denials must not mutate isolated Redis/BullMQ or MinIO");
});

after(async () => {
  if (enabled) await cleanupAnnotationFixture([userId, foreignUserId, managerUserId, labelerUserId, reviewerUserId], [datasetId, foreignDatasetId]);
});

test("temporal-label HTTP lifecycle uses Annotation.revision and authoritative duration", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1 with PostgreSQL and a running web service." }, async () => {
  const trackCreated = await request(`/api/assets/${assetId}/video-object-tracks`, { method: "POST", body: JSON.stringify({ name: "temporal-isolation" }) });
  assert.equal(trackCreated.status, 201);
  const track = await trackCreated.json() as { data: { track: { id: string; revision: number } } };
  const created = await request(`/api/assets/${assetId}/temporal-labels`, { method: "POST", body: JSON.stringify({ type: "EVENT", labelId, startMs: 100, endMs: 900 }) });
  assert.equal(created.status, 201);
  const createdBody = await created.json() as { data: { temporalLabel: { id: string; revision: number } } };
  assert.equal(createdBody.data.temporalLabel.revision, 1);
  const updated = await request(`/api/temporal-labels/${createdBody.data.temporalLabel.id}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: 1, startMs: 200, endMs: 1000 }) });
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json() as { data: { temporalLabel: { revision: number } } };
  assert.equal(updatedBody.data.temporalLabel.revision, 2);
  const [winner, loser] = await Promise.all([
    request(`/api/temporal-labels/${createdBody.data.temporalLabel.id}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: 2, startMs: 300, endMs: 1100 }) }),
    request(`/api/temporal-labels/${createdBody.data.temporalLabel.id}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: 2, startMs: 400, endMs: 1200 }) }),
  ]);
  assert.deepEqual([winner.status, loser.status].sort(), [200, 409]);
  const deletedRevision = 3;
  const deleted = await request(`/api/temporal-labels/${createdBody.data.temporalLabel.id}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: deletedRevision }) });
  assert.equal(deleted.status, 200);
  const missingDuration = await request(`/api/assets/${noDurationAssetId}/temporal-labels`, { method: "POST", body: JSON.stringify({ type: "SCENE", startMs: 0, endMs: 100 }) });
  assert.equal(missingDuration.status, 400);
  const untouchedTrack = await db.videoObjectTrack.findUniqueOrThrow({ where: { id: track.data.track.id }, select: { revision: true } });
  assert.equal(untouchedTrack.revision, 1, "standalone temporal mutations must not claim a Track revision");
  const malformed = await request("/api/temporal-labels/not-an-annotation", { method: "PATCH", body: JSON.stringify({ expectedRevision: 1, startMs: 0, endMs: 100 }) });
  assert.ok([400, 404].includes(malformed.status));
  const unknown = await request(`/api/temporal-labels/${randomBytes(8).toString("hex")}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: 1 }) });
  assert.equal(unknown.status, 404);
  const foreignAsset = await db.asset.create({ data: { datasetId: foreignDatasetId, modality: Modality.VIDEO, filename: `foreign-${suffix}.mp4`, mimeType: "video/mp4", durationMs: 1000, sourceFingerprint: `foreign-${suffix}` }, select: { id: true } });
  await db.videoAsset.create({ data: { assetId: foreignAsset.id } });
  const foreignCreate = await request(`/api/assets/${foreignAsset.id}/temporal-labels`, { method: "POST", headers: { Cookie: foreignSession }, body: JSON.stringify({ type: "EVENT", startMs: 0, endMs: 100 }) });
  assert.equal(foreignCreate.status, 201);
  const foreignLabel = await foreignCreate.json() as { data: { temporalLabel: { id: string; revision: number } } };
  const concealed = await request(`/api/temporal-labels/${foreignLabel.data.temporalLabel.id}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: 1 }) });
  assert.equal(concealed.status, 404);
});

test("approved Dataset roles govern standalone temporal-label create, update, and delete", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1 with PostgreSQL and a running web service." }, async () => {
  const before = { jobs: await db.job.count(), events: await db.jobEvent.count() };
  for (const [role, cookie] of [["owner", session], ["manager", managerSession], ["labeler", labelerSession], ["reviewer", reviewerSession]] as const) {
    const created = await request(`/api/assets/${assetId}/temporal-labels`, { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ type: "SCENE", startMs: 1_000, endMs: 2_000 }) });
    assert.equal(created.status, 201, `${role} has annotation.create`);
    const temporal = (await created.json() as { data: { temporalLabel: { id: string; revision: number } } }).data.temporalLabel;
    const updated = await request(`/api/temporal-labels/${temporal.id}`, { method: "PATCH", headers: { Cookie: cookie }, body: JSON.stringify({ expectedRevision: temporal.revision, startMs: 1_100, endMs: 2_100 }) });
    assert.equal(updated.status, 200, `${role} can update their own temporal label`);
    const deleted = await request(`/api/temporal-labels/${temporal.id}`, { method: "DELETE", headers: { Cookie: cookie }, body: JSON.stringify({ expectedRevision: temporal.revision + 1 }) });
    assert.equal(deleted.status, 200, `${role} can delete their own temporal label`);
  }
  const unauthenticated = await fetch(`${baseUrl}/api/assets/${assetId}/temporal-labels`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "EVENT", startMs: 0, endMs: 100 }) });
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual({ jobs: await db.job.count(), events: await db.jobEvent.count() }, before);
});

test("temporal routes conceal keyframe, image, and foreign annotations before revision and reject unsafe DELETE DTOs", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1 with PostgreSQL and a running web service." }, async () => {
  const ownedTrack = await db.videoObjectTrack.create({ data: { videoAssetId: (await db.videoAsset.findUniqueOrThrow({ where: { assetId }, select: { id: true } })).id, createdById: userId, annotationType: AnnotationType.BOUNDING_BOX, interpolationMode: "LINEAR" }, select: { id: true, revision: true } });
  const keyframe = await db.annotation.create({ data: { datasetId, assetId, trackId: ownedTrack.id, createdById: userId, modality: Modality.VIDEO, type: AnnotationType.BOUNDING_BOX, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, properties: {}, isKeyframe: true, isInterpolated: false, timestampMs: 500 }, select: { id: true } });
  const imageAnnotation = await db.annotation.create({ data: { datasetId, assetId: imageAssetId, createdById: userId, modality: Modality.IMAGE, type: AnnotationType.POINT, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: { px: 0.2, py: 0.2 }, properties: {} }, select: { id: true } });
  const foreignAsset = await db.asset.create({ data: { datasetId: foreignDatasetId, modality: Modality.VIDEO, filename: `temporal-foreign-matrix-${suffix}.mp4`, mimeType: "video/mp4", durationMs: 1000, sourceFingerprint: `temporal-foreign-matrix-${suffix}` }, select: { id: true } });
  await db.videoAsset.create({ data: { assetId: foreignAsset.id } });
  const foreignAnnotation = await db.annotation.create({ data: { datasetId: foreignDatasetId, assetId: foreignAsset.id, createdById: foreignUserId, modality: Modality.VIDEO, type: AnnotationType.EVENT, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: {}, properties: {}, startMs: 10, endMs: 100, isKeyframe: false, isInterpolated: false }, select: { id: true, revision: true } });
  const ownedTemporal = await db.annotation.create({ data: { datasetId, assetId, createdById: userId, modality: Modality.VIDEO, type: AnnotationType.EVENT, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: {}, properties: { keep: true }, startMs: 10, endMs: 100, isKeyframe: false, isInterpolated: false }, select: { id: true, revision: true } });
  const snapshot = async () => ({ track: await db.videoObjectTrack.findUnique({ where: { id: ownedTrack.id }, select: { id: true, revision: true } }), annotations: await db.annotation.findMany({ where: { id: { in: [keyframe.id, imageAnnotation.id, foreignAnnotation.id, ownedTemporal.id] } }, select: { id: true, revision: true, geometry: true, startMs: true, endMs: true, properties: true }, orderBy: { id: "asc" } }), annotationCount: await db.annotation.count(), jobs: await db.job.count(), events: await db.jobEvent.count() });
  const before = await snapshot();
  const externalBefore = await externalSnapshot();
  const providerBefore = await githubCounter();
  const cases = [
    request(`/api/temporal-labels/${keyframe.id}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: 1, startMs: 20, endMs: 120 }) }),
    request(`/api/temporal-labels/${imageAnnotation.id}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: 1 }) }),
    request(`/api/temporal-labels/${foreignAnnotation.id}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: foreignAnnotation.revision, startMs: 20, endMs: 120 }) }),
    request(`/api/temporal-labels/${ownedTemporal.id}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: ownedTemporal.revision, trackId: ownedTrack.id }) }),
  ];
  const responses = await Promise.all(cases);
  assert.deepEqual(responses.map((response) => response.status), [404, 404, 404, 400]);
  for (const response of responses) assertRedacted(await response.json());
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await externalSnapshot(), externalBefore);
  const providerAfter = await githubCounter();
  if (providerBefore !== null && providerAfter !== null) assert.equal(providerAfter, providerBefore);
});
