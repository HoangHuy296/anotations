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

type Fixture = { user: { id: string; email: string }; datasetId: string; assetId: string; videoAssetId: string; cookie: string };

async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200);
  const value = /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(value);
  return `fieldframe_session=${value}`;
}

function request(path: string, cookie: string, init: RequestInit) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", Cookie: cookie, ...(init.headers ?? {}) } });
}

async function externalSnapshot() {
  if (!external) return null;
  const queue = createQueueTransport({ host: process.env.REDIS_HOST ?? "127.0.0.1", port: Number(process.env.REDIS_PORT ?? 6379), password: process.env.REDIS_PASSWORD ?? "", db: Number(process.env.REDIS_TEST_DB ?? 15), prefix: process.env.REDIS_TEST_PREFIX ?? "fieldframe-phase019-test", failFast: true });
  const { config, minio } = getDirectUploadProviders();
  try {
    const objects: string[] = [];
    for await (const object of minio.listObjectsV2(config.MINIO_BUCKET, "phase019-video/", true)) if (object.name) objects.push(object.name);
    return { queue: await queue.getJobCounts("wait", "active", "delayed", "completed", "failed"), objects: objects.sort() };
  } finally { await queue.close(); }
}

async function githubCounter() {
  if (!githubBase) return null;
  try {
    const response = await fetch(`${githubBase}/__test/counter`);
    const body = await response.json() as { requests?: unknown; count?: unknown };
    const count = body.requests ?? body.count;
    return response.ok && typeof count === "number" ? count : null;
  } catch { return null; }
}

function redacted(body: unknown) {
  const text = JSON.stringify(body).toLowerCase();
  for (const key of ["storagebucket", "storagekey", "token", "sourceconnection", "fieldframe_session", "authorization", "database_url", "redis_password", "prisma", "p2002", "postgres", "sql", "stack", "constraint"]) assert.equal(text.includes(key), false, `response leaked ${key}`);
}

async function fixture(): Promise<Fixture> {
  const marker = randomBytes(6).toString("hex");
  const user = await createAnnotationUser(UserRole.MANAGER);
  const dataset = await createAnnotationDataset(user.id);
  const asset = await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.VIDEO, filename: `kind-${marker}.mp4`, mimeType: "video/mp4", durationMs: 10_000, sourceFingerprint: `kind-${marker}` }, select: { id: true } });
  const videoAsset = await db.videoAsset.create({ data: { assetId: asset.id }, select: { id: true } });
  return { user, datasetId: dataset.id, assetId: asset.id, videoAssetId: videoAsset.id, cookie: await login(user.email) };
}

async function cleanup(value: Fixture) { await cleanupAnnotationFixture([value.user.id], [value.datasetId]); }
async function createTrack(value: Fixture) { return db.videoObjectTrack.create({ data: { videoAssetId: value.videoAssetId, createdById: value.user.id, annotationType: AnnotationType.BOUNDING_BOX, interpolationMode: "LINEAR" }, select: { id: true, revision: true } }); }
async function snapshot(annotationId: string, trackId?: string) {
  return {
    annotation: await db.annotation.findUnique({ where: { id: annotationId }, select: { id: true, revision: true, trackId: true, isKeyframe: true, isInterpolated: true, timestampMs: true, geometry: true, properties: true } }),
    track: trackId ? await db.videoObjectTrack.findUnique({ where: { id: trackId }, select: { id: true, revision: true } }) : null,
    annotations: await db.annotation.count(), jobs: await db.job.count(), events: await db.jobEvent.count(),
  };
}
async function invalidVideoAnnotation(value: Fixture, trackId: string | null, data: Partial<{ isKeyframe: boolean; isInterpolated: boolean; timestampMs: number | null; type: AnnotationType }> = {}) {
  return db.annotation.create({ data: { datasetId: value.datasetId, assetId: value.assetId, trackId, createdById: value.user.id, modality: Modality.VIDEO, type: data.type ?? AnnotationType.BOUNDING_BOX, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, properties: { fixture: true }, isKeyframe: data.isKeyframe ?? true, isInterpolated: data.isInterpolated ?? false, timestampMs: data.timestampMs === undefined ? 1000 : data.timestampMs }, select: { id: true } });
}

async function assertConcealed(value: Fixture, annotationId: string, trackId: string | undefined, method: "PATCH" | "DELETE") {
  const before = await snapshot(annotationId, trackId); const externalBefore = await externalSnapshot(); const providerBefore = await githubCounter();
  const response = await request(`/api/video-keyframes/${annotationId}`, value.cookie, { method, body: JSON.stringify(method === "PATCH" ? { expectedTrackRevision: 1, geometry: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 } } : { expectedTrackRevision: 1 }) });
  assert.equal(response.status, 404); const body = await response.json(); redacted(body); assert.equal(JSON.stringify(body).includes("VIDEO_TRACK_REVISION_CONFLICT"), false);
  assert.deepEqual(await snapshot(annotationId, trackId), before); assert.deepEqual(await externalSnapshot(), externalBefore);
  const providerAfter = await githubCounter(); if (providerBefore !== null && providerAfter !== null) assert.equal(providerAfter, providerBefore);
}

test("PATCH video keyframe conceals a VIDEO annotation without a Track", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1." }, async () => { const f = await fixture(); try { const row = await invalidVideoAnnotation(f, null); await assertConcealed(f, row.id, undefined, "PATCH"); } finally { await cleanup(f); } });
test("PATCH video keyframe conceals a Track-linked non-keyframe annotation", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1." }, async () => { const f = await fixture(); try { const track = await createTrack(f); const row = await invalidVideoAnnotation(f, track.id, { isKeyframe: false }); await assertConcealed(f, row.id, track.id, "PATCH"); } finally { await cleanup(f); } });
test("PATCH video keyframe conceals a persisted interpolated annotation", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1." }, async () => { const f = await fixture(); try { const track = await createTrack(f); const row = await invalidVideoAnnotation(f, track.id, { isInterpolated: true }); await assertConcealed(f, row.id, track.id, "PATCH"); } finally { await cleanup(f); } });
test("PATCH video keyframe conceals a keyframe without timestampMs", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1." }, async () => { const f = await fixture(); try { const track = await createTrack(f); const row = await invalidVideoAnnotation(f, track.id, { timestampMs: null }); await assertConcealed(f, row.id, track.id, "PATCH"); } finally { await cleanup(f); } });
test("DELETE video keyframe conceals persisted non-keyframe and interpolated fixtures", { skip: enabled ? false : "Set VIDEO_ANNOTATION_HTTP_TESTS=1." }, async () => { const f = await fixture(); try { const track = await createTrack(f); const nonKeyframe = await invalidVideoAnnotation(f, track.id, { isKeyframe: false }); const interpolated = await invalidVideoAnnotation(f, track.id, { isInterpolated: true, timestampMs: 2000 }); await assertConcealed(f, nonKeyframe.id, track.id, "DELETE"); await assertConcealed(f, interpolated.id, track.id, "DELETE"); } finally { await cleanup(f); } });
