import { beforeEach, describe, expect, it } from "vitest";

import { resolveVideoKeyframeDisplayState } from "@/lib/workspace/video-keyframe-state";
import { useVideoAnnotationStore } from "@/stores/video-annotation-store";
import type { SafeVideoKeyframe, SafeVideoTrack } from "@/types/video-annotation";

/**
 * This project has no DOM-rendering test harness configured (no jsdom or
 * @testing-library/react dependency -- AGENTS.md requires explicit
 * permission before adding one), and every sibling workspace test for this
 * feature (video-autosave.vitest.spec.ts, video-temporal-boundary.vitest.spec.ts)
 * already established the pattern this file follows: exercise the pure
 * display-state logic and the Zustand store directly, the same state a
 * rendered VideoEngine/VideoTimeline would read from.
 */
describe("video keyframe display state", () => {
  it("reports persisted for an exact keyframe with no local edits", () => {
    expect(resolveVideoKeyframeDisplayState({ hasPersistedKeyframe: true, hasDerivedInterpolation: false, hasUnsavedDraft: false, mutationState: "idle" })).toBe("persisted");
  });

  it("reports derived for a purely interpolated position between two keyframes", () => {
    expect(resolveVideoKeyframeDisplayState({ hasPersistedKeyframe: false, hasDerivedInterpolation: true, hasUnsavedDraft: false, mutationState: "idle" })).toBe("derived");
  });

  it("reports none when neither a persisted keyframe nor a derived preview exists", () => {
    expect(resolveVideoKeyframeDisplayState({ hasPersistedKeyframe: false, hasDerivedInterpolation: false, hasUnsavedDraft: false, mutationState: "idle" })).toBe("none");
  });

  it("reports draft for an in-flight local edit, even over a persisted or derived value", () => {
    expect(resolveVideoKeyframeDisplayState({ hasPersistedKeyframe: true, hasDerivedInterpolation: false, hasUnsavedDraft: true, mutationState: "idle" })).toBe("draft");
    expect(resolveVideoKeyframeDisplayState({ hasPersistedKeyframe: false, hasDerivedInterpolation: true, hasUnsavedDraft: true, mutationState: "saving" })).toBe("draft");
  });

  it("reports saved once autosave completes and no further edit is pending", () => {
    expect(resolveVideoKeyframeDisplayState({ hasPersistedKeyframe: true, hasDerivedInterpolation: false, hasUnsavedDraft: false, mutationState: "saved" })).toBe("saved");
  });

  it("reports conflict above every other state, including a held draft", () => {
    expect(resolveVideoKeyframeDisplayState({ hasPersistedKeyframe: true, hasDerivedInterpolation: false, hasUnsavedDraft: true, mutationState: "conflict" })).toBe("conflict");
    expect(resolveVideoKeyframeDisplayState({ hasPersistedKeyframe: false, hasDerivedInterpolation: true, hasUnsavedDraft: false, mutationState: "conflict" })).toBe("conflict");
  });
});

describe("video annotation store state transitions", () => {
  beforeEach(() => {
    useVideoAnnotationStore.setState({ tracks: {}, keyframes: {}, mutationState: "idle", localDraft: null });
  });

  const track: SafeVideoTrack = { id: "track-a", videoAssetId: "video-asset-a", labelId: null, label: null, name: "Track A", annotationType: "BOUNDING_BOX", status: "DRAFT", properties: {}, revision: 1, interpolationMode: "LINEAR", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const keyframe: SafeVideoKeyframe = { id: "keyframe-a", trackId: "track-a", assetId: "asset-a", labelId: null, type: "BOUNDING_BOX", geometry: { kind: "BOUNDING_BOX", x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, properties: {}, revision: 1, timestampMs: 1000, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };

  it("moves from idle to saving to saved, and clears any prior draft on save", () => {
    useVideoAnnotationStore.getState().preserveConflict(keyframe);
    expect(useVideoAnnotationStore.getState().mutationState).toBe("conflict");
    expect(useVideoAnnotationStore.getState().localDraft).toEqual(keyframe);

    useVideoAnnotationStore.getState().beginSave();
    expect(useVideoAnnotationStore.getState().mutationState).toBe("saving");

    useVideoAnnotationStore.getState().markSaved(track, keyframe);
    expect(useVideoAnnotationStore.getState().mutationState).toBe("saved");
    expect(useVideoAnnotationStore.getState().localDraft).toBe(null);
    expect(useVideoAnnotationStore.getState().tracks[track.id]).toEqual(track);
    expect(useVideoAnnotationStore.getState().keyframes[keyframe.id]).toEqual(keyframe);
  });

  it("preserves the caller's local draft on conflict without discarding it, and clearDraft returns to idle", () => {
    useVideoAnnotationStore.getState().preserveConflict(keyframe);
    expect(useVideoAnnotationStore.getState().mutationState).toBe("conflict");
    expect(useVideoAnnotationStore.getState().localDraft).toEqual(keyframe);

    useVideoAnnotationStore.getState().clearDraft();
    expect(useVideoAnnotationStore.getState().mutationState).toBe("idle");
    expect(useVideoAnnotationStore.getState().localDraft).toBe(null);
  });

  it("resets mutationState to idle and drops all prior rows when a fresh read snapshot arrives", () => {
    useVideoAnnotationStore.getState().markError();
    expect(useVideoAnnotationStore.getState().mutationState).toBe("error");

    useVideoAnnotationStore.getState().setSnapshot([track], [keyframe]);
    expect(useVideoAnnotationStore.getState().mutationState).toBe("idle");
    expect(useVideoAnnotationStore.getState().tracks).toEqual({ [track.id]: track });
    expect(useVideoAnnotationStore.getState().keyframes).toEqual({ [keyframe.id]: keyframe });
  });
});
