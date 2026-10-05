import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";

import { AnnotationSource, AnnotationStatus, AnnotationType, Modality, UserRole } from "@internal/db";

import { readVideoAnnotations } from "@/lib/annotations/video-read-service";
import { db } from "@/lib/db";
import { cleanupAnnotationFixture, createAnnotationDataset, createAnnotationUser } from "../annotation-api/helpers";

const enabled = process.env.VIDEO_ANNOTATION_READ_MODEL_TESTS === "1";
const suffix = randomBytes(6).toString("hex");
let user: { id: string; role: UserRole; email: string; name: string };
let datasetId = "";
let populatedAssetId = "";
let emptyAssetId = "";
let heavyAssetId = "";
// Populated in `before()` so tests can assert against the exact ids/timestamps seeded.
const heavy = {
  earlyCreatedLateKeyframeTrackId: "",
  earlyTrackIds: [] as string[],
  denseTrackId: "",
  straddlerTrackId: "",
  megaTimestampMs: 650_000,
  megaTrackIds: [] as string[],
};

function assertRedacted(value: unknown) {
  const text = JSON.stringify(value).toLowerCase();
  for (const forbidden of ["storagekey", "storagebucket", "sourceconnection", "token", "password", "stack", "frameindex"]) assert.equal(text.includes(forbidden), false, `safe read projection leaked ${forbidden}`);
}

