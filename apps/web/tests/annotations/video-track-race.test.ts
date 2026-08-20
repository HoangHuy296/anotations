import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { AnnotationType, Modality, UserRole } from "@internal/db";
import { createQueueTransport } from "@annotationplatform/queue";
import { createVideoKeyframe, deleteVideoKeyframe, updateVideoKeyframe } from "@/lib/annotations/video-keyframe-service";
import { deleteVideoObjectTrack, updateVideoObjectTrack } from "@/lib/annotations/video-track-service";
import { db } from "@/lib/db";
import { getDirectUploadProviders } from "@/lib/providers";
import { createAnnotationDataset, createAnnotationUser } from "../annotation-api/helpers";

const enabled = process.env.VIDEO_ANNOTATION_RACE_TESTS === "1";
const suffix = randomBytes(6).toString("hex");
let userId = "";
let datasetId = "";
let assetId = "";
let trackId = "";
let sideEffectBefore: { jobs: number; events: number; queue?: Record<string, number>; objects?: string[] };
const actor = () => ({ id: userId, email: `race-${suffix}@test.invalid`, name: "race", role: UserRole.MANAGER });

function barrier(count: number) {
  let arrived = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    arrived += 1;
    if (arrived === count) release?.();
    await gate;
  };
}

async function externalSnapshot() {
  const snapshot: { jobs: number; events: number; queue?: Record<string, number>; objects?: string[] } = { jobs: await db.job.count(), events: await db.jobEvent.count() };
  if (process.env.QUEUE_INTEGRATION_TESTS === "1") {
    const queue = createQueueTransport({ host: process.env.REDIS_HOST ?? "127.0.0.1", port: Number(process.env.REDIS_PORT ?? 6379), password: process.env.REDIS_PASSWORD ?? "", db: Number(process.env.REDIS_TEST_DB ?? 15), prefix: process.env.REDIS_TEST_PREFIX ?? "fieldframe-phase019-test", failFast: true });
    try { snapshot.queue = await queue.getJobCounts("wait", "active", "delayed", "completed", "failed"); } finally { await queue.close(); }
  }
  if (process.env.MINIO_ENDPOINT) {
    const { config, minio } = getDirectUploadProviders();
    const objects: string[] = [];
    for await (const object of minio.listObjectsV2(config.MINIO_BUCKET, "phase019-video/", true)) if (object.name) objects.push(object.name);
    snapshot.objects = objects.sort();
  }
  return snapshot;
}

before(async () => {
  if (!enabled) return;
  const user = await createAnnotationUser(UserRole.MANAGER);
  userId = user.id;
  const dataset = await createAnnotationDataset(user.id);
  datasetId = dataset.id;
  const asset = await db.asset.create({ data: { datasetId, modality: Modality.VIDEO, filename: `race-${suffix}.mp4`, mimeType: "video/mp4", durationMs: 10_000, sourceFingerprint: `race-${suffix}` }, select: { id: true } });
  assetId = asset.id;
  const video = await db.videoAsset.create({ data: { assetId, fps: 25, totalFrames: 250 }, select: { id: true } });
  const label = await db.label.create({ data: { datasetId, modality: Modality.VIDEO, name: `race-${suffix}`, normalizedName: `race-${suffix}`, color: "#0EA5E9" }, select: { id: true } });
  const track = await db.videoObjectTrack.create({ data: { videoAssetId: video.id, labelId: label.id, createdById: user.id, annotationType: AnnotationType.BOUNDING_BOX, interpolationMode: "LINEAR" }, select: { id: true } });
  trackId = track.id;
  sideEffectBefore = await externalSnapshot();
});

after(async () => {
  if (!enabled) return;
  const sideEffectAfter = await externalSnapshot();
  assert.deepEqual(sideEffectAfter, sideEffectBefore, "manual video mutations must not create jobs, queue deliveries, or MinIO objects");
  await db.dataset.delete({ where: { id: datasetId } });
  await db.user.delete({ where: { id: userId } });
});

test("same-revision keyframe creates have one winner and one track conflict", { skip: enabled ? false : "Set VIDEO_ANNOTATION_RACE_TESTS=1 with controlled PostgreSQL." }, async () => {
  const actor = { id: userId, email: `race-${suffix}@test.invalid`, name: "race", role: UserRole.MANAGER };
  const release = barrier(2);
  const create = (timestampMs: number) => (async () => { await release(); return createVideoKeyframe(actor, trackId, { expectedTrackRevision: 1, timestampMs, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }); })();
  const [first, second] = await Promise.all([create(1000), create(2000)]);
  const results = [first, second];
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.reason === "CONFLICT").length, 1);
  assert.equal(await db.annotation.count({ where: { trackId } }), 1);
  assert.equal((await db.videoObjectTrack.findUniqueOrThrow({ where: { id: trackId }, select: { revision: true } })).revision, 2);
});

