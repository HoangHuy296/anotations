"use client";

import { create } from "zustand";

import type {
  AnnotationTool,
  BoundingBoxCoordinates,
  DraftAnnotation,
} from "@/types/annotation";
import type { SafeImageAnnotation } from "@/types/image-workspace";

export type AutosaveResult = "saved" | "failed" | "conflict";
export type AutosaveTask = () => Promise<AutosaveResult>;
export type SaveState = "idle" | "pending" | "saving" | "saved" | "failed" | "conflict";

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
  persistedAnnotations: SafeImageAnnotation[];
  saveStates: Record<string, SaveState>;
  conflictDrafts: Record<string, unknown>;
  initializeImage: (imageId: string, activeLabelId: string | null) => void;
  setTool: (tool: AnnotationTool) => void;
  setSelectedId: (id: string | null) => void;
  setActiveLabelId: (id: string) => void;
  setPersistedAnnotations: (annotations: DraftAnnotation[]) => void;
  replacePersistedAnnotation: (annotation: DraftAnnotation) => void;
  removePersistedAnnotation: (id: string) => void;
  initializePersistedImage: (imageId: string, annotations: SafeImageAnnotation[]) => void;
  upsertSafeAnnotation: (annotation: SafeImageAnnotation) => void;
  removeSafeAnnotation: (id: string) => void;
  scheduleAutosave: (resourceKey: string, task: AutosaveTask, delayMs?: number) => void;
  flushAutosave: (resourceKey: string) => Promise<AutosaveResult | "idle">;
  flushAllAutosaves: () => Promise<Record<string, AutosaveResult | "idle">>;
  clearAutosave: (resourceKey: string) => void;
  setConflictDraft: (resourceKey: string, draft: unknown) => void;
  clearConflictDraft: (resourceKey: string) => void;
  addAnnotation: (annotation: DraftAnnotation) => void;
  updateCoordinates: (id: string, coordinates: BoundingBoxCoordinates) => void;
  updateLabel: (id: string, labelId: string) => void;
  deleteSelected: () => void;
  undo: () => void;
  redo: () => void;
};

const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const autosaveTasks = new Map<string, AutosaveTask>();
const autosaveInFlight = new Map<string, Promise<AutosaveResult>>();

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

export const useAnnotationStore = create<AnnotationState>((set, get) => {
  const runAutosave = (resourceKey: string, task: AutosaveTask): Promise<AutosaveResult> => {
    const existing = autosaveInFlight.get(resourceKey);
    if (existing) return existing;
    set((state) => ({ saveStates: { ...state.saveStates, [resourceKey]: "saving" } }));
    const run = task()
      .catch(() => "failed" as const)
      .then((result) => {
        // A newer edit may have been scheduled while this request was in
        // flight. Keep its pending state and task; never let an older result
        // erase that newer draft.
        if (autosaveTasks.get(resourceKey) === task) {
          autosaveTasks.delete(resourceKey);
          set((state) => ({ saveStates: { ...state.saveStates, [resourceKey]: result } }));
        }
        return result;
      })
      .finally(() => { autosaveInFlight.delete(resourceKey); });
    autosaveInFlight.set(resourceKey, run);
    return run;
  };

  return {
  imageId: null,
  annotations: [],
  selectedId: null,
  activeLabelId: null,
  tool: "select",
  past: [],
  future: [],
  persistedAnnotations: [],
  saveStates: {},
  conflictDrafts: {},

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
  setPersistedAnnotations: (annotations) => set({ annotations, selectedId: null, past: [], future: [] }),
  replacePersistedAnnotation: (annotation) => set((state) => ({
    annotations: state.annotations.some((item) => item.id === annotation.id)
      ? state.annotations.map((item) => item.id === annotation.id ? annotation : item)
      : [...state.annotations, annotation],
    selectedId: annotation.id,
  })),
  removePersistedAnnotation: (id) => set((state) => ({
    annotations: state.annotations.filter((item) => item.id !== id),
    selectedId: state.selectedId === id ? null : state.selectedId,
  })),
  initializePersistedImage: (imageId, annotations) => set((state) => state.imageId === imageId
    ? { persistedAnnotations: annotations }
    : { imageId, persistedAnnotations: annotations, selectedId: null, activeLabelId: null, tool: "select", annotations: [], past: [], future: [] }),
  upsertSafeAnnotation: (annotation) => set((state) => ({
    persistedAnnotations: state.persistedAnnotations.some((item) => item.id === annotation.id)
      ? state.persistedAnnotations.map((item) => item.id === annotation.id ? annotation : item)
      : [...state.persistedAnnotations, annotation],
    selectedId: annotation.id,
  })),
  removeSafeAnnotation: (id) => set((state) => ({
    persistedAnnotations: state.persistedAnnotations.filter((item) => item.id !== id),
    selectedId: state.selectedId === id ? null : state.selectedId,
  })),
  scheduleAutosave: (resourceKey, task, delayMs = 1_500) => {
    const existing = autosaveTimers.get(resourceKey);
    if (existing) clearTimeout(existing);
    autosaveTasks.set(resourceKey, task);
    set((state) => ({ saveStates: { ...state.saveStates, [resourceKey]: "pending" } }));
    autosaveTimers.set(resourceKey, setTimeout(() => {
      autosaveTimers.delete(resourceKey);
      if (autosaveTasks.get(resourceKey) === task) void runAutosave(resourceKey, task);
    }, delayMs));
  },
  flushAutosave: async (resourceKey) => {
    const inFlight = autosaveInFlight.get(resourceKey);
    if (inFlight) return inFlight;
    const timer = autosaveTimers.get(resourceKey);
    if (timer) clearTimeout(timer);
    autosaveTimers.delete(resourceKey);
    const task = autosaveTasks.get(resourceKey);
    return task ? runAutosave(resourceKey, task) : "idle";
  },
  flushAllAutosaves: async () => {
    const keys = new Set([...autosaveTasks.keys(), ...autosaveInFlight.keys()]);
    const entries = await Promise.all([...keys].map(async (key) => [key, await get().flushAutosave(key)] as const));
    return Object.fromEntries(entries);
  },
  clearAutosave: (resourceKey) => {
    const existing = autosaveTimers.get(resourceKey);
    if (existing) clearTimeout(existing);
    autosaveTimers.delete(resourceKey);
    autosaveTasks.delete(resourceKey);
    set((state) => ({ saveStates: { ...state.saveStates, [resourceKey]: "idle" } }));
  },
  setConflictDraft: (resourceKey, draft) => set((state) => ({
    conflictDrafts: { ...state.conflictDrafts, [resourceKey]: draft },
    saveStates: { ...state.saveStates, [resourceKey]: "conflict" },
  })),
  clearConflictDraft: (resourceKey) => set((state) => {
    const conflictDrafts = { ...state.conflictDrafts };
    delete conflictDrafts[resourceKey];
    return { conflictDrafts, saveStates: { ...state.saveStates, [resourceKey]: "idle" } };
  }),
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
};
});