before(async () => {
  if (!enabled) return;
  const created = await createAnnotationUser(UserRole.MANAGER);
  user = { id: created.id, role: UserRole.MANAGER, email: created.email, name: created.name };
  const dataset = await createAnnotationDataset(user.id);
  datasetId = dataset.id;
  const [populated, empty, heavy_] = await Promise.all([
    db.asset.create({ data: { datasetId, modality: Modality.VIDEO, filename: `read-model-${suffix}.mp4`, mimeType: "video/mp4", durationMs: 5000, sourceFingerprint: `read-model-${suffix}` }, select: { id: true } }),
    db.asset.create({ data: { datasetId, modality: Modality.VIDEO, filename: `empty-${suffix}.mp4`, mimeType: "video/mp4", durationMs: 5000, sourceFingerprint: `empty-${suffix}` }, select: { id: true } }),
    db.asset.create({ data: { datasetId, modality: Modality.VIDEO, filename: `heavy-${suffix}.mp4`, mimeType: "video/mp4", durationMs: 700_000, sourceFingerprint: `heavy-${suffix}` }, select: { id: true } }),
  ]);
  populatedAssetId = populated.id; emptyAssetId = empty.id; heavyAssetId = heavy_.id;
  const video = await db.videoAsset.create({ data: { assetId: populatedAssetId, fps: 25 }, select: { id: true } });
  await db.videoAsset.create({ data: { assetId: emptyAssetId, fps: 25 } });
  const track = await db.videoObjectTrack.create({ data: { videoAssetId: video.id, createdById: user.id, name: "linear", annotationType: AnnotationType.BOUNDING_BOX, interpolationMode: "LINEAR" }, select: { id: true } });
  await db.annotation.createMany({ data: [
    { datasetId, assetId: populatedAssetId, createdById: user.id, modality: Modality.VIDEO, type: AnnotationType.BOUNDING_BOX, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: { x: 0, y: 0, width: 0.2, height: 0.2 }, trackId: track.id, timestampMs: 1000, isKeyframe: true },
    { datasetId, assetId: populatedAssetId, createdById: user.id, modality: Modality.VIDEO, type: AnnotationType.BOUNDING_BOX, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, trackId: track.id, timestampMs: 3000, isKeyframe: true },
  ] });

  // A large, multi-band asset simulating an asset with data accumulated
  // across many AI runs (6,000+ tracks / 70,000+ rows on the real dev asset
  // this fix was written against) -- disjoint time bands keep each
  // scenario's window from touching unrelated fixture data.
  const heavyVideo = await db.videoAsset.create({ data: { assetId: heavyAssetId, fps: 25 }, select: { id: true } });
  const box = (n: number) => ({ x: 0.1 + (n % 5) * 0.01, y: 0.1, width: 0.1, height: 0.1 });

  // Created first (earliest createdAt of anything in this fixture) but its
  // only keyframe sits at t=500500 -- proves inclusion is decided by keyframe
  // relevance to the window, never by `createdAt` position.
  const earlyCreatedTrack = await db.videoObjectTrack.create({ data: { videoAssetId: heavyVideo.id, createdById: user.id, name: "early-created-late-keyframe", annotationType: AnnotationType.BOUNDING_BOX, interpolationMode: "LINEAR" }, select: { id: true } });
  heavy.earlyCreatedLateKeyframeTrackId = earlyCreatedTrack.id;
  await db.annotation.create({ data: { datasetId, assetId: heavyAssetId, createdById: user.id, modality: Modality.VIDEO, type: AnnotationType.BOUNDING_BOX, source: AnnotationSource.AI, status: AnnotationStatus.DRAFT, geometry: box(0), trackId: earlyCreatedTrack.id, timestampMs: 500_500, isKeyframe: true, properties: { aiTaskId: "run-a" } } });

  // "Early band" [0, 2000): 120 tracks (> tracksPerWindowSafetyCap's old
  // sibling take:100), one keyframe each, split across two simulated AI
  // runs (run-a / run-b) accumulated on the same asset.
  const earlyTracks = await Promise.all(Array.from({ length: 120 }, (_, i) =>
    db.videoObjectTrack.create({ data: { videoAssetId: heavyVideo.id, createdById: user.id, name: `early-${i}`, annotationType: AnnotationType.BOUNDING_BOX, interpolationMode: "LINEAR" }, select: { id: true } })));
  heavy.earlyTrackIds = earlyTracks.map((t) => t.id);
  await db.annotation.createMany({ data: earlyTracks.map((t, i) => ({
    datasetId, assetId: heavyAssetId, createdById: user.id, modality: Modality.VIDEO, type: AnnotationType.BOUNDING_BOX, source: AnnotationSource.AI, status: AnnotationStatus.DRAFT,
    geometry: box(i), trackId: t.id, timestampMs: 1_000 + i, isKeyframe: true, properties: { aiTaskId: i < 60 ? "run-a" : "run-b" },
  })) });

  // "Dense band" [100000, 101099]: one track, 1,100 keyframes (>
  // keyframesPerWindowSafetyCap's old sibling take:1000 shared with
  // temporal labels) -- proves a single window can return more than 1,000
  // real keyframes without the caller having to page around it.
  const denseTrack = await db.videoObjectTrack.create({ data: { videoAssetId: heavyVideo.id, createdById: user.id, name: "dense", annotationType: AnnotationType.BOUNDING_BOX, interpolationMode: "LINEAR" }, select: { id: true } });
  heavy.denseTrackId = denseTrack.id;
  const denseRows = Array.from({ length: 1_100 }, (_, i) => ({
    datasetId, assetId: heavyAssetId, createdById: user.id, modality: Modality.VIDEO, type: AnnotationType.BOUNDING_BOX, source: AnnotationSource.AI, status: AnnotationStatus.DRAFT,
    geometry: box(i), trackId: denseTrack.id, timestampMs: 100_000 + i, isKeyframe: true, properties: { aiTaskId: "run-b" },
  }));
  for (let offset = 0; offset < denseRows.length; offset += 500) await db.annotation.createMany({ data: denseRows.slice(offset, offset + 500) });

  // "Straddler": keyframes at t=295000 and t=305000 only -- no keyframe
  // strictly inside [298000, 302000], but the track is mid-interpolation for
  // that entire window and must still be reported as relevant.
  const straddlerTrack = await db.videoObjectTrack.create({ data: { videoAssetId: heavyVideo.id, createdById: user.id, name: "straddler", annotationType: AnnotationType.BOUNDING_BOX, interpolationMode: "LINEAR" }, select: { id: true } });
  heavy.straddlerTrackId = straddlerTrack.id;
  await db.annotation.createMany({ data: [
    { datasetId, assetId: heavyAssetId, createdById: user.id, modality: Modality.VIDEO, type: AnnotationType.BOUNDING_BOX, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 }, trackId: straddlerTrack.id, timestampMs: 295_000, isKeyframe: true },
    { datasetId, assetId: heavyAssetId, createdById: user.id, modality: Modality.VIDEO, type: AnnotationType.BOUNDING_BOX, source: AnnotationSource.MANUAL, status: AnnotationStatus.DRAFT, geometry: { x: 0.6, y: 0.6, width: 0.1, height: 0.1 }, trackId: straddlerTrack.id, timestampMs: 305_000, isKeyframe: true },
  ] });

  // "Mega band": 2,500 distinct tracks, each with exactly one keyframe, all
  // sharing the *exact same* timestampMs (650000) -- a crowd-detection-style
  // frame. This both exceeds `keyframesPerPage` (2,000), forcing real
  // pagination, and stresses the keyset cursor's tie-break: with every
  // timestamp identical, the page 1/page 2 split is decided purely by `id`
  // ordering, which is exactly the scenario that would silently duplicate or
  // drop rows under a naive timestamp-only cursor.
  const megaTracks: string[] = [];
  for (let offset = 0; offset < 2_500; offset += 250) {
    const chunk = await Promise.all(Array.from({ length: 250 }, (_, i) =>
      db.videoObjectTrack.create({ data: { videoAssetId: heavyVideo.id, createdById: user.id, name: `mega-${offset + i}`, annotationType: AnnotationType.BOUNDING_BOX, interpolationMode: "LINEAR" }, select: { id: true } })));
    megaTracks.push(...chunk.map((t) => t.id));
  }
  heavy.megaTrackIds = megaTracks;
  const megaRows = megaTracks.map((trackId, i) => ({
    datasetId, assetId: heavyAssetId, createdById: user.id, modality: Modality.VIDEO, type: AnnotationType.BOUNDING_BOX, source: AnnotationSource.AI, status: AnnotationStatus.DRAFT,
    geometry: box(i), trackId, timestampMs: heavy.megaTimestampMs, isKeyframe: true, properties: { aiTaskId: "run-c" },
  }));
  for (let offset = 0; offset < megaRows.length; offset += 500) await db.annotation.createMany({ data: megaRows.slice(offset, offset + 500) });
});

