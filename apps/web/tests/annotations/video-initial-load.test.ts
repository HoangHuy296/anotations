import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { AnnotationSource, AnnotationStatus, AnnotationType, Modality, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { readWorkspaceSelection } from "@/lib/workspace/workspace-read";
import { VIDEO_ANNOTATION_LIMITS } from "@/lib/annotations/video-limits";
import { cleanupAnnotationFixture, createAnnotationDataset, createAnnotationUser } from "../annotation-api/helpers";

/**
 * Regression coverage for a real bug: AI-detect results anywhere past the
 * first 30s of a video vanished on reload, because `readWorkspaceSelection`
 * (the initial page-load path) always requested only the default
 * `[0, defaultWindowMs]` window, while the live "just ran AI-detect" display
 * (`VideoEngine.applyAiResults`) explicitly fetches the whole duration. See
 * `workspace-read.ts`'s VIDEO branch for the fix: eagerly fetch the full
 * known duration when it's both short enough (`maxWindowMs`) and not so
 * keyframe-dense (`clientCacheKeyframeCeiling`) that doing so would ship an
 * unbounded SSR payload -- the exact shape of the real dev asset this was
 * diagnosed against (a short test video reused across many AI-detect runs,
 * 200,000+ accumulated keyframes in under 80 real seconds of footage).
 */
const enabled = process.env.VIDEO_ANNOTATION_READ_MODEL_TESTS === "1";
const suffix = randomBytes(6).toString("hex");
let user: { id: string; role: UserRole; email: string; name: string };
let datasetId = "";

async function makeVideoAsset(name: string, durationMs: number, fps: number, totalFrames: number) {
  const asset = await db.asset.create({ data: { datasetId, modality: Modality.VIDEO, filename: `${name}-${suffix}.mp4`, mimeType: "video/mp4", durationMs, sourceFingerprint: `${name}-${suffix}` }, select: { id: true } });
  const video = await db.videoAsset.create({ data: { assetId: asset.id, fps, totalFrames }, select: { id: true } });
  return { assetId: asset.id, videoAssetId: video.id };
}

async function seedKeyframes(assetId: string, videoAssetId: string, spec: { timestampMs: number }[]) {
  const track = await db.videoObjectTrack.create({ data: { videoAssetId, createdById: user.id, name: "ai track", annotationType: AnnotationType.BOUNDING_BOX, interpolationMode: "NONE" }, select: { id: true } });
  const rows = spec.map((s) => ({
    datasetId, assetId, createdById: user.id, modality: Modality.VIDEO, type: AnnotationType.BOUNDING_BOX,
    source: AnnotationSource.AI, status: AnnotationStatus.DRAFT, geometry: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
    trackId: track.id, timestampMs: s.timestampMs, isKeyframe: true,
  }));
  for (let offset = 0; offset < rows.length; offset += 500) await db.annotation.createMany({ data: rows.slice(offset, offset + 500) });
  return track.id;
}

before(async () => {
  if (!enabled) return;
  const created = await createAnnotationUser(UserRole.MANAGER);
  user = { id: created.id, role: UserRole.MANAGER, email: created.email, name: created.name };
  const dataset = await createAnnotationDataset(user.id);
  datasetId = dataset.id;
});

after(async () => { if (enabled) await cleanupAnnotationFixture([user.id], [datasetId]); });

test("a short, realistically-sized video shows AI-detect keyframes past the default 30s window on initial load (the reported bug)", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const durationMs = 78_000; // similar to the real dev asset: ~78s, one AI run
  const { assetId, videoAssetId } = await makeVideoAsset("realistic-single-run", durationMs, 25, 1950);
  // Keyframes spread across the whole 78s, most of them past the old 30s default window.
  const timestamps = Array.from({ length: 3_000 }, (_, i) => ({ timestampMs: Math.floor((i / 3_000) * durationMs) }));
  await seedKeyframes(assetId, videoAssetId, timestamps);

  const selection = await readWorkspaceSelection(user, datasetId, assetId);
  assert.ok(selection && selection.engine === "VIDEO", "expected a VIDEO selection");
  if (!selection || selection.engine !== "VIDEO") return;

  assert.equal(selection.annotations.effectiveFromMs, 0);
  assert.equal(selection.annotations.effectiveToMs, durationMs, "initial load should widen to the full known duration, not stay capped at defaultWindowMs");
  assert.equal(selection.annotations.hasMore, false, "the merged initial read should not leave a dangling page");
  assert.equal(selection.annotations.keyframes.length, 3_000, "every keyframe across the whole video should be present on initial load, not just the first 30s");
  const pastDefaultWindow = selection.annotations.keyframes.filter((k) => k.timestampMs > VIDEO_ANNOTATION_LIMITS.defaultWindowMs);
  assert.ok(pastDefaultWindow.length > 0, "fixture sanity check: some keyframes must sit past the old 30s default window");
});

