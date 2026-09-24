"use client";

import { create } from "zustand";
import type { SafeTextAnnotation } from "@annotationplatform/domain/text-annotation-contract";

import type { TextAssetSnapshot, TextPendingCommand, TextPendingCommandStatus, TextReaderSnapshot, TextReaderTool, TextSearchState, TextSelectionRange } from "@/types/text";
import type { TextEligiblePolicy } from "@/lib/workspace/text-policy-client";

/**
 * The per-asset TEXT store (data-model.md "Workflow and client state"):
 * protected source identity/boundaries, saved annotation snapshot, local
 * pending semantic commands, and ephemeral selection/search/hover state —
 * all in memory only. `initializeAsset`/`clearAsset` reset every field
 * together so a scope change (asset switch, dataset switch, sign-out)
 * cannot leak stale selection, search, or pending-command state onto a
 * different asset. No field here is ever written to localStorage/
 * sessionStorage/IndexedDB — the store simply never calls into browser
 * storage, so there is nothing to opt out of.
 */

const EMPTY_SEARCH: TextSearchState = { query: "", matches: [], activeMatchIndex: null };

export type TextPolicyStatus = "idle" | "loading" | "loaded" | "error";

/**
 * T095: Undo/Redo core. Each entry is a *reversible edit already committed
 * to the server*, holding exactly enough to submit its inverse as a new
 * `updateSpan` command (never a local snapshot rollback -- data-model.md
 * "Workflow and client state"). Scoped to label and custom-property edits
 * on an existing span only -- the only two edits any UI control currently
 * triggers on an already-created span (`TextAnnotationEditor`,
 * `TextCustomPropertiesEditor`). Span *creation* and *deletion* are
 * deliberately not undoable yet: undoing a delete would need to recreate
 * the row, which the server always assigns a new id to, breaking identity
 * for any further undo/redo of that entry -- a real limitation, not an
 * oversight (see text-workspace.ts). Extended to classification/relation
 * edits in US3/US4 per this file's own story ordering.
 */
export type TextUndoEntry =
  | { kind: "label"; annotationId: string; inverseLabelId: string | null; redoLabelId: string | null }
  | { kind: "geometry"; annotationId: string; inverseRange: { startOffset: number; endOffset: number }; redoRange: { startOffset: number; endOffset: number } }
  | { kind: "properties"; annotationId: string; inversePatch: { set: Record<string, string | number | boolean | null>; unset: string[] }; redoPatch: { set: Record<string, string | number | boolean | null>; unset: string[] } };

const UNDO_HISTORY_LIMIT = 50;