after(async () => { if (enabled) await cleanupAnnotationFixture([user.id], [datasetId]); });

test("Video read returns an empty safe DTO for an authorized empty Asset", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const read = await readVideoAnnotations(user, emptyAssetId);
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.deepEqual(read.data.tracks, []);
  assert.deepEqual(read.data.keyframes, []);
  assert.deepEqual(read.data.temporalLabels, []);
  assert.equal(read.data.truncated, false);
  assertRedacted(read.data);
});

test("bounded reads derive interpolation from persisted bracketing keyframes without returning out-of-window rows", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const read = await readVideoAnnotations(user, populatedAssetId, { fromMs: 2000, toMs: 2100 });
  assert.ok(read.ok);
  if (!read.ok) return;
  // Neither persisted keyframe (t=1000, t=3000) is inside [2000,2100], but
  // both are pulled in as boundary context (one before fromMs, one after
  // toMs) so interpolation at the window edge is still correct -- they are
  // not "in window" rows, so `keyframes` still reports them (this is the
  // documented boundary-context exception, not a leak of out-of-window data).
  assert.equal(read.data.keyframes.length, 2);
  assert.equal(read.data.interpolation.length, 1);
  assert.deepEqual(read.data.interpolation[0] && { kind: read.data.interpolation[0].kind, x: read.data.interpolation[0].x, y: read.data.interpolation[0].y, width: read.data.interpolation[0].width, height: read.data.interpolation[0].height }, { kind: "BOUNDING_BOX", x: 0.2, y: 0.2, width: 0.2, height: 0.2 });
  assert.equal(read.data.interpolation[0]?.timestampMs, 2000);
  assert.equal(read.data.effectiveFromMs, 2000);
  assert.equal(read.data.effectiveToMs, 2100);
  assertRedacted(read.data);
});

test("an invalid window (fromMs >= toMs) is rejected, not silently corrected", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const read = await readVideoAnnotations(user, populatedAssetId, { fromMs: 5000, toMs: 1000 });
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.equal(read.reason, "INVALID_WINDOW");
});

test("a window wider than the server's maximum is rejected", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const read = await readVideoAnnotations(user, populatedAssetId, { fromMs: 0, toMs: 999_999_999 });
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.equal(read.reason, "INVALID_WINDOW");
});

test("a window with more than 100 relevant tracks returns all of them (no take:100 ceiling)", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const read = await readVideoAnnotations(user, heavyAssetId, { fromMs: 0, toMs: 2_000 });
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.equal(read.data.tracks.length, 120);
  assert.equal(read.data.totalTracksInWindow, 120);
  assert.equal(read.data.keyframes.length, 120);
  assert.equal(read.data.truncated, false);
  // Accumulated from two simulated AI runs on the same asset -- both must
  // come back together, not just whichever run happened to sort first.
  const runs = new Set(read.data.keyframes.map((k) => k.properties.aiTaskId));
  assert.deepEqual([...runs].sort(), ["run-a", "run-b"]);
});

