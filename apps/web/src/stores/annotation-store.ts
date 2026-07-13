"use client";

import { create } from "zustand";

import type {
  AnnotationTool,
  BoundingBoxCoordinates,
  DraftAnnotation,
} from "@/types/annotation";

const HISTORY_LIMIT = 50;

type AnnotationSnapshot = {
  annotations: DraftAnnotation[];
  selectedId: string | null;
};

type AnnotationState = {
  imageId: string | null;
  annotations: DraftAnnotation[];
  selectedId: string | null;
  activeLabelId: string | null;
  tool: AnnotationTool;
  past: AnnotationSnapshot[];
  future: AnnotationSnapshot[];
  initializeImage: (imageId: string, activeLabelId: string | null) => void;
  setTool: (tool: AnnotationTool) => void;
  setSelectedId: (id: string | null) => void;
  setActiveLabelId: (id: string) => void;
  addAnnotation: (annotation: DraftAnnotation) => void;
  updateCoordinates: (id: string, coordinates: BoundingBoxCoordinates) => void;
  updateLabel: (id: string, labelId: string) => void;
  deleteSelected: () => void;
  undo: () => void;
  redo: () => void;
};

function snapshot(state: AnnotationState): AnnotationSnapshot {
  return {
    annotations: state.annotations,
    selectedId: state.selectedId,
  };
}

function withHistory(
  state: AnnotationState,
  next: Pick<AnnotationState, "annotations" | "selectedId">,
) {
  return {
    ...next,
    past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
    future: [],
  };
}

export const useAnnotationStore = create<AnnotationState>((set) => ({
  imageId: null,
  annotations: [],
  selectedId: null,
  activeLabelId: null,
  tool: "select",
  past: [],
  future: [],

  initializeImage: (imageId, activeLabelId) =>
    set((state) =>
      state.imageId === imageId
        ? {
            activeLabelId: state.activeLabelId ?? activeLabelId,
          }
        : {
            imageId,
            annotations: [],
            selectedId: null,
            activeLabelId,
            tool: "select",
            past: [],
            future: [],
          },
    ),
  setTool: (tool) => set({ tool }),
  setSelectedId: (selectedId) => set({ selectedId }),
  setActiveLabelId: (activeLabelId) => set({ activeLabelId }),
  addAnnotation: (annotation) =>
    set((state) =>
      withHistory(state, {
        annotations: [...state.annotations, annotation],
        selectedId: annotation.id,
      }),
    ),
  updateCoordinates: (id, coordinates) =>
    set((state) => {
      const current = state.annotations.find((item) => item.id === id);
      if (
        !current ||
        JSON.stringify(current.coordinates) === JSON.stringify(coordinates)
      ) {
        return state;
      }
      return withHistory(state, {
        annotations: state.annotations.map((item) =>
          item.id === id ? { ...item, coordinates } : item,
        ),
        selectedId: id,
      });
    }),
  updateLabel: (id, labelId) =>
    set((state) =>
      withHistory(state, {
        annotations: state.annotations.map((item) =>
          item.id === id ? { ...item, labelId } : item,
        ),
        selectedId: id,
      }),
    ),
  deleteSelected: () =>
    set((state) => {
      if (!state.selectedId) return state;
      return withHistory(state, {
        annotations: state.annotations.filter(
          (item) => item.id !== state.selectedId,
        ),
        selectedId: null,
      });
    }),
  undo: () =>
    set((state) => {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        annotations: previous.annotations,
        selectedId: previous.selectedId,
        past: state.past.slice(0, -1),
        future: [snapshot(state), ...state.future].slice(0, HISTORY_LIMIT),
      };
    }),
  redo: () =>
    set((state) => {
      const next = state.future[0];
      if (!next) return state;
      return {
        annotations: next.annotations,
        selectedId: next.selectedId,
        past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
      };
    }),
}));