type TextAnnotationState = {
  assetId: string | null;
  selectedAnnotationId: string | null;
  selectAnnotation: (id: string | null) => void;
  snapshot: TextAssetSnapshot | null;
  pendingCommands: TextPendingCommand[];
  selection: TextSelectionRange | null;
  search: TextSearchState;
  hoveredAnnotationId: string | null;
  /** The reader's own interaction mode -- always resets to "select" on a scope change (data-model.md "Workflow and client state"), same as every other ephemeral field here. */
  tool: TextReaderTool;
  /** Published by `TextEngine` (the reader itself), not written by anything else -- `null` until the reader has mounted and reported its first load state for the current asset. */
  reader: TextReaderSnapshot | null;
  /** The dataset's resolved TEXT taxonomy policy (`GET /api/datasets/{datasetId}/text-policy`) -- `null` until fetched for the current asset. Re-fetched on every `initializeAsset`, same as every other scope-reset field: cheap, and guarantees `revision` (sent back as a command's `expectedPolicyRevision`) is never carried stale across an asset switch. */
  policy: TextEligiblePolicy | null;
  policyStatus: TextPolicyStatus;
  /** Which entity label a "highlightspan" selection is created with. `null` is a valid, allowed choice (an unlabeled span). */
  activeEntityLabelId: string | null;
  /** Which configured relation type a "relation" click-pair creates. `null` means no relation type chosen yet -- the tool cannot commit until one is. */
  activeRelationLabelId: string | null;
  /** The first span clicked while `tool === "relation"`; the next click on a different span commits the relation and clears this. */
  pendingRelationFromId: string | null;
  /** The last command failure's human-readable message (`describeTextCommandFailure`), shown by the toolbox/properties panel until the next attempt or tool change clears it. */
  commandError: string | null;
  /** Whether that failure is conflict-class (`isTextCommandConflict`) -- when true, `text-engine.tsx` renders `SaveConflictPanel` (Reload/Discard) instead of a plain dismissable banner. */
  commandErrorConflict: boolean;
  /** Reversible edits, most-recent last. A genuinely new edit (`pushUndoEntry`) clears `redoStack` -- the usual editor convention (redo history is only valid until the next new edit). */
  undoStack: TextUndoEntry[];
  redoStack: TextUndoEntry[];

  /** Always resets pending/selection/search/hover/tool/reader/policy/relation-in-progress state, even when re-initializing the same asset -- a fresh snapshot is authoritative, never merged with stale local state. */
  initializeAsset: (snapshot: TextAssetSnapshot) => void;
  clearAsset: () => void;
  setSelection: (selection: TextSelectionRange | null) => void;
  setSearch: (search: Partial<TextSearchState>) => void;
  setHoveredAnnotationId: (id: string | null) => void;
  addPendingCommand: (command: TextPendingCommand) => void;
  updatePendingCommandStatus: (operationId: string, status: TextPendingCommandStatus) => void;
  removePendingCommand: (operationId: string) => void;
  /** Switching tools clears the transient text selection and any in-progress relation click (both belong to the old tool's interaction, not the new one) without touching saved annotations or pending commands. */
  setTool: (tool: TextReaderTool) => void;
  setReader: (reader: TextReaderSnapshot) => void;
  setPolicy: (policy: TextEligiblePolicy) => void;
  setPolicyStatus: (status: TextPolicyStatus) => void;
  setActiveEntityLabelId: (labelId: string | null) => void;
  setActiveRelationLabelId: (labelId: string | null) => void;
  setPendingRelationFromId: (annotationId: string | null) => void;
  /** `conflict` defaults to false -- callers pass it explicitly only when the failure is conflict-class. */
  setCommandError: (message: string | null, conflict?: boolean) => void;
  /** Appends a freshly created annotation, or replaces an existing row by id (an update) -- into `snapshot.savedAnnotations`. No-op before a snapshot exists. */
  upsertAnnotation: (annotation: SafeTextAnnotation) => void;
  /** Removes an annotation by id from `snapshot.savedAnnotations` (a committed delete). No-op before a snapshot exists. */
  removeAnnotationLocal: (annotationId: string) => void;
  /**
   * T139/T144: replaces the saved-annotation list with a freshly re-fetched
   * server snapshot for the *current* asset (a realtime `ANNOTATION_CHANGED`
   * invalidation's `router.refresh()` brings new `selection.annotations`
   * props, but `initializeAsset` alone only re-runs on a genuine asset
   * switch -- without this, another user's remote edits never reached an
   * already-open TEXT asset at all). A stale call for a since-switched asset
   * is a no-op. Never touches undo/redo/selection/search/tool -- only the
   * durable annotation list itself.
   */
  applyRemoteAnnotations: (assetId: string, annotations: SafeTextAnnotation[]) => void;
  /** Records a newly-committed reversible edit; clears `redoStack` (a fresh edit invalidates old redo history) and caps history at `UNDO_HISTORY_LIMIT`. */
  pushUndoEntry: (entry: TextUndoEntry) => void;
  /** Pops and returns the most recent undo entry, or null if there is none. */
  popUndoEntry: () => TextUndoEntry | null;
  /** Pushes onto `redoStack` without touching `undoStack` (used after a successful undo). */
  pushRedoEntry: (entry: TextUndoEntry) => void;
  /** Pops and returns the most recent redo entry, or null if there is none. */
  popRedoEntry: () => TextUndoEntry | null;
  /** Pushes back onto `undoStack` without clearing `redoStack` (used after a successful redo, which is itself a fresh undoable edit but must not wipe remaining redo history below it). */
  restoreUndoEntry: (entry: TextUndoEntry) => void;
};

const CLEARED_SCOPE_FIELDS = {
  selectedAnnotationId: null as string | null,
  pendingCommands: [] as TextPendingCommand[], selection: null, search: EMPTY_SEARCH, hoveredAnnotationId: null,
  tool: "select" as TextReaderTool, reader: null as TextReaderSnapshot | null,
  policy: null as TextEligiblePolicy | null, policyStatus: "idle" as TextPolicyStatus,
  activeEntityLabelId: null as string | null, activeRelationLabelId: null as string | null,
  pendingRelationFromId: null as string | null, commandError: null as string | null, commandErrorConflict: false,
  undoStack: [] as TextUndoEntry[], redoStack: [] as TextUndoEntry[],
} as const;

