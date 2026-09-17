"use client";

import { create } from "zustand";
import type { SafeVideoKeyframe, SafeVideoTrack } from "@/types/video-annotation";
import type { VideoAnnotationTool } from "@/types/annotation";

type VideoMutationState = "idle" | "saving" | "saved" | "conflict" | "error";

type VideoAnnotationState = {
  tracks: Record<string, SafeVideoTrack>;
  keyframes: Record<string, SafeVideoKeyframe>;
  /**
   * Ordered-array mirrors of `tracks`/`keyframes`, kept in sync by every
   * mutator below. `video-engine.tsx` reads these directly via plain
   * selectors (`useVideoAnnotationStore((state) => state.trackList)`) instead
   * of deriving them with `Object.values(...)` on every render -- the
   * derivation happens once, here, at the moment of mutation. This is also
   * what makes a track/keyframe created this session show up immediately
   * (on the frame overlay, the toolbar, the timeline) without a page reload:
   * those consumers no longer depend on the server-rendered `annotations`
   * prop, which never refetches after a mutation.
   */
  trackList: SafeVideoTrack[];
  keyframeList: SafeVideoKeyframe[];
  mutationState: VideoMutationState;
  localDraft: SafeVideoKeyframe | null;
  /**
   * Which `video-toolbox.tsx` button is active. Owned here (not the IMAGE
   * `useAnnotationStore`) because `VideoEngine` reads it to decide how a
   * pointer gesture on the frame is interpreted -- e.g. "box" draws a new
   * keyframe, "select" drags an existing one.
   */
  tool: VideoAnnotationTool;
  /**
   * The one selected keyframe id, shared between `video-engine.tsx` (the
   * frame overlay owner) and `video-properties-tabs.tsx`'s Shapes tab.
   * Clicking a shape card there writes here; `VideoEngine` reacts by
   * switching to that keyframe's track, seeking the frame to its
   * timestamp, and pausing -- so "select a shape" and "highlight it on the
   * paused frame" are the same action, not two separate selection states.
   */
  selectedKeyframeId: string | null;
  /**
   * A one-shot cross-component signal: `video-engine.tsx`'s toolbar
   * "Create track" flow sets this to `"tracks"` right after a new track is
   * saved, so `video-properties-tabs.tsx` (a sibling under
   * `PropertiesPanel`, not a prop-connected child of `VideoEngine`) can
   * switch its own tab state to Tracks and immediately show the new track
   * card -- without either component needing to know about the other's
   * internals. Same cross-component pattern as `selectedKeyframeId` above.
   * The reading side clears it right after applying it, so it never
   * re-fires on unrelated re-renders.
   */
  requestedTab: string | null;
  /**
   * Additive playback-state slice (spec FR-047, US9) -- the single source of
   * truth for current frame/time/playback state/fps/duration, written only
   * by `video-playback-controller.ts`. Nothing here changes the fields
   * above; this exists so `video-toolbar.tsx` (and any future consumer) can
   * read playback state without each independently touching `videoRef`.
   */
  currentTimeMs: number;
  currentFrame: number;
  playbackState: "paused" | "playing";
  fps: number | null;
  durationMs: number | null;
  mergeAiResults: (tracks: SafeVideoTrack[], keyframes: SafeVideoKeyframe[]) => void;
  /**
   * Additive merge for a freshly-fetched read window (see
   * `video-window-ranges.ts`/`video-engine.tsx`'s window-loading effect).
   * Unlike `mergeAiResults` (which protects state a mutation already wrote
   * this session), server data here always overwrites any existing entry
   * with the same id -- this is a read cache being kept current, not a
   * merge against unsaved local state, so a repeat fetch of an overlapping
   * window should reflect whatever the server has now. Never removes
   * entries outside the new window: those came from an earlier window and
   * remain valid until the asset changes.
   */
  mergeWindow: (tracks: SafeVideoTrack[], keyframes: SafeVideoKeyframe[]) => void;
  /**
   * Removes exactly the given ids -- no inference, no "drop tracks with zero
   * remaining keyframes" heuristic, because a freshly-created track
   * legitimately has zero keyframes and must never be swept up by that.
   * The caller (`video-engine.tsx`'s window-cache eviction) is responsible
   * for deciding what's safe to remove: never the selected track, never a
   * keyframe with an unsaved local edit pending, never a track still
   * referenced by a keyframe that isn't also being removed in this call.
   */
  evictWindow: (keyframeIds: string[], trackIds: string[]) => void;
  setSnapshot: (tracks: SafeVideoTrack[], keyframes: SafeVideoKeyframe[]) => void;
  setTool: (tool: VideoAnnotationTool) => void;
  setSelectedKeyframeId: (id: string | null) => void;
  setRequestedTab: (tab: string) => void;
  clearRequestedTab: () => void;
  beginSave: () => void;
  markSaved: (track: SafeVideoTrack, keyframe?: SafeVideoKeyframe) => void;
  /**
   * The only two paths that remove a track/keyframe from the store (used by
   * `video-properties-tabs.tsx`'s Tracks/Shapes tabs after the delete
   * request succeeds). Deleting via raw `setState` instead of these would
   * update `tracks`/`keyframes` but leave `trackList`/`keyframeList` stale.
   */
  removeTrack: (trackId: string) => void;
  removeKeyframe: (keyframeId: string) => void;
  /** Written by `video-playback-controller.ts` after every playback action; also used to seed `fps`/`durationMs` once known. */
  setPlaybackSnapshot: (snapshot: Partial<Pick<VideoAnnotationState, "currentTimeMs" | "currentFrame" | "playbackState" | "fps" | "durationMs">>) => void;
  preserveConflict: (draft: SafeVideoKeyframe | null) => void;
  markError: () => void;
  clearDraft: () => void;
};

