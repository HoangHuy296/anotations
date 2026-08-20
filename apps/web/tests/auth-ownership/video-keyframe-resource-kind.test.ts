import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { AnnotationSource, AnnotationStatus, AnnotationType, Modality, UserRole } from "@internal/db";
import { createQueueTransport } from "@annotationplatform/queue";

import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";
import { cleanupAnnotationFixture, createAnnotationDataset, createAnnotationUser } from "../annotation-api/helpers";

const enabled = process.env.VIDEO_ANNOTATION_HTTP_TESTS === "1";
const external = process.env.PHASE019_EXTERNAL_SIDE_EFFECT_TESTS === "1";
const baseUrl = process.env.VIDEO_ANNOTATION_HTTP_BASE_URL ?? "http://127.0.0.1:3000";
const password = "workspace-test-password";
const githubBase = process.env.GITHUB_FIXTURE_BASE_URL;

type Fixture = { owner: { id: string; email: string }; foreign: { id: string; email: string }; ownerCookie: string; datasetId: string; foreignDatasetId: string; assetId: string; foreignAssetId: string; videoAssetId: string; foreignVideoAssetId: string };

async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200);
  const token = /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token);
  return `fieldframe_session=${token}`;
}

function request(path: string, cookie: string, init: RequestInit) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", Cookie: cookie, ...(init.headers ?? {}) } });
}

async function githubCounter() {
  if (!githubBase) return null;
  try { const r = await fetch(`${githubBase}/__test/counter`); const body = await r.json() as { requests?: number }; return r.ok && typeof body.requests === "number" ? body.requests : null; } catch { return null; }
}

async function externalSnapshot() {
  if (!external) return null;
  const queue = createQueueTransport({ host: process.env.REDIS_HOST ?? "127.0.0.1", port: Number(process.env.REDIS_PORT ?? 6379), password: process.env.REDIS_PASSWORD ?? "", db: Number(process.env.REDIS_TEST_DB ?? 15), prefix: process.env.REDIS_TEST_PREFIX ?? "fieldframe-phase019-test", failFast: true });
  const { config, minio } = getDirectUploadProviders();
  try { const objects: string[] = []; for await (const item of minio.listObjectsV2(config.MINIO_BUCKET, "phase019-video/", true)) if (item.name) objects.push(item.name); return { queue: await queue.getJobCounts("wait", "active", "delayed", "completed", "failed"), objects: objects.sort() }; } finally { await queue.close(); }
}

function assertRedacted(payload: unknown) {
  const text = JSON.stringify(payload).toLowerCase();
  for (const value of ["storagebucket", "storagekey", "minio", "token", "sourceconnection", "fieldframe_session", "authorization", "database_url", "redis_password", "prisma", "p2002", "postgres", "sql", "stack", "constraint"]) assert.equal(text.includes(value), false, `response leaked ${value}`);
}

async function fixture(): Promise<Fixture> {
  const marker = randomBytes(6).toString("hex");
  const [owner, foreign] = await Promise.all([createAnnotationUser(UserRole.MANAGER), createAnnotationUser(UserRole.MANAGER)]);
  const [dataset, foreignDataset] = await Promise.all([createAnnotationDataset(owner.id), createAnnotationDataset(foreign.id)]);
  const [asset, foreignAsset] = await Promise.all([
    db.asset.create({ data: { datasetId: dataset.id, modality: Modality.VIDEO, filename: `a-${marker}.mp4`, mimeType: "video/mp4", durationMs: 10_000, sourceFingerprint: `a-${marker}` }, select: { id: true } }),
    db.asset.create({ data: { datasetId: foreignDataset.id, modality: Modality.VIDEO, filename: `b-${marker}.mp4`, mimeType: "video/mp4", durationMs: 10_000, sourceFingerprint: `b-${marker}` }, select: { id: true } }),
  ]);
  const [videoAsset, foreignVideoAsset, ownerCookie] = await Promise.all([
    db.videoAsset.create({ data: { assetId: asset.id }, select: { id: true } }), db.videoAsset.create({ data: { assetId: foreignAsset.id }, select: { id: true } }), login(owner.email),
  ]);
  return { owner, foreign, ownerCookie, datasetId: dataset.id, foreignDatasetId: foreignDataset.id, assetId: asset.id, foreignAssetId: foreignAsset.id, videoAssetId: videoAsset.id, foreignVideoAssetId: foreignVideoAsset.id };
}

