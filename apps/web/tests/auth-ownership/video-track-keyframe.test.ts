import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { DatasetMemberRole, Modality, UserRole } from "@internal/db";
import { createQueueTransport } from "@fieldframe/queue";
import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";
import { cleanupAnnotationFixture, createAnnotationDataset, createAnnotationUser } from "../annotation-api/helpers";

const enabled = process.env.VIDEO_ANNOTATION_HTTP_TESTS === "1";
const baseUrl = process.env.VIDEO_ANNOTATION_HTTP_BASE_URL ?? "http://127.0.0.1:3000";
const password = "workspace-test-password";
const githubFixtureUrl = process.env.GITHUB_FIXTURE_BASE_URL;
const externalSnapshotsEnabled = process.env.PHASE019_EXTERNAL_SIDE_EFFECT_TESTS === "1";
const suffix = randomBytes(6).toString("hex");
let owner: { id: string; email: string };
let manager: { id: string; email: string };
let foreign: { id: string; email: string };
let labeler: { id: string; email: string };
let reviewer: { id: string; email: string };
let nonMember: { id: string; email: string };
let datasetId = "";
let foreignDatasetId = "";
let assetId = "";
let labelId = "";
let ownerCookie = "";
let managerCookie = "";
let foreignCookie = "";
let labelerCookie = "";
let reviewerCookie = "";
let nonMemberCookie = "";
let imageAssetId = "";
let foreignLabelId = "";

function cookie(response: Response) {
  const token = /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token);
  return `fieldframe_session=${token}`;
}

async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200);
  return cookie(response);
}

async function githubCounter() {
  if (!githubFixtureUrl) return null;
  try {
    const response = await fetch(`${githubFixtureUrl}/__test/counter`);
    if (!response.ok) return null;
    const value = await response.json() as { count?: number };
    return typeof value.count === "number" ? value.count : null;
  } catch {
    // Fixture counters are optional evidence; unavailable is explicitly N/A.
    return null;
  }
}

async function externalSnapshot() {
  if (!externalSnapshotsEnabled) return null;
  const queue = createQueueTransport({
    host: process.env.REDIS_HOST ?? "127.0.0.1",
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD ?? "",
    db: Number(process.env.REDIS_TEST_DB ?? 15),
    prefix: process.env.REDIS_TEST_PREFIX ?? "fieldframe-phase019-test",
    failFast: true,
  });
  const { config, minio } = getDirectUploadProviders();
  try {
    const objects: string[] = [];
    for await (const object of minio.listObjectsV2(config.MINIO_BUCKET, "phase019-video/", true)) if (object.name) objects.push(object.name);
    return { queue: await queue.getJobCounts("wait", "active", "delayed", "completed", "failed"), objects: objects.sort() };
  } finally {
    await queue.close();
  }
}

function request(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", Cookie: session, ...(init.headers ?? {}) } });
}

before(async () => {
  if (!enabled) return;
  owner = await createAnnotationUser(UserRole.MANAGER);
  manager = await createAnnotationUser(UserRole.MANAGER);
  foreign = await createAnnotationUser(UserRole.MANAGER);
  labeler = await createAnnotationUser(UserRole.LABELER);
  reviewer = await createAnnotationUser(UserRole.REVIEWER);
  nonMember = await createAnnotationUser(UserRole.LABELER);
  const dataset = await createAnnotationDataset(owner.id);
  const foreignDataset = await createAnnotationDataset(foreign.id);
  datasetId = dataset.id;
  foreignDatasetId = foreignDataset.id;
  await db.datasetMember.create({ data: { datasetId, userId: foreign.id, role: DatasetMemberRole.REVIEWER } });
  await db.datasetMember.create({ data: { datasetId, userId: manager.id, role: DatasetMemberRole.MANAGER } });
  await db.datasetMember.create({ data: { datasetId, userId: labeler.id, role: DatasetMemberRole.LABELER } });
  await db.datasetMember.create({ data: { datasetId, userId: reviewer.id, role: DatasetMemberRole.REVIEWER } });
  const asset = await db.asset.create({ data: { datasetId, modality: Modality.VIDEO, filename: `phase019-${suffix}.mp4`, mimeType: "video/mp4", durationMs: 10_000, sourceFingerprint: `phase019-${suffix}` }, select: { id: true } });
  assetId = asset.id;
  imageAssetId = (await db.asset.create({ data: { datasetId, modality: Modality.IMAGE, filename: `not-video-${suffix}.png`, mimeType: "image/png", sourceFingerprint: `not-video-${suffix}` }, select: { id: true } })).id;
  await db.videoAsset.create({ data: { assetId, fps: 25, totalFrames: 250 }, select: { id: true } });
  const label = await db.label.create({ data: { datasetId, modality: Modality.VIDEO, name: `phase019-${suffix}`, normalizedName: `phase019-${suffix}`, color: "#0EA5E9" }, select: { id: true } });
  labelId = label.id;
  foreignLabelId = (await db.label.create({ data: { datasetId: foreignDatasetId, modality: Modality.VIDEO, name: `foreign-${suffix}`, normalizedName: `foreign-${suffix}`, color: "#F97316" }, select: { id: true } })).id;
  ownerCookie = await login(owner.email);
  managerCookie = await login(manager.email);
  foreignCookie = await login(foreign.email);
  labelerCookie = await login(labeler.email);
  reviewerCookie = await login(reviewer.email);
  nonMemberCookie = await login(nonMember.email);
});

