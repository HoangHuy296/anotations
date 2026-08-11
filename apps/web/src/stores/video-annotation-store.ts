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
  setSnapshot: (tracks, keyframes) => set({ tracks: Object.fromEntries(tracks.map((track) => [track.id, track])), keyframes: Object.fromEntries(keyframes.map((keyframe) => [keyframe.id, keyframe])), trackList: tracks, keyframeList: keyframes, mutationState: "idle" }),
  setTool: (tool) => set({ tool }),
  setSelectedKeyframeId: (selectedKeyframeId) => set({ selectedKeyframeId }),
  setRequestedTab: (requestedTab) => set({ requestedTab }),
  clearRequestedTab: () => set({ requestedTab: null }),
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
