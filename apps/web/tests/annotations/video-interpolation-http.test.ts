import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { Modality, UserRole } from "@internal/db";
import { db } from "@/lib/db";
import { cleanupAnnotationFixture, createAnnotationDataset, createAnnotationUser } from "../annotation-api/helpers";

/**
 * HTTP-level "Add Keyframe Here" coverage: the authenticated round trip from
 * a bounded interpolation read through to a single durable keyframe row, and
 * the duplicate-timestamp rejection at that exact derived position. Pure
 * interpolation math (midpoint determinism, boundaries, disabled mode) is
 * already covered by video-interpolation.test.ts; this file only proves the
 * HTTP surface and its persistence side effects.
 */
const enabled = process.env.VIDEO_INTERPOLATION_HTTP_TESTS === "1";
const baseUrl = process.env.VIDEO_ANNOTATION_HTTP_BASE_URL ?? "http://127.0.0.1:3000";
const password = "workspace-test-password";
const suffix = randomBytes(6).toString("hex");
let owner: { id: string; email: string };
let nonMember: { id: string; email: string };
let datasetId = "";
let assetId = "";
let ownerCookie = "";
let nonMemberCookie = "";

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

function request(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", Cookie: session, ...(init.headers ?? {}) } });
}

before(async () => {
  if (!enabled) return;
  owner = await createAnnotationUser(UserRole.MANAGER);
  nonMember = await createAnnotationUser(UserRole.LABELER);
  const dataset = await createAnnotationDataset(owner.id);
  datasetId = dataset.id;
  const asset = await db.asset.create({ data: { datasetId, modality: Modality.VIDEO, filename: `interp-http-${suffix}.mp4`, mimeType: "video/mp4", durationMs: 20_000, sourceFingerprint: `interp-http-${suffix}` }, select: { id: true } });
  assetId = asset.id;
  await db.videoAsset.create({ data: { assetId, fps: 25, totalFrames: 500 } });
  ownerCookie = await login(owner.email);
  nonMemberCookie = await login(nonMember.email);
});

after(async () => {
  if (!enabled) return;
  await cleanupAnnotationFixture([owner.id, nonMember.id], [datasetId]);
});

test("Add Keyframe Here persists exactly one row from a derived interpolation read, then drops out of the interpolation window", { skip: enabled ? false : "Set VIDEO_INTERPOLATION_HTTP_TESTS=1 with PostgreSQL and a running web service." }, async () => {
  const created = await request(`/api/assets/${assetId}/video-object-tracks`, ownerCookie, { method: "POST", body: JSON.stringify({ name: `add-keyframe-here-${suffix}` }) });
  assert.equal(created.status, 201);
  const track = (await created.json() as { data: { track: { id: string; revision: number } } }).data.track;

  const first = await request(`/api/video-object-tracks/${track.id}/keyframes`, ownerCookie, { method: "POST", body: JSON.stringify({ expectedTrackRevision: track.revision, timestampMs: 1_000, geometry: { kind: "BOUNDING_BOX", x: 0.1, y: 0.2, width: 0.2, height: 0.3 } }) });
  assert.equal(first.status, 201);
  const afterFirst = (await first.json() as { data: { track: { revision: number } } }).data.track;
  const second = await request(`/api/video-object-tracks/${track.id}/keyframes`, ownerCookie, { method: "POST", body: JSON.stringify({ expectedTrackRevision: afterFirst.revision, timestampMs: 3_000, geometry: { kind: "BOUNDING_BOX", x: 0.5, y: 0.4, width: 0.4, height: 0.2 } }) });
  assert.equal(second.status, 201);
  const afterSecond = (await second.json() as { data: { track: { revision: number } } }).data.track;

  // A bounded read at the exact midpoint returns a derived, non-persisted
  // preview: expected geometry from deriveInterpolationAt's own midpoint
  // fixture, and no annotation row exists at that timestamp yet.
  const derivedRead = await request(`/api/assets/${assetId}/video-annotations?fromMs=2000&toMs=2001`, ownerCookie);
  assert.equal(derivedRead.status, 200);
  const derivedBody = await derivedRead.json() as { data: { interpolation: Array<{ trackId: string; timestampMs: number; derived: boolean; kind: "BOUNDING_BOX"; x: number; y: number; width: number; height: number }> } };
  const derivedEntry = derivedBody.data.interpolation.find((item) => item.trackId === track.id);
  assert.ok(derivedEntry);
  assert.equal(derivedEntry.derived, true);
  assert.equal(derivedEntry.timestampMs, 2_000);
  assert.deepEqual({ x: derivedEntry.x, y: derivedEntry.y, width: derivedEntry.width, height: derivedEntry.height }, { x: 0.30000000000000004, y: 0.30000000000000004, width: 0.30000000000000004, height: 0.25 });
  const rowsBeforeCommit = await db.annotation.count({ where: { trackId: track.id, timestampMs: 2_000 } });
  assert.equal(rowsBeforeCommit, 0, "a derived read must never write a row");

  // Add Keyframe Here: persist that exact derived geometry as a real keyframe.
  const committed = await request(`/api/video-object-tracks/${track.id}/keyframes`, ownerCookie, { method: "POST", body: JSON.stringify({ expectedTrackRevision: afterSecond.revision, timestampMs: derivedEntry.timestampMs, geometry: { kind: derivedEntry.kind, x: derivedEntry.x, y: derivedEntry.y, width: derivedEntry.width, height: derivedEntry.height } }) });
  assert.equal(committed.status, 201);
  const rowsAfterCommit = await db.annotation.count({ where: { trackId: track.id, timestampMs: 2_000 } });
  assert.equal(rowsAfterCommit, 1, "Add Keyframe Here must create exactly one durable row");

  // The committed timestamp is now an exact keyframe and drops out of the
  // derived interpolation window entirely (never both at once).
  const afterCommitRead = await request(`/api/assets/${assetId}/video-annotations?fromMs=2000&toMs=2001`, ownerCookie);
  const afterCommitBody = await afterCommitRead.json() as { data: { interpolation: unknown[]; keyframes: Array<{ trackId: string; timestampMs: number }> } };
  assert.equal(afterCommitBody.data.interpolation.length, 0);
  assert.ok(afterCommitBody.data.keyframes.some((keyframe) => keyframe.trackId === track.id && keyframe.timestampMs === 2_000));

  await db.annotation.deleteMany({ where: { trackId: track.id } });
  await db.videoObjectTrack.deleteMany({ where: { id: track.id } });
});