test("a short video with a pathological accumulation of keyframes (a heavily-reused fixture asset) safely falls back to the default window instead of an unbounded SSR fetch", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const durationMs = 78_000;
  const { assetId, videoAssetId } = await makeVideoAsset("pathological-reused", durationMs, 25, 1950);
  // More than clientCacheKeyframeCeiling within the full-duration window.
  const total = VIDEO_ANNOTATION_LIMITS.clientCacheKeyframeCeiling + 500;
  const timestamps = Array.from({ length: total }, (_, i) => ({ timestampMs: Math.floor((i / total) * durationMs) }));
  await seedKeyframes(assetId, videoAssetId, timestamps);

  const selection = await readWorkspaceSelection(user, datasetId, assetId);
  assert.ok(selection && selection.engine === "VIDEO");
  if (!selection || selection.engine !== "VIDEO") return;

  assert.equal(selection.annotations.effectiveToMs, VIDEO_ANNOTATION_LIMITS.defaultWindowMs, "an over-dense window must fall back to the original bounded default, not eagerly fetch everything");
  assert.equal(selection.annotations.hasMore, true, "an over-dense default window must honestly report more pages exist, not silently truncate");
  // A small amount of slack over keyframesPerPage is expected and correct:
  // `readVideoAnnotations` also attaches "boundary" rows (nearest keyframe
  // just outside the window) for interpolation context on straddling
  // tracks -- that's pre-existing, documented behavior this fix doesn't
  // touch, not evidence of an unbounded fetch.
  assert.ok(selection.annotations.keyframes.length <= VIDEO_ANNOTATION_LIMITS.keyframesPerPage + 10, "must stay near one page's bound, exactly like the pre-fix behavior -- not balloon to the full pathological count");
});

test("a video longer than maxWindowMs falls back to the default window regardless of density", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const durationMs = VIDEO_ANNOTATION_LIMITS.maxWindowMs + 60_000; // longer than the widen threshold
  const { assetId, videoAssetId } = await makeVideoAsset("too-long", durationMs, 25, Math.round((durationMs / 1000) * 25));
  await seedKeyframes(assetId, videoAssetId, [{ timestampMs: 1_000 }, { timestampMs: durationMs - 1_000 }]);

  const selection = await readWorkspaceSelection(user, datasetId, assetId);
  assert.ok(selection && selection.engine === "VIDEO");
  if (!selection || selection.engine !== "VIDEO") return;

  assert.equal(selection.annotations.effectiveToMs, VIDEO_ANNOTATION_LIMITS.defaultWindowMs, "a video longer than maxWindowMs must keep the original default-window behavior");
});

test("a video with unknown duration (fps/totalFrames/durationMs all null) falls back to the default window, unchanged from before the fix", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const asset = await db.asset.create({ data: { datasetId, modality: Modality.VIDEO, filename: `unknown-duration-${suffix}.mp4`, mimeType: "video/mp4", sourceFingerprint: `unknown-duration-${suffix}` }, select: { id: true } });
  const video = await db.videoAsset.create({ data: { assetId: asset.id }, select: { id: true } });
  // Two independent tracks, deliberately not straddling the window, so
  // boundary-context rows (pre-existing behavior) can't put the second
  // track's keyframe in the response for a reason unrelated to this fix.
  await seedKeyframes(asset.id, video.id, [{ timestampMs: 1_000 }]);
  await seedKeyframes(asset.id, video.id, [{ timestampMs: 50_000 }]);

  const selection = await readWorkspaceSelection(user, datasetId, asset.id);
  assert.ok(selection && selection.engine === "VIDEO");
  if (!selection || selection.engine !== "VIDEO") return;

  assert.equal(selection.annotations.effectiveToMs, VIDEO_ANNOTATION_LIMITS.defaultWindowMs);
  assert.equal(selection.annotations.keyframes.some((k) => k.timestampMs === 1_000), true, "the in-window keyframe must still be present");
  assert.equal(selection.annotations.keyframes.some((k) => k.timestampMs === 50_000), false, "a keyframe on an unrelated track entirely past the default window must not appear when duration is unknown");
});