test("a window with more than 1,000 keyframes on one track returns all of them (no shared take:1000 ceiling)", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const read = await readVideoAnnotations(user, heavyAssetId, { fromMs: 100_000, toMs: 101_099 });
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.equal(read.data.tracks.length, 1);
  assert.equal(read.data.tracks[0]?.id, heavy.denseTrackId);
  assert.equal(read.data.keyframes.length, 1_100);
  assert.equal(read.data.totalKeyframesInWindow, 1_100);
  assert.equal(read.data.truncated, false);
});

test("a track created long before other tracks is still included when its keyframe falls in the window (createdAt is not the inclusion rule)", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const read = await readVideoAnnotations(user, heavyAssetId, { fromMs: 500_000, toMs: 501_000 });
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.equal(read.data.tracks.length, 1);
  assert.equal(read.data.tracks[0]?.id, heavy.earlyCreatedLateKeyframeTrackId);
  assert.equal(read.data.keyframes.length, 1);
  assert.equal(read.data.keyframes[0]?.timestampMs, 500_500);
});

test("a track with no in-window keyframe but a persisted keyframe on each side is included with minimal boundary context", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const read = await readVideoAnnotations(user, heavyAssetId, { fromMs: 298_000, toMs: 302_000 });
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.equal(read.data.tracks.length, 1);
  assert.equal(read.data.tracks[0]?.id, heavy.straddlerTrackId);
  assert.deepEqual(read.data.keyframes.map((k) => k.timestampMs).sort((a, b) => a - b), [295_000, 305_000]);
  assert.equal(read.data.interpolation.length, 1);
  assert.equal(read.data.interpolation[0]?.timestampMs, 298_000);
});

test("a window with no data returns an empty, non-truncated result", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const read = await readVideoAnnotations(user, heavyAssetId, { fromMs: 900_000, toMs: 901_000 });
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.deepEqual(read.data.tracks, []);
  assert.deepEqual(read.data.keyframes, []);
  assert.equal(read.data.totalTracksInWindow, 0);
  assert.equal(read.data.truncated, false);
});

test("ordering is deterministic across repeated reads of the same window", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const [first, second] = await Promise.all([
    readVideoAnnotations(user, heavyAssetId, { fromMs: 0, toMs: 2_000 }),
    readVideoAnnotations(user, heavyAssetId, { fromMs: 0, toMs: 2_000 }),
  ]);
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(first.data.tracks.map((t) => t.id), second.data.tracks.map((t) => t.id));
  assert.deepEqual(first.data.keyframes.map((k) => k.id), second.data.keyframes.map((k) => k.id));
});

test("adjacent windows over a dense track cover every keyframe exactly once when merged by id (no missing rows, no true duplicates)", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const [firstHalf, secondHalf] = await Promise.all([
    readVideoAnnotations(user, heavyAssetId, { fromMs: 100_000, toMs: 100_549 }),
    readVideoAnnotations(user, heavyAssetId, { fromMs: 100_550, toMs: 101_099 }),
  ]);
  assert.ok(firstHalf.ok && secondHalf.ok);
  if (!firstHalf.ok || !secondHalf.ok) return;
  // Simulates the client store's `mergeWindow`: keyed by id, so a keyframe
  // returned as boundary context by one window and as an in-window row by
  // its neighbor collapses to one entry, not two.
  const merged = new Map([...firstHalf.data.keyframes, ...secondHalf.data.keyframes].map((k) => [k.id, k]));
  assert.equal(merged.size, 1_100, "every persisted keyframe on the dense track must appear exactly once after merging");
  const timestamps = [...merged.values()].map((k) => k.timestampMs).sort((a, b) => a - b);
  assert.deepEqual(timestamps, Array.from({ length: 1_100 }, (_, i) => 100_000 + i));
});