after(async () => {
  if (!enabled) return;
  await cleanupAnnotationFixture([owner.id, manager.id, foreign.id, labeler.id, reviewer.id, nonMember.id], [datasetId, foreignDatasetId]);
});

test("track/keyframe role and concealment matrix has no durable or provider side effects", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1 with PostgreSQL and a running web service." }, async () => {
  const malformed = await request("/api/assets/not-a-real-asset/video-object-tracks", ownerCookie, { method: "POST", body: JSON.stringify({ name: "x" }) });
  assert.ok([400, 404].includes(malformed.status));
  const unknown = await request(`/api/assets/${randomBytes(8).toString("hex")}/video-object-tracks`, ownerCookie, { method: "POST", body: JSON.stringify({ name: "x" }) });
  assert.equal(unknown.status, 404);
  const unauthenticated = await fetch(`${baseUrl}/api/assets/${assetId}/video-object-tracks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
  assert.equal(unauthenticated.status, 401);

  const before = await Promise.all([
    db.videoObjectTrack.count(),
    db.annotation.count({ where: { assetId } }),
    db.job.count(),
    db.jobEvent.count(),
  ]);
  const createdRoleTracks: string[] = [];
  for (const session of [foreignCookie, labelerCookie, reviewerCookie]) {
    const denied = await request(`/api/assets/${assetId}/video-object-tracks`, session, { method: "POST", body: JSON.stringify({ name: "role-matrix" }) });
    assert.ok([201, 403].includes(denied.status));
    if (denied.status === 201) {
      const body = await denied.json() as { data: { track: { id: string } } };
      createdRoleTracks.push(body.data.track.id);
    }
  }
  const unsafe = await request(`/api/video-object-tracks/not-a-track`, ownerCookie, { method: "PATCH", body: JSON.stringify({ expectedTrackRevision: 1, assetId, datasetId, createdById: owner.id }) });
  assert.equal(unsafe.status, 400);
  for (const id of createdRoleTracks) {
    const track = await db.videoObjectTrack.findUnique({ where: { id }, select: { revision: true } });
    if (track) await request(`/api/video-object-tracks/${id}`, ownerCookie, { method: "DELETE", body: JSON.stringify({ expectedTrackRevision: track.revision }) });
  }
  const after = await Promise.all([
    db.videoObjectTrack.count(),
    db.annotation.count({ where: { assetId } }),
    db.job.count(),
    db.jobEvent.count(),
  ]);
  assert.deepEqual(after, before);
  assert.equal(JSON.stringify(await unsafe.json()).includes("Prisma"), false);
});

test("authenticated track/keyframe lifecycle uses track revision and rejects foreign access", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1 with PostgreSQL and a running web service." }, async () => {
  const providerBefore = await githubCounter();
  const created = await request(`/api/assets/${assetId}/video-object-tracks`, ownerCookie, { method: "POST", body: JSON.stringify({ labelId, name: "phase019 track" }) });
  assert.equal(created.status, 201);
  const createdBody = await created.json() as { data: { track: { id: string; revision: number } } };
  const track = createdBody.data.track;
  assert.equal(track.revision, 1);

  const keyframe = await request(`/api/video-object-tracks/${track.id}/keyframes`, ownerCookie, { method: "POST", body: JSON.stringify({ expectedTrackRevision: 1, timestampMs: 1000, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }) });
  assert.equal(keyframe.status, 201);
  const keyframeBody = await keyframe.json() as { data: { keyframe: { id: string }; track: { revision: number } } };
  assert.equal(keyframeBody.data.track.revision, 2);

  const updated = await request(`/api/video-keyframes/${keyframeBody.data.keyframe.id}`, ownerCookie, { method: "PATCH", body: JSON.stringify({ expectedTrackRevision: 2, timestampMs: 2000, geometry: { x: 0.2, y: 0.1, width: 0.2, height: 0.2 } }) });
  assert.equal(updated.status, 200);

  const stale = await request(`/api/video-keyframes/${keyframeBody.data.keyframe.id}`, ownerCookie, { method: "PATCH", body: JSON.stringify({ expectedTrackRevision: 2, geometry: { x: 0.3, y: 0.1, width: 0.2, height: 0.2 } }) });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as { error: { code: string } }).error.code, "VIDEO_TRACK_REVISION_CONFLICT");

  const duplicate = await request(`/api/video-object-tracks/${track.id}/keyframes`, ownerCookie, { method: "POST", body: JSON.stringify({ expectedTrackRevision: 3, timestampMs: 2000, geometry: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 } }) });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json() as { error: { code: string } }).error.code, "VIDEO_KEYFRAME_TIMESTAMP_CONFLICT");

  const beforeDenied = await Promise.all([
    db.videoObjectTrack.findUniqueOrThrow({ where: { id: track.id }, select: { revision: true } }),
    db.annotation.count({ where: { assetId } }),
    db.job.count(),
    db.jobEvent.count(),
  ]);
  const forbidden = await request(`/api/video-object-tracks/${track.id}/keyframes`, foreignCookie, { method: "POST", body: JSON.stringify({ expectedTrackRevision: 3, timestampMs: 3000, geometry: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 }, labelId, assetId, datasetId }) });
  assert.equal(forbidden.status, 400);
  assert.equal(JSON.stringify(await forbidden.json()).includes("VIDEO_TRACK_REVISION"), false);
  const afterDenied = await Promise.all([
    db.videoObjectTrack.findUniqueOrThrow({ where: { id: track.id }, select: { revision: true } }),
    db.annotation.count({ where: { assetId } }),
    db.job.count(),
    db.jobEvent.count(),
  ]);
  assert.deepEqual(afterDenied, beforeDenied);
  const providerAfter = await githubCounter();
  if (providerBefore !== null && providerAfter !== null) assert.equal(providerAfter, providerBefore, "manual video mutations must not call repository providers");
});

test("non-member, non-video, cross-dataset label, and cross-track keyframe denials are concealed without durable side effects", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1 with PostgreSQL and a running web service." }, async () => {
  const snapshot = async () => ({
    tracks: await db.videoObjectTrack.findMany({ select: { id: true, revision: true }, orderBy: { id: "asc" } }),
    annotations: await db.annotation.findMany({ where: { assetId }, select: { id: true, revision: true }, orderBy: { id: "asc" } }),
    jobs: await db.job.count(),
    events: await db.jobEvent.count(),
  });
  const before = await snapshot();
  const externalBefore = await externalSnapshot();
  const githubBefore = await githubCounter();
  const nonMember = await request(`/api/assets/${assetId}/video-object-tracks`, nonMemberCookie, { method: "POST", body: JSON.stringify({ name: "hidden" }) });
  assert.equal(nonMember.status, 404);
  const wrongModality = await request(`/api/assets/${imageAssetId}/video-object-tracks`, ownerCookie, { method: "POST", body: JSON.stringify({ name: "not-video" }) });
  assert.equal(wrongModality.status, 404);
  const crossLabel = await request(`/api/assets/${assetId}/video-object-tracks`, ownerCookie, { method: "POST", body: JSON.stringify({ name: "bad-label", labelId: foreignLabelId }) });
  assert.equal(crossLabel.status, 400);

  const created = await request(`/api/assets/${assetId}/video-object-tracks`, ownerCookie, { method: "POST", body: JSON.stringify({ name: "cross-track" }) });
  assert.equal(created.status, 201);
  const track = (await created.json() as { data: { track: { id: string } } }).data.track;
  const keyframe = await request(`/api/video-object-tracks/${track.id}/keyframes`, ownerCookie, { method: "POST", body: JSON.stringify({ expectedTrackRevision: 1, timestampMs: 1000, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }) });
  assert.equal(keyframe.status, 201);
  const keyframeId = (await keyframe.json() as { data: { keyframe: { id: string } } }).data.keyframe.id;
  const otherTrack = await request(`/api/assets/${assetId}/video-object-tracks`, ownerCookie, { method: "POST", body: JSON.stringify({ name: "other-track" }) });
  assert.equal(otherTrack.status, 201);
  const crossTrack = await request(`/api/video-keyframes/${keyframeId}`, nonMemberCookie, { method: "PATCH", body: JSON.stringify({ expectedTrackRevision: 2, timestampMs: 2000 }) });
  assert.equal(crossTrack.status, 404);
  for (const response of [nonMember, wrongModality, crossLabel, crossTrack]) {
    const text = JSON.stringify(await response.clone().json());
    assert.equal(/Prisma|postgres|stack|token|secret|storage/i.test(text), false);
  }
  await db.annotation.delete({ where: { id: keyframeId } });
  await db.videoObjectTrack.deleteMany({ where: { id: { in: [track.id, (await otherTrack.json() as { data: { track: { id: string } } }).data.track.id] } } });
  const after = await snapshot();
  assert.deepEqual(after, before);
  assert.deepEqual(await externalSnapshot(), externalBefore, "manual annotation denials must not mutate isolated Redis/BullMQ or MinIO");
  const githubAfter = await githubCounter();
  if (githubBefore !== null && githubAfter !== null) assert.equal(githubAfter, githubBefore, "manual annotation denials must not call GitHub");
});

test("approved Dataset roles govern Track and keyframe operations without creating asynchronous work", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1 with PostgreSQL and a running web service." }, async () => {
  const createTrack = async (cookie: string, name: string) => request(`/api/assets/${assetId}/video-object-tracks`, cookie, { method: "POST", body: JSON.stringify({ name }) });
  const before = { jobs: await db.job.count(), events: await db.jobEvent.count() };
  for (const [role, cookie] of [["owner", ownerCookie], ["manager", managerCookie], ["reviewer", reviewerCookie], ["labeler", labelerCookie]] as const) {
    const created = await createTrack(cookie, `role-${role}`);
    assert.equal(created.status, 201, `${role} has annotation.create`);
    const track = (await created.json() as { data: { track: { id: string; revision: number } } }).data.track;
    const update = await request(`/api/video-object-tracks/${track.id}`, cookie, { method: "PATCH", body: JSON.stringify({ expectedTrackRevision: track.revision, name: `${role}-updated` }) });
    assert.equal(update.status, role === "labeler" ? 403 : 200, `${role} updateAny policy`);
    const persisted = await db.videoObjectTrack.findUniqueOrThrow({ where: { id: track.id }, select: { revision: true } });
    const keyframe = await request(`/api/video-object-tracks/${track.id}/keyframes`, cookie, { method: "POST", body: JSON.stringify({ expectedTrackRevision: persisted.revision, timestampMs: 1000, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }) });
    assert.equal(keyframe.status, 201, `${role} has annotation.create`);
    const keyframeBody = await keyframe.json() as { data: { keyframe: { id: string }; track: { revision: number } } };
    const keyframeUpdate = await request(`/api/video-keyframes/${keyframeBody.data.keyframe.id}`, cookie, { method: "PATCH", body: JSON.stringify({ expectedTrackRevision: keyframeBody.data.track.revision, geometry: { x: 0.2, y: 0.1, width: 0.2, height: 0.2 } }) });
    assert.equal(keyframeUpdate.status, role === "labeler" ? 403 : 200, `${role} keyframe updateAny policy`);
    await db.annotation.delete({ where: { id: keyframeBody.data.keyframe.id } });
    await db.videoObjectTrack.delete({ where: { id: track.id } });
  }
  const unauthenticated = await fetch(`${baseUrl}/api/assets/${assetId}/video-object-tracks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "no-session" }) });
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual({ jobs: await db.job.count(), events: await db.jobEvent.count() }, before);
});

