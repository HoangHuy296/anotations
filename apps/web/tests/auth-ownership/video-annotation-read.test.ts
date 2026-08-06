import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { AnnotationSource, AnnotationStatus, AnnotationType, DatasetMemberRole, Modality, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { cleanupAnnotationFixture, createAnnotationDataset, createAnnotationUser } from "../annotation-api/helpers";

const enabled = process.env.VIDEO_ANNOTATION_READ_TESTS === "1";
const baseUrl = process.env.VIDEO_ANNOTATION_HTTP_BASE_URL ?? "http://127.0.0.1:3000";
const password = "workspace-test-password";
const suffix = randomBytes(6).toString("hex");
let owner: { id: string; email: string };
let member: { id: string; email: string };
let admin: { id: string; email: string };
let outsider: { id: string; email: string };
let datasetId = "";
let foreignDatasetId = "";
let videoAssetId = "";
let foreignVideoAssetId = "";
let ownerCookie = "";
let memberCookie = "";
let adminCookie = "";
let outsiderCookie = "";

function cookie(response: Response) {
  const value = /^fieldframe_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(value);
  return `fieldframe_session=${value}`;
}
async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200);
  return cookie(response);
}
function request(path: string, session?: string) {
  return fetch(`${baseUrl}${path}`, { headers: session ? { Cookie: session } : {} });
}
function assertRedacted(value: unknown) {
  const text = JSON.stringify(value).toLowerCase();
  for (const forbidden of ["storagekey", "storagebucket", "sourceconnection", "token", "password", "stack", "prisma", "database_url", "redis", "minio"]) assert.equal(text.includes(forbidden), false, `response leaked ${forbidden}`);
}
async function snapshot() {
  const [tracks, annotations, jobs, events] = await Promise.all([
    db.videoObjectTrack.findMany({ where: { videoAsset: { assetId: videoAssetId } }, select: { id: true, revision: true }, orderBy: { id: "asc" } }),
    db.annotation.findMany({ where: { assetId: videoAssetId }, select: { id: true, revision: true }, orderBy: { id: "asc" } }),
    db.job.count(), db.jobEvent.count(),
  ]);
  return { tracks, annotations, jobs, events };
}

before(async () => {
  if (!enabled) return;
  owner = await createAnnotationUser(UserRole.MANAGER);
  member = await createAnnotationUser(UserRole.LABELER);
  admin = await createAnnotationUser(UserRole.ADMIN);
  outsider = await createAnnotationUser(UserRole.MANAGER);
  const dataset = await createAnnotationDataset(owner.id);
  const foreign = await createAnnotationDataset(outsider.id);
  datasetId = dataset.id; foreignDatasetId = foreign.id;
  await db.datasetMember.create({ data: { datasetId, userId: member.id, role: DatasetMemberRole.LABELER } });
  const asset = await db.asset.create({ data: { datasetId, modality: Modality.VIDEO, filename: `read-${suffix}.mp4`, mimeType: "video/mp4", durationMs: 10_000, sourceFingerprint: `read-${suffix}` }, select: { id: true } });
  videoAssetId = asset.id;
  const videoAsset = await db.videoAsset.create({ data: { assetId: videoAssetId, fps: 25, totalFrames: 250 }, select: { id: true } });
  const foreignAsset = await db.asset.create({ data: { datasetId: foreignDatasetId, modality: Modality.VIDEO, filename: `foreign-${suffix}.mp4`, mimeType: "video/mp4", durationMs: 10_000, sourceFingerprint: `foreign-${suffix}` }, select: { id: true } });
  foreignVideoAssetId = foreignAsset.id;
  await db.videoAsset.create({ data: { assetId: foreignVideoAssetId } });
  const label = await db.label.create({ data: { datasetId, modality: Modality.VIDEO, name: `read-${suffix}`, normalizedName: `read-${suffix}`, color: "#38BDF8" }, select: { id: true } });
  const track = await db.videoObjectTrack.create({ data: { videoAssetId: videoAsset.id, labelId: label.id, createdById: owner.id, name: "read-track", annotationType: AnnotationType.BOUNDING_BOX, interpolationMode: "LINEAR" }, select: { id: true } });
  await db.annotation.createMany({ data: [
    { datasetId, assetId: videoAssetId, createdById: owner.id, labelId: label.id, modality: Modality.VIDEO, type: AnnotationType.BOUNDING_BOX, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, trackId: track.id, timestampMs: 1000, isKeyframe: true, isInterpolated: false },
    { datasetId, assetId: videoAssetId, createdById: owner.id, labelId: label.id, modality: Modality.VIDEO, type: AnnotationType.BOUNDING_BOX, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, trackId: track.id, timestampMs: 3000, isKeyframe: true, isInterpolated: false },
    { datasetId, assetId: videoAssetId, createdById: owner.id, labelId: label.id, modality: Modality.VIDEO, type: AnnotationType.EVENT, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: {}, startMs: 2000, endMs: 4000 },
  ] });
  ownerCookie = await login(owner.email); memberCookie = await login(member.email); adminCookie = await login(admin.email); outsiderCookie = await login(outsider.email);
});

after(async () => { if (enabled) await cleanupAnnotationFixture([owner.id, member.id, admin.id, outsider.id], [datasetId, foreignDatasetId]); });

test("authorized actors receive only safe persisted Video read data", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_TESTS=1 with PostgreSQL and web." }, async () => {
  for (const session of [ownerCookie, memberCookie, adminCookie]) {
    const response = await request(`/api/assets/${videoAssetId}/video-annotations`, session);
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { assetId: string; fps: number; tracks: unknown[]; keyframes: Array<{ timestampMs: number; revision: number }>; temporalLabels: unknown[] } };
    assert.equal(body.data.assetId, videoAssetId);
    assert.equal(body.data.fps, 25);
    assert.equal(body.data.tracks.length, 1);
    assert.deepEqual(body.data.keyframes.map((item) => item.timestampMs), [1000, 3000]);
    assert.equal(body.data.temporalLabels.length, 1);
    assertRedacted(body);
  }
});

test("foreign, malformed, unknown, and unauthenticated reads are concealed with no side effect", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_TESTS=1 with PostgreSQL and web." }, async () => {
  const before = await snapshot();
  const responses = await Promise.all([
    request(`/api/assets/${videoAssetId}/video-annotations`, outsiderCookie),
    request(`/api/assets/${foreignVideoAssetId}/video-annotations`, ownerCookie),
    request(`/api/assets/missing-${suffix}/video-annotations`, ownerCookie),
    request("/api/assets/not-a-valid-asset-id/video-annotations", ownerCookie),
    request(`/api/assets/${videoAssetId}/video-annotations`),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [404, 404, 404, 404, 401]);
  for (const response of responses) assertRedacted(await response.json());
  assert.deepEqual(await snapshot(), before);
});
