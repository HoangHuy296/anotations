"use client";

import { ArrowArcLeft, ArrowArcRight, CaretDown, CaretUp, MagnifyingGlass, SpinnerGap, TextT, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useEffectEvent, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { useRouter } from "next/navigation";
import { normalizeTextSpanSelection } from "@/lib/workspace/text-span-selection";

import type { WorkspaceSelection } from "@/types/workspace";
import type { TextSourceReadiness } from "@/lib/annotations/text-source-readiness";
import { ensureTextSourceReady } from "@/lib/workspace/text-read-client";
import { fetchTextEligiblePolicy } from "@/lib/workspace/text-policy-client";
import { hasPendingTextAnnotationCommands, submitTextAnnotationCommand } from "@/lib/annotations/text-annotation-client";
import { describeTextCommandFailure, isTextCommandConflict } from "@/lib/annotations/text-command-error";
import { randomUUIDAuto } from "@/lib/browser-random-uuid";
import { useTextAnnotationStore } from "@/stores/text-annotation-store";
import { useAnnotationStore } from "@/stores/image-annotation-store";
import { SaveConflictPanel } from "@/components/workspace/save-conflict-panel";
import { TextOffsetInspector } from "@/components/workspace/text-offset-inspector";
import { redoLastTextCommand, undoLastTextCommand } from "@/lib/workspace/text-workspace";
import { useTextUndoRedoShortcuts } from "@/components/workspace/use-text-undo-redo-shortcuts";
import { useDatasetLabels, useDatasetLabelsStore } from "@/stores/dataset-labels-store";
import { buildTextSegments, findLiteralMatches, nextTextMatchIndex, resolveContainerSelectionOffsets, type TextHighlightRange } from "@/lib/workspace/text-dom-segments";
import type { SafeTextAnnotation } from "@annotationplatform/domain/text-annotation-contract";

type TextEngineProps = { selection: Extract<WorkspaceSelection, { engine: "TEXT" }> };

// Zustand snapshots must keep the same reference while the reader is loading.
const EMPTY_ANNOTATIONS: SafeTextAnnotation[] = [];

type ReaderState =
  | { status: "loading" }
  | { status: "denied" }
  | { status: "unready"; readiness: Exclude<TextSourceReadiness, "READY"> }
  | { status: "ready"; text: string; sourceIdentity: string; boundaryOffsets: readonly number[]; datasetId: string };

const READINESS_MESSAGES: Record<Exclude<TextSourceReadiness, "READY">, string> = {
  UNPREPARED: "Preparing this document for reading…",
  PREPARING: "Preparing this document for reading…",
  UNAVAILABLE: "This document's source is unavailable.",
  INVALID_ENCODING: "This document is not valid, complete UTF-8 text and cannot be opened.",
  SOURCE_MISMATCH: "This document's source changed unexpectedly and needs explicit reconciliation before it can be opened.",
  UNSUPPORTED_SIZE: "This document is larger than the supported reader size.",
  LEGACY_RECONCILIATION_REQUIRED: "This document needs a one-time migration before it can be opened.",
};

const SPINNING_READINESS = new Set<TextSourceReadiness>(["UNPREPARED", "PREPARING"]);

/**
 * The real TEXT reader (T057): escaped, selectable DOM text (React JSX
 * children are always escaped -- no `dangerouslySetInnerHTML`), rendered
 * `white-space: pre-wrap` so whitespace/line breaks match the source
 * exactly. Each rendered segment carries its own canonical `startOffset` as
 * a `data-text-start` attribute -- the DOM itself is the "source-indexed
 * segment table" (see text-dom-segments.ts), so a `Selection`/`Range`
 * anywhere in the container translates back to an exact source offset with
 * no separate bookkeeping to keep in sync.
 */
export function TextEngine({ selection }: TextEngineProps) {
  const assetId = selection.asset.id;
  const router = useRouter();
  const mounted = useRef(false);
  const pendingSpanSaves = useRef(0);
  const refreshedSource = useRef<string | null>(null);
  const [spanSaving, setSpanSaving] = useState(false);
  const [spanPreviews, setSpanPreviews] = useState<Array<{ key: string; startOffset: number; endOffset: number; labelId: string | null }>>([]);
  const selectAnnotation = useTextAnnotationStore((store) => store.selectAnnotation);
  const [retry, setRetry] = useState(0);
  const tool = useTextAnnotationStore((store) => store.tool);
  const selectedRange = useTextAnnotationStore((store) => store.selection);
  const setReader = useTextAnnotationStore((store) => store.setReader);
  const [state, setState] = useState<ReaderState>({ status: "loading" });
  const initializeAsset = useTextAnnotationStore((store) => store.initializeAsset);
  const clearAsset = useTextAnnotationStore((store) => store.clearAsset);
  const setSelection = useTextAnnotationStore((store) => store.setSelection);
  const search = useTextAnnotationStore((store) => store.search);
  const setSearch = useTextAnnotationStore((store) => store.setSearch);
  const savedAnnotations = useTextAnnotationStore((store) => store.snapshot?.savedAnnotations ?? EMPTY_ANNOTATIONS);
  const policy = useTextAnnotationStore((store) => store.policy);
  const setPolicy = useTextAnnotationStore((store) => store.setPolicy);
  const setPolicyStatus = useTextAnnotationStore((store) => store.setPolicyStatus);
  const activeEntityLabelId = useTextAnnotationStore((store) => store.activeEntityLabelId);
  const activeRelationLabelId = useTextAnnotationStore((store) => store.activeRelationLabelId);
  const pendingRelationFromId = useTextAnnotationStore((store) => store.pendingRelationFromId);
  const setPendingRelationFromId = useTextAnnotationStore((store) => store.setPendingRelationFromId);
  const commandError = useTextAnnotationStore((store) => store.commandError);
  const commandErrorConflict = useTextAnnotationStore((store) => store.commandErrorConflict);
  const setCommandError = useTextAnnotationStore((store) => store.setCommandError);
  const upsertAnnotation = useTextAnnotationStore((store) => store.upsertAnnotation);
  const undoStackSize = useTextAnnotationStore((store) => store.undoStack.length);
  const redoStackSize = useTextAnnotationStore((store) => store.redoStack.length);
  const [undoRedoBusy, setUndoRedoBusy] = useState(false);
  const containerRef = useRef<HTMLPreElement>(null);
  const selectionStartedHere = useRef(false);
  const datasetId = state.status === "ready" ? state.datasetId : null;
  const labels = useDatasetLabels(datasetId ?? "");

  useEffect(() => { if (datasetId) void useDatasetLabelsStore.getState().ensureLoaded(datasetId); }, [datasetId]);

  useEffect(() => {
    // `TextEngineEntry` keys this component by asset id, so a different
    // asset always mounts a fresh instance -- `state`'s initial value is
    // already "loading"; no explicit reset is needed here.
    mounted.current = true;
    const controller = new AbortController();
    void (async () => {
      const outcome = await ensureTextSourceReady(assetId, { signal: controller.signal }).catch(() => null);
      if (controller.signal.aborted) return;
      if (!outcome) { setState({ status: "denied" }); return; }
      if (!outcome.ok) { setState({ status: "denied" }); return; }
      if (outcome.readiness !== "READY") { setState({ status: "unready", readiness: outcome.readiness }); return; }
      setState({ status: "ready", text: outcome.text, sourceIdentity: outcome.sourceIdentity, boundaryOffsets: outcome.boundaryOffsets, datasetId: outcome.datasetId });
    })();
    return () => {
      mounted.current = false;
      controller.abort();
      clearAsset();
      // Safety net matching canvas-stage.tsx's own unmount cleanup: never
      // leave the interaction flag stuck "active" if the engine unmounts
      // mid-gesture (e.g. navigating away mid-drag or mid-relation-click).
      delete document.documentElement.dataset.annotationInteraction;
    };
    // Re-run only when the selected asset actually changes -- a scope
    // change (data-model.md "Workflow and client state") clears the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, retry]);

  useEffect(() => {
    if (state.status !== "ready") return;
    initializeAsset({
      assetId,
      datasetId: state.datasetId,
      sourceIdentity: state.sourceIdentity,
      boundaryOffsets: state.boundaryOffsets,
      savedAnnotations: selection.annotations,
      assetRevision: selection.asset.revision,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status === "ready" ? state.sourceIdentity : null]);

  // T139/T144: a realtime ANNOTATION_CHANGED invalidation re-renders the
  // server component and hands this component a fresh `selection.annotations`
  // prop via `router.refresh()` -- but the effect above only reruns on a
  // genuine asset switch (`sourceIdentity` change), so without this, another
  // user's remote edit would never reach an already-open TEXT asset's store
  // at all. Runs after the initializeAsset effect above (harmless redundant
  // application on first mount, since both start from the same prop).
  useEffect(() => {
    if (state.status !== "ready") return;
    useTextAnnotationStore.getState().applyRemoteAnnotations(assetId, selection.annotations);
  }, [assetId, state.status, selection.annotations]);

  useEffect(() => {
    if (state.status !== "ready" || selection.source.readiness === "READY" || refreshedSource.current === state.sourceIdentity) return;
    refreshedSource.current = state.sourceIdentity;
    // Refresh permission/capability projection after asynchronous preparation.
    router.refresh();
  }, [state, selection.source.readiness, router]);

  // Fetches the dataset's resolved TEXT taxonomy policy fresh for every
  // asset scope (`initializeAsset` already reset `policy`/`policyStatus` to
  // null/idle above) -- span/relation creation needs its current `revision`
  // as `expectedPolicyRevision`, and a stale one only ever fails safely
  // (POLICY_STALE), never silently misapplies a command.
  useEffect(() => {
    if (state.status !== "ready") return;
    let cancelled = false;
    setPolicyStatus("loading");
    void fetchTextEligiblePolicy(state.datasetId).catch(() => null).then((result) => {
      if (cancelled) return;
      if (result) setPolicy(result);
      else setPolicyStatus("error");
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status === "ready" ? state.sourceIdentity : null, labels]);

  useEffect(() => {
    setReader({ workspace: selection, status: state.status, sourceText: state.status === "ready" ? state.text : undefined, sourceLength: state.status === "ready" ? state.text.length : null, readiness: state.status === "unready" ? state.readiness : state.status.toUpperCase() });
  }, [selection, state, setReader]);

  const spanHighlights: TextHighlightRange[] = useMemo(() => {
    return savedAnnotations
      .filter((annotation): annotation is SafeTextAnnotation & { geometry: { kind: "text-span"; startOffset: number; endOffset: number } } => annotation.geometry.kind === "text-span")
      .map((annotation) => {
        const label = annotation.labelId ? labels.find((item) => item.id === annotation.labelId) : null;
        return {
          key: `span-${annotation.id}`,
          kind: annotation.id === pendingRelationFromId ? "span-pending-relation" as const : "span" as const,
          startOffset: annotation.geometry.startOffset,
          endOffset: annotation.geometry.endOffset,
          annotationId: annotation.id,
          color: label?.color ?? "#a1a1aa",
          label: label?.name ?? "Entity",
        };
      });
  }, [savedAnnotations, pendingRelationFromId, labels]);

  const highlights: TextHighlightRange[] = useMemo(() => {
    if (state.status !== "ready") return [];
    const searchHighlights = search.matches
      .map((match, index) => ({ key: `search-${match.startOffset}`, kind: index === search.activeMatchIndex ? "search-match-active" as const : "search-match" as const, startOffset: match.startOffset, endOffset: match.endOffset }));
    const previews: TextHighlightRange[] = spanPreviews.map((preview) => ({ ...preview, kind: "span", color: labels.find((label) => label.id === preview.labelId)?.color ?? "#a1a1aa", label: `${labels.find((label) => label.id === preview.labelId)?.name ?? "Entity"} (saving)` }));
    return [...spanHighlights, ...previews, ...searchHighlights].sort((a, b) => a.startOffset - b.startOffset);
  }, [state, search.matches, search.activeMatchIndex, spanHighlights, spanPreviews, labels]);

  const segments = useMemo(() => (state.status === "ready" ? buildTextSegments(state.text, highlights) : []), [state, highlights]);

  useEffect(() => {
    if (search.activeMatchIndex === null) return;
    containerRef.current?.querySelector('[data-kind="search-match-active"]')?.scrollIntoView({ block: "center" });
  }, [search.activeMatchIndex, search.matches]);

  function handleSelectionChange() {
    if (!containerRef.current || tool !== "select" || !selection.capabilities.select) return;
    setSelection(resolveContainerSelectionOffsets(containerRef.current));
  }

  async function handleHighlightSpanMouseUp() {
    if (!containerRef.current || state.status !== "ready" || !selection.capabilities.span || !policy || useTextAnnotationStore.getState().policyStatus !== "loaded") return;
    const range = normalizeTextSpanSelection(resolveContainerSelectionOffsets(containerRef.current), state.boundaryOffsets);
    if (!range) return;
    const labelId = activeEntityLabelId && policy.entityLabelIds.includes(activeEntityLabelId) ? activeEntityLabelId : null;
    const operationId = randomUUIDAuto();
    // Capture the canonical selection into Text Engine state before doing
    // anything else -- this is the source of truth from here on, survives
    // toolbar/label interaction, and (per the failure branch below) is only
    // cleared once the mutation actually succeeds.
    setSelection(range);
    setSpanPreviews((previews) => [...previews, { key: operationId, ...range, labelId }]);
    pendingSpanSaves.current += 1;
    setSpanSaving(true);
    setCommandError(null);
    window.getSelection()?.removeAllRanges();
    try {
      const outcome = await submitTextAnnotationCommand<SafeTextAnnotation>(assetId, {
        operationId,
        sourceIdentity: state.sourceIdentity,
        expectedPolicyRevision: policy.revision,
        command: { kind: "createSpan", ...range, labelId },
      });
      if (!mounted.current || useTextAnnotationStore.getState().assetId !== assetId) return;
      if (outcome.ok) { upsertAnnotation(outcome.result); selectAnnotation(outcome.result.id); setSelection(null); }
      else setCommandError(describeTextCommandFailure(outcome), isTextCommandConflict(outcome.reason));
    } catch {
      if (mounted.current) setCommandError("The span could not be saved. Check your connection, then try again -- your selection is still available.");
    } finally {
      pendingSpanSaves.current -= 1;
      if (mounted.current) { setSpanSaving(pendingSpanSaves.current > 0); setSpanPreviews((previews) => previews.filter((preview) => preview.key !== operationId)); }
    }
  }

  const finishPointerSelection = useEffectEvent(() => {
    if (!selectionStartedHere.current) return;
    selectionStartedHere.current = false;
    // T145/T152: mirrors canvas-stage.tsx's exact `document.documentElement.
    // dataset.annotationInteraction` lifecycle (set on gesture start, cleared
    // on gesture end) -- the one flag both presence's EDITING heuristic and
    // `use-workflow-shortcuts.ts`'s Submit/Approve suppression already read.
    // TEXT's interactive surface (a plain `<pre>`, not an input/textarea/
    // contenteditable/canvas) never matched that heuristic before this.
    delete document.documentElement.dataset.annotationInteraction;
    if (tool === "highlightspan") void handleHighlightSpanMouseUp();
    else handleSelectionChange();
  });

  async function handleUndo() {
    if (state.status !== "ready" || !policy || undoRedoBusy || undoStackSize === 0) return;
    setUndoRedoBusy(true); setCommandError(null);
    const outcome = await undoLastTextCommand(assetId, state.sourceIdentity, policy.revision);
    if (mounted.current) { setUndoRedoBusy(false); if (!outcome.ok) setCommandError(outcome.reason); }
  }

  async function handleRedo() {
    if (state.status !== "ready" || !policy || undoRedoBusy || redoStackSize === 0) return;
    setUndoRedoBusy(true); setCommandError(null);
    const outcome = await redoLastTextCommand(assetId, state.sourceIdentity, policy.revision);
    if (mounted.current) { setUndoRedoBusy(false); if (!outcome.ok) setCommandError(outcome.reason); }
  }

  useTextUndoRedoShortcuts({ canUndo: undoStackSize > 0 && !undoRedoBusy, canRedo: redoStackSize > 0 && !undoRedoBusy, onUndo: () => void handleUndo(), onRedo: () => void handleRedo() });

  useEffect(() => {
    const onMouseUp = () => finishPointerSelection();
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, []);

  // T096: warn on tab close / navigate-away while there is unsaved TEXT
  // work -- an in-flight annotation command (createSpan/updateSpan/
  // deleteAnnotation/createRelation/updateRelation) or a description edit
  // still waiting out its autosave debounce. Nothing is persisted to
  // browser storage to make this check; it only reads current in-memory
  // state synchronously, as `beforeunload` requires.
  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      const descriptionState = useAnnotationStore.getState().saveStates[`text-description:${assetId}`];
      if (!hasPendingTextAnnotationCommands(assetId) && descriptionState !== "pending" && descriptionState !== "saving") return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [assetId]);

  async function handleEntityClick(event: ReactMouseEvent<HTMLPreElement>) {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-annotation-id]") : null;
    const clickedId = target?.getAttribute("data-annotation-id");
    if (!clickedId || !savedAnnotations.some((annotation) => annotation.id === clickedId && annotation.geometry.kind === "text-span")) return;
    if (tool === "select" && !window.getSelection()?.toString()) { selectAnnotation(clickedId); return; }
    if (tool !== "relation" || state.status !== "ready" || !policy || !selection.capabilities.relation || useTextAnnotationStore.getState().policyStatus !== "loaded") return;
    if (pendingRelationFromId === clickedId) { setPendingRelationFromId(null); setCommandError(null); delete document.documentElement.dataset.annotationInteraction; return; }
    if (!activeRelationLabelId || !policy.relationTypes.some((type) => type.relationLabelId === activeRelationLabelId)) { setCommandError("Choose a relation label in the Labels panel first."); return; }
    if (!pendingRelationFromId) { setPendingRelationFromId(clickedId); setCommandError(null); document.documentElement.dataset.annotationInteraction = "active"; return; }
    // pendingRelationFromId stays set through the request -- only a
    // successful mutation consumes it. A failure leaves the source span
    // still marked pending so the user can retry with another click on the
    // target (or cancel by clicking the source span again) without
    // reselecting it.
    const fromAnnotationId = pendingRelationFromId;
    setCommandError(null);
    const outcome = await submitTextAnnotationCommand<SafeTextAnnotation>(assetId, {
      operationId: randomUUIDAuto(), sourceIdentity: state.sourceIdentity, expectedPolicyRevision: policy.revision,
      command: { kind: "createRelation", relationLabelId: activeRelationLabelId, fromAnnotationId, toAnnotationId: clickedId },
    });
    if (!mounted.current || useTextAnnotationStore.getState().assetId !== assetId) return;
    if (outcome.ok) { setPendingRelationFromId(null); upsertAnnotation(outcome.result); selectAnnotation(outcome.result.id); delete document.documentElement.dataset.annotationInteraction; }
    else setCommandError(describeTextCommandFailure(outcome), isTextCommandConflict(outcome.reason));
    // On failure, pendingRelationFromId (and the interaction flag) deliberately stay set -- see the comment above this function's relation branch.
  }

  function handleSearchQueryChange(query: string) {
    if (state.status !== "ready") return;
    const matches = findLiteralMatches(state.text, query);
    setSearch({ query, matches, activeMatchIndex: matches.length > 0 ? 0 : null });
  }

  function moveToMatch(delta: 1 | -1) {
    if (search.matches.length === 0) return;
    setSearch({ activeMatchIndex: nextTextMatchIndex(search.activeMatchIndex, search.matches.length, delta) });
  }

  if (state.status === "loading") {
    return <StatePlaceholder icon={<SpinnerGap className="mx-auto animate-spin text-zinc-400" size={26} />} message="Loading document…" />;
  }
  if (state.status === "denied") {
    return <StatePlaceholder icon={<WarningCircle className="mx-auto text-rose-400" size={26} weight="duotone" />} message="This document could not be loaded. Check your connection and access, then retry." onRetry={() => { setState({ status: "loading" }); setRetry((value) => value + 1); }} />;
  }
  if (state.status === "unready") {
    const spinning = SPINNING_READINESS.has(state.readiness);
    return (
      <StatePlaceholder
        icon={spinning ? <SpinnerGap className="mx-auto animate-spin text-zinc-400" size={26} /> : <WarningCircle className="mx-auto text-amber-400" size={26} weight="duotone" />}
        message={READINESS_MESSAGES[state.readiness]}
        onRetry={() => { setState({ status: "loading" }); setRetry((value) => value + 1); }}
      />
    );
  }

  return (
    <section data-annotation-interaction="true" className="flex min-h-[520px] min-w-0 flex-col border border-zinc-200 bg-white lg:min-h-0">
      <TextSearchBar
        query={search.query}
        matchCount={search.matches.length}
        activeMatchIndex={search.activeMatchIndex}
        onQueryChange={handleSearchQueryChange}
        onNext={() => moveToMatch(1)}
        onPrevious={() => moveToMatch(-1)}
        onClear={() => setSearch({ query: "", matches: [], activeMatchIndex: null })}
      />
      <div className="flex items-center gap-1.5 border-b border-zinc-200 px-3 py-1.5">
        <button type="button" aria-label="Undo" title="Undo (Ctrl/Cmd+Z)" disabled={undoStackSize === 0 || undoRedoBusy} onClick={() => void handleUndo()} className="grid size-7 place-items-center rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 disabled:opacity-40">
          <ArrowArcLeft size={14} />
        </button>
        <button type="button" aria-label="Redo" title="Redo (Ctrl/Cmd+Shift+Z)" disabled={redoStackSize === 0 || undoRedoBusy} onClick={() => void handleRedo()} className="grid size-7 place-items-center rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 disabled:opacity-40">
          <ArrowArcRight size={14} />
        </button>
      </div>
      {spanSaving ? <p role="status" className="px-4 py-1.5 text-xs text-zinc-600">Saving span…</p> : null}
      {commandError && commandErrorConflict ? (
        <div className="border-b border-zinc-200 px-4 py-2">
          <SaveConflictPanel message={commandError} onReload={() => router.refresh()} onDiscard={() => setCommandError(null)} />
        </div>
      ) : commandError ? (
        <p role="alert" className="border-b border-rose-200 bg-rose-50 px-4 py-1.5 text-[11px] text-rose-700">{commandError} <button type="button" onClick={() => setCommandError(null)} className="ml-1 font-semibold underline">Dismiss</button></p>
      ) : null}
      <pre
        ref={containerRef}
        onMouseDown={() => { selectionStartedHere.current = true; document.documentElement.dataset.annotationInteraction = "active"; }}
        onClick={(event) => void handleEntityClick(event)}
        onKeyUp={(event) => { if (tool === "highlightspan" && event.key === "Shift") void handleHighlightSpanMouseUp(); else handleSelectionChange(); }}
        tabIndex={0}
        aria-label="Document text"
        style={{ userSelect: tool === "scroll" ? "none" : "text" }}
        className="min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-6 py-5 font-mono text-sm leading-6 text-zinc-900 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500 selection:bg-sky-200"
      >
        {segments.map((segment) => (
          <span
            key={segment.key}
            data-text-start={segment.startOffset}
            data-kind={segment.kind}
            data-annotation-id={segment.annotationId}
            title={segment.label}
            className={
              segment.kind === "search-match-active"
                ? "rounded-sm bg-amber-300"
                : segment.kind === "search-match"
                  ? "rounded-sm bg-amber-100"
                  : segment.kind === "span" || segment.kind === "span-pending-relation"
                    ? `rounded-sm border-b-2 ${tool === "relation" ? "cursor-pointer" : ""} ${segment.kind === "span-pending-relation" ? "ring-1 ring-sky-500" : ""}`
                    : undefined
            }
            style={segment.kind === "span" || segment.kind === "span-pending-relation" ? { backgroundColor: `${segment.color}26`, borderBottomColor: segment.color } : undefined}
          >
            {segment.text}
          </span>
        ))}
      </pre>
      {tool === "relation" && pendingRelationFromId ? <p className="border-t border-zinc-200 bg-sky-50 px-4 py-1.5 text-[11px] text-sky-700" aria-live="polite">Click another entity to link it, or click the same one again to cancel.</p> : null}
      <div className="border-t border-zinc-200 px-4 py-2 text-xs text-zinc-600">
        <TextOffsetInspector sourceLength={state.text.length} selection={selectedRange} />
        {selectedRange ? <q className="ml-2 inline-block max-w-64 truncate align-bottom">{state.text.slice(selectedRange.startOffset, selectedRange.endOffset)}</q> : null}
      </div>
    </section>
  );
}

function StatePlaceholder({ icon, message, onRetry }: { icon: React.ReactNode; message: string; onRetry?: () => void }) {
  return (
    <section className="canvas-grid grid min-h-[520px] min-w-0 place-items-center bg-zinc-950 px-6 text-center text-zinc-100 lg:min-h-0">
      <div className="max-w-sm">
        <TextT className="mx-auto mb-1 text-amber-300" size={22} weight="duotone" aria-hidden />
        {icon}
        <p role="status" className="mt-3 text-sm leading-6 text-zinc-300">{message}</p>
        {onRetry ? <button type="button" onClick={onRetry} className="mt-3 rounded border border-zinc-500 px-3 py-2 text-sm">Retry loading</button> : null}
      </div>
    </section>
  );
}

function TextSearchBar({ query, matchCount, activeMatchIndex, onQueryChange, onNext, onPrevious, onClear }: {
  query: string;
  matchCount: number;
  activeMatchIndex: number | null;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-2">
      <MagnifyingGlass className="shrink-0 text-zinc-400" size={16} aria-hidden />
      <input
        type="text"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); if (event.shiftKey) onPrevious(); else onNext(); }
          if (event.key === "Escape") { event.preventDefault(); onClear(); }
        }}
        placeholder="Search this document"
        aria-label="Search this document"
        className="h-8 min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs text-zinc-900 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
      />
      {query ? (
        <span className="shrink-0 text-[11px] font-semibold text-zinc-500" aria-live="polite">
          {matchCount === 0 ? "No matches" : `${(activeMatchIndex ?? 0) + 1} of ${matchCount}`}
        </span>
      ) : null}
      <button type="button" aria-label="Previous match" disabled={matchCount === 0} onClick={onPrevious} className="grid size-7 shrink-0 place-items-center rounded-lg border border-zinc-200 text-zinc-500 hover:bg-white disabled:opacity-40">
        <CaretUp size={13} />
      </button>
      <button type="button" aria-label="Next match" disabled={matchCount === 0} onClick={onNext} className="grid size-7 shrink-0 place-items-center rounded-lg border border-zinc-200 text-zinc-500 hover:bg-white disabled:opacity-40">
        <CaretDown size={13} />
      </button>
      {query ? (
        <button type="button" aria-label="Clear search" onClick={onClear} className="grid size-7 shrink-0 place-items-center rounded-lg border border-zinc-200 text-zinc-500 hover:bg-white">
          <X size={13} />
        </button>
      ) : null}
    </div>
  );
}