test("table-driven Track and keyframe validation matrix rejects untrusted or cross-resource input before a revision claim", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1 with PostgreSQL and a running web service." }, async () => {
  const snapshot = async () => ({
    tracks: await db.videoObjectTrack.findMany({ select: { id: true, revision: true }, orderBy: { id: "asc" } }),
    annotations: await db.annotation.findMany({ where: { assetId }, select: { id: true, revision: true }, orderBy: { id: "asc" } }),
    jobs: await db.job.count(), events: await db.jobEvent.count(),
  });
  const foreignAsset = await db.asset.create({ data: { datasetId: foreignDatasetId, modality: Modality.VIDEO, filename: `foreign-matrix-${suffix}.mp4`, mimeType: "video/mp4", durationMs: 1000, sourceFingerprint: `foreign-matrix-${suffix}` }, select: { id: true } });
  await db.videoAsset.create({ data: { assetId: foreignAsset.id } });
  const before = await snapshot();
  const createCases: Array<{ path: string; body: unknown; status: number }> = [
    { path: "/api/assets/not-an-asset/video-object-tracks", body: { name: "x" }, status: 404 },
    { path: `/api/assets/${randomBytes(8).toString("hex")}/video-object-tracks`, body: { name: "x" }, status: 404 },
    { path: `/api/assets/${foreignAsset.id}/video-object-tracks`, body: { name: "x" }, status: 404 },
    { path: `/api/assets/${assetId}/video-object-tracks`, body: { name: "x", labelId: "" }, status: 400 },
    { path: `/api/assets/${assetId}/video-object-tracks`, body: { name: "x", labelId: randomBytes(8).toString("hex") }, status: 400 },
    { path: `/api/assets/${assetId}/video-object-tracks`, body: { name: "x", createdById: owner.id }, status: 400 },
  ];
  for (const item of createCases) {
    const response = await request(item.path, ownerCookie, { method: "POST", body: JSON.stringify(item.body) });
    assert.equal(response.status, item.status);
    assert.equal(/VIDEO_TRACK_REVISION_CONFLICT|revision|geometry|duration/i.test(JSON.stringify(await response.clone().json())), false);
  }
  const trackResponse = await request(`/api/assets/${assetId}/video-object-tracks`, ownerCookie, { method: "POST", body: JSON.stringify({ name: "matrix-track" }) });
  assert.equal(trackResponse.status, 201);
  const track = (await trackResponse.json() as { data: { track: { id: string; revision: number } } }).data.track;
  const keyframeResponse = await request(`/api/video-object-tracks/${track.id}/keyframes`, ownerCookie, { method: "POST", body: JSON.stringify({ expectedTrackRevision: 1, timestampMs: 100, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }) });
  assert.equal(keyframeResponse.status, 201);
  const keyframe = (await keyframeResponse.json() as { data: { keyframe: { id: string }; track: { revision: number } } }).data;
  const keyframeCases: Array<{ path: string; body: unknown; status: number }> = [
    { path: "/api/video-object-tracks/not-a-track/keyframes", body: { expectedTrackRevision: 1, timestampMs: 1, geometry: { x: 0, y: 0, width: 0.2, height: 0.2 } }, status: 404 },
    { path: `/api/video-object-tracks/${track.id}/keyframes`, body: { expectedTrackRevision: "bad", timestampMs: 1, geometry: { x: 0, y: 0, width: 0.2, height: 0.2 } }, status: 400 },
    { path: `/api/video-object-tracks/${track.id}/keyframes`, body: { expectedTrackRevision: 2, timestampMs: -1, geometry: { x: 0, y: 0, width: 0.2, height: 0.2 } }, status: 400 },
    { path: `/api/video-object-tracks/${track.id}/keyframes`, body: { expectedTrackRevision: 2, timestampMs: 10_001, geometry: { x: 0, y: 0, width: 0.2, height: 0.2 } }, status: 400 },
    { path: `/api/video-object-tracks/${track.id}/keyframes`, body: { expectedTrackRevision: 2, frameIndex: 2, geometry: { x: 0, y: 0, width: 0.2, height: 0.2 } }, status: 400 },
    { path: `/api/video-object-tracks/${track.id}/keyframes`, body: { expectedTrackRevision: 2, timestampMs: 200, geometry: { x: 0.9, y: 0, width: 0.2, height: 0.2 } }, status: 400 },
    { path: `/api/video-object-tracks/${track.id}/keyframes`, body: { expectedTrackRevision: 2, timestampMs: 200, geometry: { x: 0, y: 0, width: 0.2, height: 0.2 }, assetId }, status: 400 },
    { path: `/api/video-keyframes/${keyframe.keyframe.id}`, body: { expectedTrackRevision: "bad", geometry: { x: 0, y: 0, width: 0.2, height: 0.2 } }, status: 400 },
    { path: `/api/video-keyframes/${keyframe.keyframe.id}`, body: { expectedTrackRevision: 2, geometry: { x: 0, y: 0, width: 0.2, height: 0.2 }, trackId: track.id }, status: 400 },
  ];
  for (const item of keyframeCases) {
    const method = item.path.includes("/video-keyframes/") ? "PATCH" : "POST";
    const response = await request(item.path, ownerCookie, { method, body: JSON.stringify(item.body) });
    assert.equal(response.status, item.status);
  }
  const afterDenials = await snapshot();
  assert.equal(afterDenials.tracks.find((row) => row.id === track.id)?.revision, 2);
  assert.equal(afterDenials.annotations.find((row) => row.id === keyframe.keyframe.id)?.revision, 1);
  await db.annotation.delete({ where: { id: keyframe.keyframe.id } });
  await db.videoObjectTrack.delete({ where: { id: track.id } });
  const afterCleanup = await snapshot();
  assert.deepEqual(afterCleanup, before);
});

