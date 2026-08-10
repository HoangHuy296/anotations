"use client";

import { create } from "zustand";
import type { SafeVideoKeyframe, SafeVideoTrack } from "@/types/video-annotation";
import type { VideoAnnotationTool } from "@/types/annotation";

type VideoMutationState = "idle" | "saving" | "saved" | "conflict" | "error";

type VideoAnnotationState = {
  tracks: Record<string, SafeVideoTrack>;
  keyframes: Record<string, SafeVideoKeyframe>;
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
  setSnapshot: (tracks: SafeVideoTrack[], keyframes: SafeVideoKeyframe[]) => void;
  setTool: (tool: VideoAnnotationTool) => void;
  setSelectedKeyframeId: (id: string | null) => void;
  beginSave: () => void;
  markSaved: (track: SafeVideoTrack, keyframe?: SafeVideoKeyframe) => void;
  preserveConflict: (draft: SafeVideoKeyframe | null) => void;
  markError: () => void;
  clearDraft: () => void;
};

export const useVideoAnnotationStore = create<VideoAnnotationState>((set) => ({
  tracks: {},
  keyframes: {},
  mutationState: "idle",
  localDraft: null,
  tool: "select",
  selectedKeyframeId: null,
  setSnapshot: (tracks, keyframes) => set({ tracks: Object.fromEntries(tracks.map((track) => [track.id, track])), keyframes: Object.fromEntries(keyframes.map((keyframe) => [keyframe.id, keyframe])), mutationState: "idle" }),
  setTool: (tool) => set({ tool }),
  setSelectedKeyframeId: (selectedKeyframeId) => set({ selectedKeyframeId }),
  beginSave: () => set({ mutationState: "saving" }),
  markSaved: (track, keyframe) => set((state) => ({ tracks: { ...state.tracks, [track.id]: track }, keyframes: keyframe ? { ...state.keyframes, [keyframe.id]: keyframe } : state.keyframes, mutationState: "saved", localDraft: null })),
  preserveConflict: (draft) => set({ mutationState: "conflict", localDraft: draft }),
  markError: () => set({ mutationState: "error" }),
  clearDraft: () => set({ localDraft: null, mutationState: "idle" }),
}));
