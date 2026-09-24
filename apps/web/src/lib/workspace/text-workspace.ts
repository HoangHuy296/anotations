"use client";

import type { SafeTextAnnotation } from "@annotationplatform/domain/text-annotation-contract";
import { submitTextAnnotationCommand } from "@/lib/annotations/text-annotation-client";
import { describeTextCommandFailure } from "@/lib/annotations/text-command-error";
import { randomUUIDAuto } from "@/lib/browser-random-uuid";
import { useTextAnnotationStore, type TextUndoEntry } from "@/stores/text-annotation-store";

/**
 * T095: Undo/Redo core orchestration -- the only place that actually
 * submits an entry's inverse/forward command. Every entry acts on an
 * *existing* span via `updateSpan`; there is no local-snapshot rollback
 * (data-model.md "Workflow and client state") and no revision carried in
 * the entry itself -- `expectedRevision` is always read fresh from the
 * store immediately before submitting, since other edits may have advanced
 * it since the entry was recorded. A conflicting/failed inverse leaves
 * durable content and the undo/redo stacks exactly as they were (the
 * popped entry is put back, never silently dropped) -- data-model.md's
 * "a conflicting inverse leaves durable content intact."
 */

export type TextUndoRedoOutcome = { ok: true } | { ok: false; reason: string };

function currentAnnotation(assetId: string, annotationId: string): SafeTextAnnotation | null {
  const state = useTextAnnotationStore.getState();
  if (state.assetId !== assetId) return null;
  return state.snapshot?.savedAnnotations.find((item) => item.id === annotationId) ?? null;
}

function entryPatch(entry: TextUndoEntry, direction: "undo" | "redo"): { labelId?: string | null; startOffset?: number; endOffset?: number; propertyPatch?: { set: Record<string, string | number | boolean | null>; unset: string[] } } {
  if (entry.kind === "label") return { labelId: direction === "undo" ? entry.inverseLabelId : entry.redoLabelId };
  if (entry.kind === "geometry") return direction === "undo" ? entry.inverseRange : entry.redoRange;
  return { propertyPatch: direction === "undo" ? entry.inversePatch : entry.redoPatch };
}

async function submitEntry(assetId: string, sourceIdentity: string, expectedPolicyRevision: number, entry: TextUndoEntry, direction: "undo" | "redo"): Promise<TextUndoRedoOutcome> {
  const current = currentAnnotation(assetId, entry.annotationId);
  if (!current) return { ok: false, reason: "This annotation no longer exists." };
  const result = await submitTextAnnotationCommand<SafeTextAnnotation>(assetId, {
    operationId: randomUUIDAuto(), sourceIdentity, expectedPolicyRevision,
    command: { kind: "updateSpan", annotationId: entry.annotationId, expectedRevision: current.revision, ...entryPatch(entry, direction) },
  });
  if (!result.ok) return { ok: false, reason: describeTextCommandFailure(result) };
  if (useTextAnnotationStore.getState().assetId === assetId) useTextAnnotationStore.getState().upsertAnnotation(result.result);
  return { ok: true };
}

/**
 * Pops the top undo entry immediately (committing to that specific entry
 * before the async request, rather than re-deriving "top of stack" after
 * it -- avoids popping a different entry a concurrent edit may have pushed
 * meanwhile), submits its inverse, and on success moves it to the redo
 * stack. On failure, or if the asset scope changed mid-flight, the entry
 * is put back at the top of the undo stack so the user can retry.
 */
export async function undoLastTextCommand(assetId: string, sourceIdentity: string, expectedPolicyRevision: number): Promise<TextUndoRedoOutcome> {
  const entry = useTextAnnotationStore.getState().popUndoEntry();
  if (!entry) return { ok: false, reason: "Nothing to undo." };
  const outcome = await submitEntry(assetId, sourceIdentity, expectedPolicyRevision, entry, "undo");
  if (useTextAnnotationStore.getState().assetId !== assetId) return outcome;
  if (!outcome.ok) { useTextAnnotationStore.getState().restoreUndoEntry(entry); return outcome; }
  useTextAnnotationStore.getState().pushRedoEntry(entry);
  return outcome;
}

/** Mirrors `undoLastTextCommand`: pops the top redo entry, submits its forward patch, and on success returns it to the undo stack (without clearing any remaining redo history below it). */
export async function redoLastTextCommand(assetId: string, sourceIdentity: string, expectedPolicyRevision: number): Promise<TextUndoRedoOutcome> {
  const entry = useTextAnnotationStore.getState().popRedoEntry();
  if (!entry) return { ok: false, reason: "Nothing to redo." };
  const outcome = await submitEntry(assetId, sourceIdentity, expectedPolicyRevision, entry, "redo");
  if (useTextAnnotationStore.getState().assetId !== assetId) return outcome;
  if (!outcome.ok) { useTextAnnotationStore.getState().pushRedoEntry(entry); return outcome; }
  useTextAnnotationStore.getState().restoreUndoEntry(entry);
  return outcome;
}