test("Track and keyframe DELETE actor matrix is authorized, concealed for foreign/non-member, and safe against malformed or stale input", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1 with PostgreSQL and a running web service." }, async () => {
  const snapshot = async () => ({
    tracks: await db.videoObjectTrack.findMany({ select: { id: true, revision: true }, orderBy: { id: "asc" } }),
    annotations: await db.annotation.findMany({ where: { assetId }, select: { id: true, revision: true }, orderBy: { id: "asc" } }),
    jobs: await db.job.count(),
    events: await db.jobEvent.count(),
  });
  const makeTrackWithKeyframe = async (name: string) => {
    const created = await request(`/api/assets/${assetId}/video-object-tracks`, ownerCookie, { method: "POST", body: JSON.stringify({ name }) });
    assert.equal(created.status, 201);
    const track = (await created.json() as { data: { track: { id: string; revision: number } } }).data.track;
    const keyframe = await request(`/api/video-object-tracks/${track.id}/keyframes`, ownerCookie, { method: "POST", body: JSON.stringify({ expectedTrackRevision: track.revision, timestampMs: 1000, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }) });
    assert.equal(keyframe.status, 201);
    const body = await keyframe.json() as { data: { keyframe: { id: string }; track: { revision: number } } };
    return { trackId: track.id, keyframeId: body.data.keyframe.id, revision: body.data.track.revision };
  };

  // Owner/manager/reviewer may delete (annotation.updateAny); labeler may not.
  for (const [role, cookie] of [["owner", ownerCookie], ["manager", managerCookie], ["reviewer", reviewerCookie], ["labeler", labelerCookie]] as const) {
    const fixture = await makeTrackWithKeyframe(`delete-actor-${role}`);
    const keyframeDelete = await request(`/api/video-keyframes/${fixture.keyframeId}`, cookie, { method: "DELETE", body: JSON.stringify({ expectedTrackRevision: fixture.revision }) });
    assert.equal(keyframeDelete.status, role === "labeler" ? 403 : 200, `${role} keyframe DELETE policy`);
    const trackRevisionAfterKeyframe = role === "labeler" ? fixture.revision : (await db.videoObjectTrack.findUniqueOrThrow({ where: { id: fixture.trackId }, select: { revision: true } })).revision;
    const trackDelete = await request(`/api/video-object-tracks/${fixture.trackId}`, cookie, { method: "DELETE", body: JSON.stringify({ expectedTrackRevision: trackRevisionAfterKeyframe }) });
    assert.equal(trackDelete.status, role === "labeler" ? 403 : 200, `${role} track DELETE policy`);
    // Clean up whatever this role's denial left behind.
    await db.annotation.deleteMany({ where: { id: fixture.keyframeId } });
    await db.videoObjectTrack.deleteMany({ where: { id: fixture.trackId } });
  }

  // A user with no membership in this Dataset at all gets concealed 404s for
  // both keyframe and track DELETE, with no durable, queue, or provider side
  // effects. (`foreign` is a REVIEWER member of `datasetId` — see the
  // `before` fixture — so it is deliberately not used here; it is exercised
  // by the earlier role-matrix test instead.)
  const concealed = await makeTrackWithKeyframe("delete-concealed");
  const before = await snapshot();
  const githubBefore = await githubCounter();
  const nonMemberKeyframeDelete = await request(`/api/video-keyframes/${concealed.keyframeId}`, nonMemberCookie, { method: "DELETE", body: JSON.stringify({ expectedTrackRevision: concealed.revision }) });
  assert.equal(nonMemberKeyframeDelete.status, 404);
  const nonMemberTrackDelete = await request(`/api/video-object-tracks/${concealed.trackId}`, nonMemberCookie, { method: "DELETE", body: JSON.stringify({ expectedTrackRevision: concealed.revision }) });
  assert.equal(nonMemberTrackDelete.status, 404);
  for (const response of [nonMemberKeyframeDelete, nonMemberTrackDelete]) {
    const text = JSON.stringify(await response.clone().json());
    assert.equal(/Prisma|postgres|stack|token|secret|storage/i.test(text), false);
  }
  const afterConcealed = await snapshot();
  assert.deepEqual(afterConcealed, before);
  const githubAfterConcealed = await githubCounter();
  if (githubBefore !== null && githubAfterConcealed !== null) assert.equal(githubAfterConcealed, githubBefore, "concealed DELETE denials must not call GitHub");

  // Malformed/unknown IDs and a stale revision are all rejected before any
  // revision claim, leaving the fixture untouched.
  const malformedTrack = await request("/api/video-object-tracks/not-a-track-id", ownerCookie, { method: "DELETE", body: JSON.stringify({ expectedTrackRevision: concealed.revision }) });
  assert.equal(malformedTrack.status, 404);
  const unknownKeyframe = await request(`/api/video-keyframes/${randomBytes(8).toString("hex")}`, ownerCookie, { method: "DELETE", body: JSON.stringify({ expectedTrackRevision: 1 }) });
  assert.equal(unknownKeyframe.status, 404);
  const malformedBody = await request(`/api/video-object-tracks/${concealed.trackId}`, ownerCookie, { method: "DELETE", body: JSON.stringify({ expectedTrackRevision: "not-a-number" }) });
  assert.equal(malformedBody.status, 400);
  const staleTrackDelete = await request(`/api/video-object-tracks/${concealed.trackId}`, ownerCookie, { method: "DELETE", body: JSON.stringify({ expectedTrackRevision: concealed.revision + 5 }) });
  assert.equal(staleTrackDelete.status, 409);
  const afterStale = await snapshot();
  assert.deepEqual(afterStale, before);

  // Real deletes still work and are idempotent-safe (no double-decrement).
  const realKeyframeDelete = await request(`/api/video-keyframes/${concealed.keyframeId}`, ownerCookie, { method: "DELETE", body: JSON.stringify({ expectedTrackRevision: concealed.revision }) });
  assert.equal(realKeyframeDelete.status, 200);
  const trackAfterKeyframeDelete = await db.videoObjectTrack.findUniqueOrThrow({ where: { id: concealed.trackId }, select: { revision: true } });
  const realTrackDelete = await request(`/api/video-object-tracks/${concealed.trackId}`, ownerCookie, { method: "DELETE", body: JSON.stringify({ expectedTrackRevision: trackAfterKeyframeDelete.revision }) });
  assert.equal(realTrackDelete.status, 200);
  assert.equal(await db.videoObjectTrack.findUnique({ where: { id: concealed.trackId } }), null);
});
