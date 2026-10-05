import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { useVideoAnnotationStore } from "@/stores/video-annotation-store";
import { readVideoAnnotationsClient } from "@/lib/workspace/video-annotation-client";
import type { SafeVideoAnnotations, SafeVideoKeyframe, SafeVideoTrack } from "@/types/video-annotation";

const track: SafeVideoTrack = { id: "ai-track", videoAssetId: "video", labelId: null, name: "AI track 1", label: null, annotationType: "BOUNDING_BOX", interpolationMode: "NONE", status: "DRAFT", revision: 1, properties: { aiTaskId: "task" }, createdAt: "", updatedAt: "" };
const frame: SafeVideoKeyframe = { id: "ai-frame", trackId: track.id, assetId: "asset", labelId: null, type: "BOUNDING_BOX", geometry: { kind: "BOUNDING_BOX", x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, properties: { aiTaskId: "task" }, timestampMs: 1806, revision: 1, createdAt: "", updatedAt: "" };

test("completed video AI results merge once while preserving local edits and conflict drafts", () => {
  const store = useVideoAnnotationStore.getState();
  const manual = { ...track, id: "manual-track", name: "Unsaved local name", properties: {} };
  store.setSnapshot([manual], []);
  store.preserveConflict(frame);
  store.mergeAiResults([track], [frame]);
  store.mergeAiResults([track], [frame]);
  assert.equal(useVideoAnnotationStore.getState().trackList.length, 2);
  assert.equal(useVideoAnnotationStore.getState().keyframeList.length, 1);
  assert.equal(useVideoAnnotationStore.getState().tracks[manual.id].name, manual.name);
  assert.equal(useVideoAnnotationStore.getState().mutationState, "conflict");
  assert.deepEqual(useVideoAnnotationStore.getState().localDraft, frame);
  store.mergeAiResults([{ ...track, name: "Stale name", revision: 0 }], [{ ...frame, revision: 0 }]);
  assert.equal(useVideoAnnotationStore.getState().tracks[track.id].name, track.name);
  assert.equal(useVideoAnnotationStore.getState().keyframes[frame.id].revision, 1);
  store.setSnapshot([], []); store.clearDraft();
});

test("video completion reloads through the same-origin authorized annotation route", async (t) => {
  // A single, already-complete page (`hasMore: false`) -- `readVideoAnnotationsClient`
  // follows `nextCursor` until `hasMore` is false (see video-read-service.ts's
  // cursor pagination) before resolving, so this must look like a real final page.
  const result: SafeVideoAnnotations = {
    assetId: "asset", fps: 29.907, durationMs: 28421, tracks: [track], keyframes: [frame], temporalLabels: [], interpolation: [],
    totalTracksInWindow: 1, totalKeyframesInWindow: 1, truncated: false, effectiveFromMs: 0, effectiveToMs: 30_000, nextCursor: null, hasMore: false,
  };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, "/api/assets/asset/video-annotations");
    assert.equal(init.credentials, "same-origin"); assert.equal(init.cache, "no-store");
    return Response.json({ data: result });
  });
  assert.deepEqual(await readVideoAnnotationsClient("asset"), result);
  assert.equal(calls, 1, "a single already-complete page must not trigger a second fetch");
});

test("readVideoAnnotationsClient follows every page before resolving, merges by id, and carries page 1's interpolation forward", async (t) => {
  const frame2: SafeVideoKeyframe = { ...frame, id: "ai-frame-2", timestampMs: 1900 };
  const page1: SafeVideoAnnotations = {
    assetId: "asset", fps: 29.907, durationMs: 28421, tracks: [track], keyframes: [frame], temporalLabels: [], interpolation: [{ kind: "BOUNDING_BOX", x: 0, y: 0, width: 0.1, height: 0.1, timestampMs: 0, trackId: track.id, derived: true }],
    totalTracksInWindow: 1, totalKeyframesInWindow: 2, truncated: true, effectiveFromMs: 0, effectiveToMs: 30_000, nextCursor: "1806:ai-frame", hasMore: true,
  };
  const page2: SafeVideoAnnotations = {
    assetId: "asset", fps: 29.907, durationMs: 28421, tracks: [track], keyframes: [frame2], temporalLabels: [], interpolation: [],
    totalTracksInWindow: 1, totalKeyframesInWindow: 2, truncated: false, effectiveFromMs: 0, effectiveToMs: 30_000, nextCursor: null, hasMore: false,
  };
  const requestedUrls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requestedUrls.push(url);
    return Response.json({ data: requestedUrls.length === 1 ? page1 : page2 });
  });
  const result = await readVideoAnnotationsClient("asset");
  assert.deepEqual(requestedUrls, ["/api/assets/asset/video-annotations", "/api/assets/asset/video-annotations?cursor=1806%3Aai-frame"]);
  assert.deepEqual(result.keyframes.map((k) => k.id).sort(), [frame.id, frame2.id]);
  assert.equal(result.tracks.length, 1, "the same track referenced on both pages must not be duplicated");
  assert.equal(result.hasMore, false);
  assert.equal(result.nextCursor, null);
  assert.deepEqual(result.interpolation, page1.interpolation, "interpolation is only meaningful from page 1 and must be carried forward, not overwritten by page 2's empty array");
});