async function clean(f: Fixture) { await cleanupAnnotationFixture([f.owner.id, f.foreign.id], [f.datasetId, f.foreignDatasetId]); }
async function track(videoAssetId: string, userId: string) { return db.videoObjectTrack.create({ data: { videoAssetId, createdById: userId, annotationType: AnnotationType.BOUNDING_BOX, interpolationMode: "LINEAR" }, select: { id: true, revision: true } }); }
async function keyframe(f: Fixture, id: string, datasetId = f.datasetId, assetId = f.assetId, timestampMs = 1000) { return db.annotation.create({ data: { datasetId, assetId, trackId: id, createdById: datasetId === f.datasetId ? f.owner.id : f.foreign.id, modality: Modality.VIDEO, type: AnnotationType.BOUNDING_BOX, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, properties: { fixture: true }, isKeyframe: true, isInterpolated: false, timestampMs }, select: { id: true, revision: true, geometry: true, timestampMs: true } }); }
async function snapshot(targetId?: string, trackId?: string) { return { target: targetId ? await db.annotation.findUnique({ where: { id: targetId }, select: { id: true, revision: true, type: true, geometry: true, properties: true, startMs: true, endMs: true, labelId: true, status: true, updatedAt: true } }) : null, track: trackId ? await db.videoObjectTrack.findUnique({ where: { id: trackId }, select: { id: true, revision: true } }) : null, annotations: await db.annotation.count(), jobs: await db.job.count(), events: await db.jobEvent.count() }; }

test("PATCH video keyframe conceals a temporal-label annotation and preserves it", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1." }, async () => {
  const f = await fixture(); try {
    const temporal = await db.annotation.create({ data: { datasetId: f.datasetId, assetId: f.assetId, createdById: f.owner.id, modality: Modality.VIDEO, type: AnnotationType.EVENT, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: {}, properties: { note: "keep" }, startMs: 100, endMs: 900, isKeyframe: false, isInterpolated: false }, select: { id: true } });
    const before = await snapshot(temporal.id); const ext = await externalSnapshot(); const provider = await githubCounter();
    const r = await request(`/api/video-keyframes/${temporal.id}`, f.ownerCookie, { method: "PATCH", body: JSON.stringify({ expectedTrackRevision: 1, geometry: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 } }) });
    assert.equal(r.status, 404); const body = await r.json(); assertRedacted(body); assert.equal(JSON.stringify(body).includes("VIDEO_TRACK_REVISION_CONFLICT"), false);
    assert.deepEqual(await snapshot(temporal.id), before); assert.deepEqual(await externalSnapshot(), ext); const after = await githubCounter(); if (provider !== null && after !== null) assert.equal(after, provider);
  } finally { await clean(f); }
});

test("DELETE video keyframe conceals a temporal-label annotation and does not delete it", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1." }, async () => {
  const f = await fixture(); try {
    const temporal = await db.annotation.create({ data: { datasetId: f.datasetId, assetId: f.assetId, createdById: f.owner.id, modality: Modality.VIDEO, type: AnnotationType.SCENE, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: {}, properties: { note: "keep" }, startMs: 100, endMs: 900, isKeyframe: false, isInterpolated: false }, select: { id: true } });
    const before = await snapshot(temporal.id); const ext = await externalSnapshot();
    const r = await request(`/api/video-keyframes/${temporal.id}`, f.ownerCookie, { method: "DELETE", body: JSON.stringify({ expectedTrackRevision: 1 }) });
    assert.equal(r.status, 404); assertRedacted(await r.json()); assert.deepEqual(await snapshot(temporal.id), before); assert.deepEqual(await externalSnapshot(), ext);
  } finally { await clean(f); }
});