test("a second Add Keyframe Here at the same derived timestamp is rejected as a duplicate with no new row and no revision advance", { skip: enabled ? false : "Set VIDEO_INTERPOLATION_HTTP_TESTS=1 with PostgreSQL and a running web service." }, async () => {
  const created = await request(`/api/assets/${assetId}/video-object-tracks`, ownerCookie, { method: "POST", body: JSON.stringify({ name: `duplicate-here-${suffix}` }) });
  assert.equal(created.status, 201);
  const track = (await created.json() as { data: { track: { id: string; revision: number } } }).data.track;
  const first = await request(`/api/video-object-tracks/${track.id}/keyframes`, ownerCookie, { method: "POST", body: JSON.stringify({ expectedTrackRevision: track.revision, timestampMs: 5_000, geometry: { kind: "BOUNDING_BOX", x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }) });
  assert.equal(first.status, 201);
  const revisionAfterFirst = (await first.json() as { data: { track: { revision: number } } }).data.track.revision;

  const before = { annotations: await db.annotation.count({ where: { trackId: track.id } }), revision: (await db.videoObjectTrack.findUniqueOrThrow({ where: { id: track.id }, select: { revision: true } })).revision };

  const duplicate = await request(`/api/video-object-tracks/${track.id}/keyframes`, ownerCookie, { method: "POST", body: JSON.stringify({ expectedTrackRevision: revisionAfterFirst, timestampMs: 5_000, geometry: { kind: "BOUNDING_BOX", x: 0.3, y: 0.3, width: 0.1, height: 0.1 } }) });
  assert.equal(duplicate.status, 409);
  const duplicateBody = await duplicate.json() as { error: { code: string } };
  assert.equal(duplicateBody.error.code, "VIDEO_KEYFRAME_TIMESTAMP_CONFLICT");

  const after = { annotations: await db.annotation.count({ where: { trackId: track.id } }), revision: (await db.videoObjectTrack.findUniqueOrThrow({ where: { id: track.id }, select: { revision: true } })).revision };
  assert.deepEqual(after, before, "a rejected duplicate timestamp must not create a row or advance the track revision");
  // The original geometry at that timestamp is untouched by the rejected attempt.
  const originalGeometry = await db.annotation.findFirst({ where: { trackId: track.id, timestampMs: 5_000 }, select: { geometry: true } });
  assert.deepEqual(originalGeometry?.geometry, { kind: "BOUNDING_BOX", x: 0.1, y: 0.1, width: 0.2, height: 0.2 });

  await db.annotation.deleteMany({ where: { trackId: track.id } });
  await db.videoObjectTrack.deleteMany({ where: { id: track.id } });
});

test("a non-member's interpolation-window read is concealed as 404", { skip: enabled ? false : "Set VIDEO_INTERPOLATION_HTTP_TESTS=1 with PostgreSQL and a running web service." }, async () => {
  const denied = await request(`/api/assets/${assetId}/video-annotations?fromMs=1000&toMs=2000`, nonMemberCookie);
  assert.equal(denied.status, 404);
  const text = JSON.stringify(await denied.clone().json());
  assert.equal(/Prisma|postgres|stack|token|secret|storage/i.test(text), false);
});