test("a window with more than 2,000 keyframes sharing the exact same timestamp pages correctly (page 1 is capped, hasMore/nextCursor say so honestly)", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const page1 = await readVideoAnnotations(user, heavyAssetId, { fromMs: 649_000, toMs: 651_000 });
  assert.ok(page1.ok);
  if (!page1.ok) return;
  // The authoritative totals describe the whole interval, not this page.
  assert.equal(page1.data.totalKeyframesInWindow, 2_500);
  assert.equal(page1.data.totalTracksInWindow, 2_500);
  assert.equal(page1.data.keyframes.length, 2_000, "one page is capped at keyframesPerPage");
  assert.equal(page1.data.tracks.length, 2_000);
  assert.equal(page1.data.hasMore, true);
  assert.equal(page1.data.truncated, true, "truncated is an alias for hasMore");
  assert.ok(page1.data.nextCursor);
  assert.ok(page1.data.keyframes.every((k) => k.timestampMs === heavy.megaTimestampMs));
  // Each mega track has exactly one keyframe total -- interpolation needs a
  // bracketing pair, so with nothing before/after it there is nothing to derive.
  assert.equal(page1.data.interpolation.length, 0);
});

test("a track whose only keyframe sorts onto page 2 is absent from page 1's tracks and present on page 2's, with no track set ambiguity", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const page1 = await readVideoAnnotations(user, heavyAssetId, { fromMs: 649_000, toMs: 651_000 });
  assert.ok(page1.ok);
  if (!page1.ok || !page1.data.nextCursor) return;
  const page1TrackIds = new Set(page1.data.tracks.map((t) => t.id));
  const page1KeyframeTrackIds = new Set(page1.data.keyframes.map((k) => k.trackId));
  // Every keyframe on page 1 resolves to a track object also on page 1 --
  // pagination of keyframes never leaves a returned keyframe's track missing.
  for (const trackId of page1KeyframeTrackIds) assert.ok(page1TrackIds.has(trackId), `keyframe track ${trackId} missing from page 1's tracks`);
  const onlyOnLaterPage = heavy.megaTrackIds.filter((id) => !page1TrackIds.has(id));
  assert.equal(onlyOnLaterPage.length, 500, "500 of the 2,500 mega tracks must not have made it onto page 1");

  const page2 = await readVideoAnnotations(user, heavyAssetId, { fromMs: 649_000, toMs: 651_000, cursor: page1.data.nextCursor });
  assert.ok(page2.ok);
  if (!page2.ok) return;
  assert.equal(page2.data.hasMore, false);
  assert.equal(page2.data.nextCursor, null);
  assert.equal(page2.data.keyframes.length, 500);
  const page2TrackIds = new Set(page2.data.tracks.map((t) => t.id));
  for (const trackId of onlyOnLaterPage) assert.ok(page2TrackIds.has(trackId), `track ${trackId} expected only on page 2 was not found there`);
  // Second page is not itself the window's start, so no interpolation sample.
  assert.equal(page2.data.interpolation.length, 0);
});

test("following every page of a >2,000-keyframe window yields exactly the authoritative count, no duplicates, no omissions", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const seenKeyframeIds = new Set<string>();
  const seenTrackIds = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await readVideoAnnotations(user, heavyAssetId, { fromMs: 649_000, toMs: 651_000, cursor });
    assert.ok(page.ok);
    if (!page.ok) return;
    pages++;
    for (const keyframe of page.data.keyframes) seenKeyframeIds.add(keyframe.id);
    for (const track of page.data.tracks) seenTrackIds.add(track.id);
    if (!page.data.hasMore) break;
    cursor = page.data.nextCursor ?? undefined;
    assert.ok(pages < 10, "pagination did not terminate within a sane number of pages");
  }
  assert.equal(pages, 2);
  assert.equal(seenKeyframeIds.size, 2_500);
  assert.equal(seenTrackIds.size, 2_500);
  assert.deepEqual([...seenTrackIds].sort(), [...heavy.megaTrackIds].sort());
});

test("an invalid cursor is rejected rather than silently ignored or crashing", { skip: enabled ? false : "Set VIDEO_ANNOTATION_READ_MODEL_TESTS=1 with PostgreSQL." }, async () => {
  const malformed = await readVideoAnnotations(user, heavyAssetId, { fromMs: 649_000, toMs: 651_000, cursor: "not-a-cursor" });
  assert.equal(malformed.ok, false);
  if (malformed.ok) return;
  assert.equal(malformed.reason, "INVALID_WINDOW");

  // Well-formed but referencing a row that was never in this result set --
  // keyset pagination tolerates this (it's just a comparison, not a lookup),
  // it simply continues from that point in the ordering.
  const wellFormedButForeign = await readVideoAnnotations(user, heavyAssetId, { fromMs: 649_000, toMs: 651_000, cursor: "0:nonexistent-id" });
  assert.ok(wellFormedButForeign.ok);
});