test("PATCH video keyframe conceals an Image Annotation and preserves it", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1." }, async () => {
  const f = await fixture(); try {
    const image = await db.asset.create({ data: { datasetId: f.datasetId, modality: Modality.IMAGE, filename: "image.png", mimeType: "image/png", sourceFingerprint: randomBytes(5).toString("hex") }, select: { id: true } });
    const annotation = await db.annotation.create({ data: { datasetId: f.datasetId, assetId: image.id, createdById: f.owner.id, modality: Modality.IMAGE, type: AnnotationType.POINT, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: { px: 0.4, py: 0.4 }, properties: { keep: true } }, select: { id: true } });
    const before = await snapshot(annotation.id); const ext = await externalSnapshot();
    const r = await request(`/api/video-keyframes/${annotation.id}`, f.ownerCookie, { method: "PATCH", body: JSON.stringify({ expectedTrackRevision: 1, geometry: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 } }) });
    assert.equal(r.status, 404); assertRedacted(await r.json()); assert.deepEqual(await snapshot(annotation.id), before); assert.deepEqual(await externalSnapshot(), ext);
  } finally { await clean(f); }
});

test("DELETE video keyframe conceals an Image Annotation and does not delete it", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1." }, async () => {
  const f = await fixture(); try {
    const image = await db.asset.create({ data: { datasetId: f.datasetId, modality: Modality.IMAGE, filename: "image.png", mimeType: "image/png", sourceFingerprint: randomBytes(5).toString("hex") }, select: { id: true } });
    const annotation = await db.annotation.create({ data: { datasetId: f.datasetId, assetId: image.id, createdById: f.owner.id, modality: Modality.IMAGE, type: AnnotationType.POINT, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: { px: 0.4, py: 0.4 }, properties: { keep: true } }, select: { id: true } });
    const before = await snapshot(annotation.id); const ext = await externalSnapshot();
    const r = await request(`/api/video-keyframes/${annotation.id}`, f.ownerCookie, { method: "DELETE", body: JSON.stringify({ expectedTrackRevision: 1 }) });
    assert.equal(r.status, 404); assertRedacted(await r.json()); assert.deepEqual(await snapshot(annotation.id), before); assert.deepEqual(await externalSnapshot(), ext);
  } finally { await clean(f); }
});

test("PATCH video keyframe conceals a foreign Track keyframe before revision claim", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1." }, async () => {
  const f = await fixture(); try {
    const t = await track(f.foreignVideoAssetId, f.foreign.id); const k = await keyframe(f, t.id, f.foreignDatasetId, f.foreignAssetId);
    const before = await snapshot(k.id, t.id); const ext = await externalSnapshot(); const provider = await githubCounter();
    const r = await request(`/api/video-keyframes/${k.id}`, f.ownerCookie, { method: "PATCH", body: JSON.stringify({ expectedTrackRevision: t.revision, timestampMs: 2000 }) });
    assert.equal(r.status, 404); const body = await r.json(); assertRedacted(body); assert.equal(JSON.stringify(body).includes("VIDEO_TRACK_REVISION_CONFLICT"), false);
    assert.deepEqual(await snapshot(k.id, t.id), before); assert.deepEqual(await externalSnapshot(), ext); const after = await githubCounter(); if (provider !== null && after !== null) assert.equal(after, provider);
  } finally { await clean(f); }
});

test("DELETE video keyframe conceals a cross-Dataset keyframe and preserves the Track", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1." }, async () => {
  const f = await fixture(); try {
    const t = await track(f.foreignVideoAssetId, f.foreign.id); const k = await keyframe(f, t.id, f.foreignDatasetId, f.foreignAssetId);
    const before = await snapshot(k.id, t.id); const ext = await externalSnapshot();
    const r = await request(`/api/video-keyframes/${k.id}`, f.ownerCookie, { method: "DELETE", body: JSON.stringify({ expectedTrackRevision: t.revision }) });
    assert.equal(r.status, 404); const body = await r.json(); assertRedacted(body); assert.equal(JSON.stringify(body).includes("VIDEO_TRACK_REVISION_CONFLICT"), false);
    assert.deepEqual(await snapshot(k.id, t.id), before); assert.deepEqual(await externalSnapshot(), ext);
  } finally { await clean(f); }
});