export const useTextAnnotationStore = create<TextAnnotationState>((set, get) => ({
  assetId: null,
  snapshot: null,
  ...CLEARED_SCOPE_FIELDS,

  initializeAsset: (snapshot) => set({ assetId: snapshot.assetId, snapshot, ...CLEARED_SCOPE_FIELDS }),
  clearAsset: () => set({ assetId: null, snapshot: null, ...CLEARED_SCOPE_FIELDS }),
  setSelection: (selection) => set({ selection }),
  selectAnnotation: (selectedAnnotationId) => set({ selectedAnnotationId }),
  setSearch: (search) => set((state) => ({ search: { ...state.search, ...search } })),
  setHoveredAnnotationId: (hoveredAnnotationId) => set({ hoveredAnnotationId }),
  addPendingCommand: (command) => set((state) => ({ pendingCommands: [...state.pendingCommands, command] })),
  updatePendingCommandStatus: (operationId, status) => set((state) => ({
    pendingCommands: state.pendingCommands.map((command) => (command.operationId === operationId ? { ...command, status } : command)),
  })),
  removePendingCommand: (operationId) => set((state) => ({ pendingCommands: state.pendingCommands.filter((command) => command.operationId !== operationId) })),
  setTool: (tool) => set({ tool, selection: null, pendingRelationFromId: null, commandError: null, commandErrorConflict: false }),
  setReader: (reader) => set({ reader }),
  setPolicy: (policy) => set({ policy, policyStatus: "loaded" }),
  setPolicyStatus: (policyStatus) => set({ policyStatus }),
  setActiveEntityLabelId: (activeEntityLabelId) => set({ activeEntityLabelId }),
  setActiveRelationLabelId: (activeRelationLabelId) => set({ activeRelationLabelId, pendingRelationFromId: null }),
  setPendingRelationFromId: (pendingRelationFromId) => set({ pendingRelationFromId }),
  setCommandError: (commandError, conflict = false) => set({ commandError, commandErrorConflict: commandError ? conflict : false }),
  upsertAnnotation: (annotation) => set((state) => {
    if (!state.snapshot) return {};
    const exists = state.snapshot.savedAnnotations.some((item) => item.id === annotation.id);
    const savedAnnotations = exists
      ? state.snapshot.savedAnnotations.map((item) => (item.id === annotation.id ? annotation : item))
      : [...state.snapshot.savedAnnotations, annotation];
    return { snapshot: { ...state.snapshot, savedAnnotations } };
  }),
  applyRemoteAnnotations: (assetId, annotations) => set((state) => {
    if (state.assetId !== assetId || !state.snapshot) return {};
    return { snapshot: { ...state.snapshot, savedAnnotations: annotations } };
  }),
  removeAnnotationLocal: (annotationId) => set((state) => {
    if (!state.snapshot) return {};
    return { selectedAnnotationId: state.selectedAnnotationId === annotationId ? null : state.selectedAnnotationId, pendingRelationFromId: state.pendingRelationFromId === annotationId ? null : state.pendingRelationFromId, snapshot: { ...state.snapshot, savedAnnotations: state.snapshot.savedAnnotations.filter((item) => item.id !== annotationId) } };
  }),
  pushUndoEntry: (entry) => set((state) => ({ undoStack: [...state.undoStack, entry].slice(-UNDO_HISTORY_LIMIT), redoStack: [] })),
  popUndoEntry: () => {
    const stack = get().undoStack;
    const entry = stack.at(-1) ?? null;
    if (entry) set({ undoStack: stack.slice(0, -1) });
    return entry;
  },
  pushRedoEntry: (entry) => set((state) => ({ redoStack: [...state.redoStack, entry].slice(-UNDO_HISTORY_LIMIT) })),
  popRedoEntry: () => {
    const stack = get().redoStack;
    const entry = stack.at(-1) ?? null;
    if (entry) set({ redoStack: stack.slice(0, -1) });
    return entry;
  },
  restoreUndoEntry: (entry) => set((state) => ({ undoStack: [...state.undoStack, entry].slice(-UNDO_HISTORY_LIMIT) })),
}));