export const useVideoAnnotationStore = create<VideoAnnotationState>((set) => ({
  tracks: {},
  keyframes: {},
  trackList: [],
  keyframeList: [],
  mutationState: "idle",
  localDraft: null,
  tool: "select",
  selectedKeyframeId: null,
  requestedTab: null,
  currentTimeMs: 0,
  currentFrame: 0,
  playbackState: "paused",
  fps: null,
  durationMs: null,
  mergeAiResults: (newTracks, newKeyframes) => set((state) => {
    const tracks = { ...Object.fromEntries(newTracks.map((track) => [track.id, track])), ...state.tracks };
    const keyframes = { ...Object.fromEntries(newKeyframes.map((frame) => [frame.id, frame])), ...state.keyframes };
    return { tracks, keyframes, trackList: Object.values(tracks), keyframeList: Object.values(keyframes) };
  }),
  mergeWindow: (newTracks, newKeyframes) => set((state) => {
    const tracks = { ...state.tracks, ...Object.fromEntries(newTracks.map((track) => [track.id, track])) };
    const keyframes = { ...state.keyframes, ...Object.fromEntries(newKeyframes.map((frame) => [frame.id, frame])) };
    return { tracks, keyframes, trackList: Object.values(tracks), keyframeList: Object.values(keyframes) };
  }),
  evictWindow: (keyframeIds, trackIds) => set((state) => {
    if (!keyframeIds.length && !trackIds.length) return state;
    const keyframes = { ...state.keyframes };
    for (const id of keyframeIds) delete keyframes[id];
    const tracks = { ...state.tracks };
    for (const id of trackIds) delete tracks[id];
    return { keyframes, keyframeList: Object.values(keyframes), tracks, trackList: Object.values(tracks) };
  }),
  setSnapshot: (tracks, keyframes) => set({ tracks: Object.fromEntries(tracks.map((track) => [track.id, track])), keyframes: Object.fromEntries(keyframes.map((keyframe) => [keyframe.id, keyframe])), trackList: tracks, keyframeList: keyframes, mutationState: "idle" }),
  setTool: (tool) => set({ tool }),
  setSelectedKeyframeId: (selectedKeyframeId) => set({ selectedKeyframeId }),
  setRequestedTab: (requestedTab) => set({ requestedTab }),
  clearRequestedTab: () => set({ requestedTab: null }),
  setPlaybackSnapshot: (snapshot) => set(snapshot),
  beginSave: () => set({ mutationState: "saving" }),
  markSaved: (track, keyframe) => set((state) => {
    const tracks = { ...state.tracks, [track.id]: track };
    const keyframes = keyframe ? { ...state.keyframes, [keyframe.id]: keyframe } : state.keyframes;
    return { tracks, keyframes, trackList: Object.values(tracks), keyframeList: keyframe ? Object.values(keyframes) : state.keyframeList, mutationState: "saved", localDraft: null };
  }),
  removeTrack: (trackId) => set((state) => {
    const tracks = { ...state.tracks };
    delete tracks[trackId];
    const keyframes = Object.fromEntries(Object.entries(state.keyframes).filter(([, keyframe]) => keyframe.trackId !== trackId));
    return { tracks, keyframes, trackList: Object.values(tracks), keyframeList: Object.values(keyframes) };
  }),
  removeKeyframe: (keyframeId) => set((state) => {
    const keyframes = { ...state.keyframes };
    delete keyframes[keyframeId];
    return { keyframes, keyframeList: Object.values(keyframes) };
  }),
  preserveConflict: (draft) => set({ mutationState: "conflict", localDraft: draft }),
  markError: () => set({ mutationState: "error" }),
  clearDraft: () => set({ localDraft: null, mutationState: "idle" }),
}));