test("current revision duplicate timestamp maps safely and rolls back", { skip: enabled ? false : "Set VIDEO_ANNOTATION_RACE_TESTS=1 with controlled PostgreSQL." }, async () => {
  const before = await db.videoObjectTrack.findUniqueOrThrow({ where: { id: trackId }, select: { revision: true } });
  const existing = await db.annotation.findFirstOrThrow({ where: { trackId }, select: { timestampMs: true } });
  const result = await createVideoKeyframe(actor(), trackId, { expectedTrackRevision: before.revision, timestampMs: existing.timestampMs, geometry: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "DUPLICATE_TIMESTAMP");
  assert.equal((await db.videoObjectTrack.findUniqueOrThrow({ where: { id: trackId }, select: { revision: true } })).revision, before.revision);
  assert.equal(await db.annotation.count({ where: { trackId } }), 1);
});

async function createFreshTrack(name: string) {
  const track = await db.videoObjectTrack.create({ data: { videoAssetId: (await db.videoAsset.findUniqueOrThrow({ where: { assetId }, select: { id: true } })).id, labelId: (await db.label.findFirstOrThrow({ where: { datasetId }, select: { id: true } })).id, createdById: userId, name, annotationType: AnnotationType.BOUNDING_BOX, interpolationMode: "LINEAR" }, select: { id: true } });
  return track.id;
}

async function createKeyframe(track: string, timestampMs = 1000) {
  const result = await createVideoKeyframe(actor(), track, { expectedTrackRevision: 1, timestampMs, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("fixture keyframe failed");
  return result.value.keyframe.id;
}

test("same-track keyframe updates have one winner and one conflict", { skip: enabled ? false : "Set VIDEO_ANNOTATION_RACE_TESTS=1 with controlled PostgreSQL." }, async () => {
  const track = await createFreshTrack("update-race");
  const keyframe = await createKeyframe(track);
  const gate = barrier(2);
  const update = (x: number) => (async () => { await gate(); return updateVideoKeyframe(actor(), keyframe, { expectedTrackRevision: 2, geometry: { x, y: 0.1, width: 0.2, height: 0.2 } }); })();
  const results = await Promise.all([update(0.2), update(0.3)]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.reason === "CONFLICT").length, 1);
  assert.equal((await db.videoObjectTrack.findUniqueOrThrow({ where: { id: track }, select: { revision: true } })).revision, 3);
});

test("Track update versus delete has one atomic winner", { skip: enabled ? false : "Set VIDEO_ANNOTATION_RACE_TESTS=1 with controlled PostgreSQL." }, async () => {
  const track = await createFreshTrack("track-delete-race");
  const gate = barrier(2);
  const update = (async () => { await gate(); return updateVideoObjectTrack(actor(), track, { expectedTrackRevision: 1, name: "updated" }); })();
  const remove = (async () => { await gate(); return deleteVideoObjectTrack(actor(), track, 1); })();
  const results = await Promise.all([update, remove]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  const durable = await db.videoObjectTrack.findUnique({ where: { id: track }, select: { revision: true } });
  if (durable) assert.equal(durable.revision, 2);
});

test("Track A and Track B advance independently", { skip: enabled ? false : "Set VIDEO_ANNOTATION_RACE_TESTS=1 with controlled PostgreSQL." }, async () => {
  const [trackA, trackB] = await Promise.all([createFreshTrack("track-a"), createFreshTrack("track-b")]);
  const gate = barrier(2);
  const update = (track: string, name: string) => (async () => { await gate(); return updateVideoObjectTrack(actor(), track, { expectedTrackRevision: 1, name }); })();
  const [first, second] = await Promise.all([update(trackA, "a"), update(trackB, "b")]);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  const revisions = await db.videoObjectTrack.findMany({ where: { id: { in: [trackA, trackB] } }, select: { revision: true } });
  assert.deepEqual(revisions.map((row) => row.revision).sort(), [2, 2]);
});

test("keyframe create versus Track update has one winner", { skip: enabled ? false : "Set VIDEO_ANNOTATION_RACE_TESTS=1 with controlled PostgreSQL." }, async () => {
  const track = await createFreshTrack("create-update-race");
  const gate = barrier(2);
  const create = (async () => { await gate(); return createVideoKeyframe(actor(), track, { expectedTrackRevision: 1, timestampMs: 3000, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }); })();
  const update = (async () => { await gate(); return updateVideoObjectTrack(actor(), track, { expectedTrackRevision: 1, name: "track-updated" }); })();
  const results = await Promise.all([create, update]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.reason === "CONFLICT").length, 1);
  assert.equal((await db.videoObjectTrack.findUniqueOrThrow({ where: { id: track }, select: { revision: true } })).revision, 2);
});

test("keyframe delete versus update has one winner and no resurrection", { skip: enabled ? false : "Set VIDEO_ANNOTATION_RACE_TESTS=1 with controlled PostgreSQL." }, async () => {
  const track = await createFreshTrack("delete-update-race");
  const keyframe = await createKeyframe(track);
  const gate = barrier(2);
  const remove = (async () => { await gate(); return deleteVideoKeyframe(actor(), keyframe, 2); })();
  const update = (async () => { await gate(); return updateVideoKeyframe(actor(), keyframe, { expectedTrackRevision: 2, timestampMs: 4000, geometry: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 } }); })();
  const [removeResult, updateResult] = await Promise.all([remove, update]);
  const results = [removeResult, updateResult];
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(await db.annotation.count({ where: { id: keyframe } }), removeResult.ok ? 0 : 1);
});

test("Track delete versus keyframe create/update never leaves an orphan", { skip: enabled ? false : "Set VIDEO_ANNOTATION_RACE_TESTS=1 with controlled PostgreSQL." }, async () => {
  const createTrack = await createFreshTrack("delete-create-race");
  const gate = barrier(2);
  const remove = (async () => { await gate(); return deleteVideoObjectTrack(actor(), createTrack, 1); })();
  const create = (async () => { await gate(); return createVideoKeyframe(actor(), createTrack, { expectedTrackRevision: 1, timestampMs: 5000, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }); })();
  await Promise.all([remove, create]);
  const survivingTrack = await db.videoObjectTrack.findUnique({ where: { id: createTrack }, select: { id: true } });
  assert.equal(await db.annotation.count({ where: { trackId: createTrack } }), survivingTrack ? 1 : 0);
});

test("Track delete versus keyframe update has one terminal outcome", { skip: enabled ? false : "Set VIDEO_ANNOTATION_RACE_TESTS=1 with controlled PostgreSQL." }, async () => {
  const track = await createFreshTrack("delete-update-track-race");
  const keyframe = await createKeyframe(track);
  const gate = barrier(2);
  const remove = (async () => { await gate(); return deleteVideoObjectTrack(actor(), track, 2); })();
  const update = (async () => { await gate(); return updateVideoKeyframe(actor(), keyframe, { expectedTrackRevision: 2, timestampMs: 6000, geometry: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 } }); })();
  await Promise.all([remove, update]);
  const survivingTrack = await db.videoObjectTrack.findUnique({ where: { id: track }, select: { id: true } });
  assert.equal(await db.annotation.count({ where: { trackId: track } }), survivingTrack ? 1 : 0);
});

