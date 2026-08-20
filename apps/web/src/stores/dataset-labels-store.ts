"use client";

import { create } from "zustand";
import type { Modality } from "@internal/db";

/**
 * Dataset labels as every workspace engine's Properties panel consumes them
 * -- the label-management subset of `GET /api/datasets/{datasetId}/labels`'s
 * `items` (`labelMetadataSelect`). `modality` stays the full `Modality | null`
 * from the wire response (a label can be scoped to any modality, or `null`
 * for "applies everywhere") -- unlike `types/image-workspace.ts`'s
 * `SafeWorkspaceLabel`, which narrows it to `"IMAGE" | null` because that
 * type only ever describes the IMAGE canvas's own SSR-projected labels.
 *
 * `description`/`hotkey` are optional because IMAGE's SSR seed
 * (`SafeWorkspaceLabel`, passed to `ensureLoaded`'s `seed` param) doesn't
 * carry them -- they're absent only for that brief pre-fetch paint; the
 * authoritative `GET`/`PATCH` responses this store otherwise stores always
 * include them (`labelMetadataSelect`), so `label-edit-dialog.tsx` treats a
 * missing value the same as `null`.
 */
export type DatasetLabel = { id: string; name: string; color: string; modality: Modality | null; description?: string | null; hotkey?: string | null };

type LoadStatus = "idle" | "loading" | "loaded" | "error";
type DatasetLabelsEntry = { labels: DatasetLabel[]; status: LoadStatus; pending: Promise<void> | null };

type DatasetLabelsState = {
  entries: Record<string, DatasetLabelsEntry>;
  /**
   * Fetches `datasetId`'s labels exactly once for this store's lifetime
   * (i.e. once per browser session, not once per component mount) --
   * this is what actually closes the gap the old per-component "in-flight"
   * guards couldn't: those lived in component/module state that reset
   * every time `VideoPropertiesTabs`/`ImagePropertiesTabs` remounted (every
   * asset switch, via `PropertiesPanel`'s `key={engine:assetId}`), so a
   * second, later mount always re-fetched even though the first fetch had
   * long since completed. This store is a module-level singleton keyed by
   * `datasetId`, so "already loaded" survives every remount -- switching
   * Image -> Video -> Image issues zero further requests.
   *
   * `seed`, if given, paints the entry immediately (so a caller that
   * already has a same-tick server-rendered snapshot -- IMAGE's
   * `WorkspaceSelection.labels` -- never flashes an empty list) without
   * skipping the fetch: the entry still starts `"loading"` and the network
   * response is still the value that lands, keeping this store the single
   * authoritative source rather than trusting a snapshot that may already
   * be stale by the time hydration runs.
   */
  ensureLoaded: (datasetId: string, seed?: DatasetLabel[]) => Promise<void>;
  /** Forces the next `ensureLoaded` call for `datasetId` to hit the network again. */
  invalidate: (datasetId: string) => void;
  addLabel: (datasetId: string, label: DatasetLabel) => void;
  updateLabel: (datasetId: string, label: DatasetLabel) => void;
  removeLabel: (datasetId: string, labelId: string) => void;
};

const EMPTY_ENTRY: DatasetLabelsEntry = { labels: [], status: "idle", pending: null };
const EMPTY_LABELS: DatasetLabel[] = [];

export const useDatasetLabelsStore = create<DatasetLabelsState>((set, get) => ({
  entries: {},

  ensureLoaded: async (datasetId, seed) => {
    const existing = get().entries[datasetId];
    if (existing?.status === "loaded") return;
    if (existing?.status === "loading") { if (existing.pending) await existing.pending; return; }

    const request = (async () => {
      try {
        const response = await fetch(`/api/datasets/${datasetId}/labels`, { credentials: "same-origin", cache: "no-store" });
        const payload = await response.json().catch(() => null) as { data?: { items?: DatasetLabel[] } } | null;
        if (!response.ok || !payload?.data?.items) {
          set((state) => ({ entries: { ...state.entries, [datasetId]: { ...(state.entries[datasetId] ?? EMPTY_ENTRY), status: "error", pending: null } } }));
          return;
        }
        set((state) => ({ entries: { ...state.entries, [datasetId]: { labels: payload.data!.items!, status: "loaded", pending: null } } }));
      } catch {
        set((state) => ({ entries: { ...state.entries, [datasetId]: { ...(state.entries[datasetId] ?? EMPTY_ENTRY), status: "error", pending: null } } }));
      }
    })();

    // Synchronous, before the first `await` below -- a second `ensureLoaded`
    // call for the same `datasetId` that arrives before `request` settles
    // (React 18 Strict Mode's mount -> cleanup -> mount, run back-to-back
    // with no yield in between) sees `status: "loading"` here and piggybacks
    // on `pending` above instead of issuing a second `fetch`.
    set((state) => ({ entries: { ...state.entries, [datasetId]: { labels: existing?.labels ?? seed ?? EMPTY_LABELS, status: "loading", pending: request } } }));
    await request;
  },

  invalidate: (datasetId) => set((state) => (
    state.entries[datasetId] ? { entries: { ...state.entries, [datasetId]: { ...state.entries[datasetId], status: "idle", pending: null } } } : state
  )),

  addLabel: (datasetId, label) => set((state) => {
    const entry = state.entries[datasetId] ?? EMPTY_ENTRY;
    return { entries: { ...state.entries, [datasetId]: { ...entry, labels: [...entry.labels, label].sort((left, right) => left.name.localeCompare(right.name)) } } };
  }),

  // Re-sorts by name too -- a rename can change this label's place in the
  // `normalizedName`-ordered list the server hands back, same as `addLabel`.
  updateLabel: (datasetId, label) => set((state) => {
    const entry = state.entries[datasetId];
    if (!entry) return state;
    return { entries: { ...state.entries, [datasetId]: { ...entry, labels: entry.labels.map((item) => (item.id === label.id ? label : item)).sort((left, right) => left.name.localeCompare(right.name)) } } };
  }),

  removeLabel: (datasetId, labelId) => set((state) => {
    const entry = state.entries[datasetId];
    if (!entry) return state;
    return { entries: { ...state.entries, [datasetId]: { ...entry, labels: entry.labels.filter((item) => item.id !== labelId) } } };
  }),
}));

/** The labels array for one dataset, `[]` (a stable reference) until loaded. */
export function useDatasetLabels(datasetId: string): DatasetLabel[] {
  return useDatasetLabelsStore((state) => state.entries[datasetId]?.labels ?? EMPTY_LABELS);
}
