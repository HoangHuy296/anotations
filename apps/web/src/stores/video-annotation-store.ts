"use client";

import { create } from "zustand";
import type { SafeVideoKeyframe, SafeVideoTrack } from "@/types/video-annotation";

type VideoMutationState = "idle" | "saving" | "saved" | "conflict" | "error";

type VideoAnnotationState = {
  tracks: Record<string, SafeVideoTrack>;
  keyframes: Record<string, SafeVideoKeyframe>;
  mutationState: VideoMutationState;
  localDraft: SafeVideoKeyframe | null;
  setSnapshot: (tracks: SafeVideoTrack[], keyframes: SafeVideoKeyframe[]) => void;
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
  setSnapshot: (tracks, keyframes) => set({ tracks: Object.fromEntries(tracks.map((track) => [track.id, track])), keyframes: Object.fromEntries(keyframes.map((keyframe) => [keyframe.id, keyframe])), mutationState: "idle" }),
  beginSave: () => set({ mutationState: "saving" }),
  markSaved: (track, keyframe) => set((state) => ({ tracks: { ...state.tracks, [track.id]: track }, keyframes: keyframe ? { ...state.keyframes, [keyframe.id]: keyframe } : state.keyframes, mutationState: "saved", localDraft: null })),
  preserveConflict: (draft) => set({ mutationState: "conflict", localDraft: draft }),
  markError: () => set({ mutationState: "error" }),
  clearDraft: () => set({ localDraft: null, mutationState: "idle" }),
}));