test("stale Track delete does not mutate Track or keyframes", { skip: enabled ? false : "Set VIDEO_ANNOTATION_RACE_TESTS=1 with controlled PostgreSQL." }, async () => {
  const track = await createFreshTrack("stale-delete");
  await updateVideoObjectTrack(actor(), track, { expectedTrackRevision: 1, name: "advanced" });
  const result = await deleteVideoObjectTrack(actor(), track, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "CONFLICT");
  assert.equal((await db.videoObjectTrack.findUniqueOrThrow({ where: { id: track }, select: { revision: true } })).revision, 2);
});

test("keyframe update/delete refuses a persisted row whose Asset does not match its Track's video Asset", { skip: enabled ? false : "Set VIDEO_ANNOTATION_RACE_TESTS=1 with controlled PostgreSQL." }, async () => {
  // This mismatch cannot occur through the normal API — every keyframe write
  // path derives assetId from the Track's own videoAsset relation. It can
  // only arise from a bug or a future direct-write path, so the service's
  // defensive `resolved.full.videoAsset.assetId !== annotation.assetId`
  // integrity check (video-keyframe-service.ts) is exercised here by
  // constructing that impossible state directly.
  const track = await createFreshTrack("mismatched-asset-integrity");
  const keyframeId = await createKeyframe(track);
  const otherAsset = await db.asset.create({ data: { datasetId, modality: Modality.VIDEO, filename: `race-mismatch-${suffix}.mp4`, mimeType: "video/mp4", durationMs: 5000, sourceFingerprint: `race-mismatch-${suffix}` }, select: { id: true } });
  await db.videoAsset.create({ data: { assetId: otherAsset.id, fps: 25, totalFrames: 100 } });
  await db.annotation.update({ where: { id: keyframeId }, data: { assetId: otherAsset.id } });
  const before = await db.videoObjectTrack.findUniqueOrThrow({ where: { id: track }, select: { revision: true } });

  const updateResult = await updateVideoKeyframe(actor(), keyframeId, { expectedTrackRevision: before.revision, timestampMs: 7000, geometry: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } });
  assert.equal(updateResult.ok, false);
  if (!updateResult.ok) assert.equal(updateResult.reason, "NOT_FOUND");
  const deleteResult = await deleteVideoKeyframe(actor(), keyframeId, before.revision);
  assert.equal(deleteResult.ok, false);
  if (!deleteResult.ok) assert.equal(deleteResult.reason, "NOT_FOUND");

  const after = await db.videoObjectTrack.findUniqueOrThrow({ where: { id: track }, select: { revision: true } });
  assert.equal(after.revision, before.revision, "a mismatched-Asset keyframe must not be able to claim a revision bump");
  assert.equal(await db.annotation.count({ where: { id: keyframeId } }), 1, "the mismatched row must be left exactly as-is, not deleted");
  await db.annotation.delete({ where: { id: keyframeId } });
  await db.asset.delete({ where: { id: otherAsset.id } });
});
