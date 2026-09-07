"use client";

import { create } from "zustand";

import type { AssetListQuery } from "@/types/workspace";

export type SelectionMode = "NONE" | "EXPLICIT" | "FILTERED";

function sameQuery(left: AssetListQuery | null, right: AssetListQuery): boolean {
  if (!left) return false;
  return JSON.stringify(normalizeQuery(left)) === JSON.stringify(normalizeQuery(right));
}
function normalizeQuery(query: AssetListQuery) {
  return {
    q: query.q ?? "", status: [...(query.status ?? [])].sort(), modality: query.modality ?? "", labelId: [...(query.labelId ?? [])].sort(),
    assignedToId: query.assignedToId ?? "", createdFrom: query.createdFrom ?? "", createdTo: query.createdTo ?? "",
    updatedFrom: query.updatedFrom ?? "", updatedTo: query.updatedTo ?? "",
  };
}

type AssetSelectionState = {
  datasetId: string | null;
  mode: SelectionMode;
  explicitIds: Set<string>;
  filteredQuery: AssetListQuery | null;
  /** Last known matched count for the active `FILTERED` query -- display only; every bulk action re-resolves server-side regardless (FR-010). */
  filteredCount: number;

  isSelected: (assetId: string) => boolean;
  selectedCount: () => number;
  toggle: (datasetId: string, assetId: string) => void;
  selectVisible: (datasetId: string, assetIds: string[]) => void;
  selectAllFiltered: (datasetId: string, query: AssetListQuery, matchedCount: number) => void;
  clear: () => void;
  /**
   * Applies FR-013's per-mode reconciliation rule whenever the active
   * search/filter query changes (sort/order are never passed here -- they
   * must never reach this store, since sort never defines selection
   * membership). `FILTERED` re-represents the new query and count
   * automatically; `EXPLICIT` is left completely untouched (hidden-but-
   * selected assets stay selected). Call on every render of the query so
   * this stays declaratively in sync -- see `useAssetSelectionSync`.
   */
  reconcile: (datasetId: string, newQuery: AssetListQuery, matchedCount: number) => void;
};

export const useAssetSelectionStore = create<AssetSelectionState>((set, get) => ({
  datasetId: null,
  mode: "NONE",
  explicitIds: new Set(),
  filteredQuery: null,
  filteredCount: 0,

  isSelected: (assetId) => get().mode === "EXPLICIT" && get().explicitIds.has(assetId),
  selectedCount: () => {
    const state = get();
    if (state.mode === "EXPLICIT") return state.explicitIds.size;
    if (state.mode === "FILTERED") return state.filteredCount;
    return 0;
  },

  toggle: (datasetId, assetId) => set((state) => {
    // Switching datasets (or switching away from a FILTERED selection into an
    // explicit pick) always starts a fresh explicit set -- never silently
    // mixes selections across datasets or modes.
    const explicitIds = state.datasetId === datasetId && state.mode === "EXPLICIT" ? new Set(state.explicitIds) : new Set<string>();
    if (explicitIds.has(assetId)) explicitIds.delete(assetId); else explicitIds.add(assetId);
    return { datasetId, mode: explicitIds.size > 0 ? "EXPLICIT" : "NONE", explicitIds, filteredQuery: null, filteredCount: 0 };
  }),

  selectVisible: (datasetId, assetIds) => set((state) => {
    const explicitIds = state.datasetId === datasetId && state.mode === "EXPLICIT" ? new Set(state.explicitIds) : new Set<string>();
    for (const id of assetIds) explicitIds.add(id);
    return { datasetId, mode: "EXPLICIT", explicitIds, filteredQuery: null, filteredCount: 0 };
  }),

  selectAllFiltered: (datasetId, query, matchedCount) => set({ datasetId, mode: "FILTERED", explicitIds: new Set(), filteredQuery: query, filteredCount: matchedCount }),

  clear: () => set({ datasetId: null, mode: "NONE", explicitIds: new Set(), filteredQuery: null, filteredCount: 0 }),

  reconcile: (datasetId, newQuery, matchedCount) => set((state) => {
    if (state.datasetId !== datasetId) return state; // a different dataset entirely -- not this store's concern here, `clear()` on dataset switch handles it.
    if (state.mode === "FILTERED" && !sameQuery(state.filteredQuery, newQuery)) return { filteredQuery: newQuery, filteredCount: matchedCount };
    if (state.mode === "FILTERED") return { filteredCount: matchedCount }; // same query, count may still have moved (assets added/removed elsewhere).
    return state; // EXPLICIT or NONE: untouched by query changes.
  }),
}));
