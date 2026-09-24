"use client";

import { useState } from "react";
import type { SafeTextAnnotation } from "@annotationplatform/domain/text-annotation-contract";
import type { DatasetLabel } from "@/stores/dataset-labels-store";
import { useTextAnnotationStore } from "@/stores/text-annotation-store";
import { submitTextAnnotationCommand } from "@/lib/annotations/text-annotation-client";
import { randomUUIDAuto } from "@/lib/browser-random-uuid";
import type { TextEligiblePolicy } from "@/lib/workspace/text-policy-client";
import { describeTextCommandFailure } from "@/lib/annotations/text-command-error";

export function TextAnnotationEditor({ annotation, annotations, labels, policy, sourceText, readOnly }: {
  annotation: SafeTextAnnotation; annotations: SafeTextAnnotation[]; labels: DatasetLabel[];
  policy: TextEligiblePolicy | null; sourceText: string; readOnly: boolean;
}) {
  const relation = annotation.geometry.kind === "text-relation";
  const [labelId, setLabelId] = useState(annotation.labelId ?? "");
  const [fromId, setFromId] = useState(annotation.fromAnnotationId ?? "");
  const [toId, setToId] = useState(annotation.toAnnotationId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eligible = relation ? policy?.relationTypes.map((type) => type.relationLabelId) ?? [] : policy?.entityLabelIds ?? [];
  const spans = annotations.filter((item) => item.geometry.kind === "text-span");
  const excerpt = (item: SafeTextAnnotation) => item.geometry.kind === "text-span" ? sourceText.slice(item.geometry.startOffset, item.geometry.endOffset) : "";

  /**
   * Entity (span) relabeling auto-saves on select change -- no separate
   * "Apply changes" step. Changing the label commits an `updateSpan` whose
   * result is written into the store via `upsertAnnotation`, which is what
   * makes the span's rendered highlight color follow the new label
   * immediately (`text-engine.tsx` derives highlight color from the current
   * `labelId` on every render, not from a cached value).
   */
  async function saveEntityLabel(nextValue: string) {
    setLabelId(nextValue);
    if (readOnly || saving || !policy || relation) return;
    const nextLabelId = nextValue || null;
    if (nextLabelId === annotation.labelId) return;
    setSaving(true); setError(null);
    const result = await submitTextAnnotationCommand<SafeTextAnnotation>(annotation.assetId, {
      operationId: randomUUIDAuto(), sourceIdentity: annotation.geometry.sourceIdentity, expectedPolicyRevision: policy.revision,
      command: { kind: "updateSpan", annotationId: annotation.id, expectedRevision: annotation.revision, labelId: nextLabelId },
    });
    if (useTextAnnotationStore.getState().assetId !== annotation.assetId) return;
    setSaving(false);
    if (result.ok) {
      useTextAnnotationStore.getState().upsertAnnotation(result.result);
      useTextAnnotationStore.getState().pushUndoEntry({ kind: "label", annotationId: annotation.id, inverseLabelId: annotation.labelId, redoLabelId: nextLabelId });
    } else {
      setLabelId(annotation.labelId ?? "");
      setError(describeTextCommandFailure(result));
    }
  }

  async function saveRelation() {
    if (readOnly || saving || !policy) return;
    setSaving(true); setError(null);
    const result = await submitTextAnnotationCommand<SafeTextAnnotation>(annotation.assetId, {
      operationId: randomUUIDAuto(), sourceIdentity: annotation.geometry.sourceIdentity, expectedPolicyRevision: policy.revision,
      command: { kind: "updateRelation", annotationId: annotation.id, expectedRevision: annotation.revision, relationLabelId: labelId, fromAnnotationId: fromId, toAnnotationId: toId },
    });
    if (useTextAnnotationStore.getState().assetId !== annotation.assetId) return;
    setSaving(false);
    if (result.ok) useTextAnnotationStore.getState().upsertAnnotation(result.result);
    // Relation retarget has no Undo/Redo command yet (US4, T135 -- known gap).
    else setError(describeTextCommandFailure(result));
  }

  if (relation) {
    return <section aria-label="Annotation properties" className="mt-3 space-y-3 rounded-lg border border-sky-200 bg-sky-50 p-3">
      <h3 className="text-xs font-semibold">Relation properties · revision {annotation.revision}</h3>
      <fieldset disabled={readOnly || saving || !policy} className="min-w-0 space-y-3 disabled:opacity-60">
        <label className="block text-xs">Annotation label<select aria-label="Annotation label" value={labelId} onChange={(event) => setLabelId(event.target.value)} className="mt-1 min-w-0 w-full max-w-full rounded border bg-white p-1.5">
          {labels.filter((label) => eligible.includes(label.id)).map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}
        </select></label>
        {([['Source entity', fromId, setFromId], ['Target entity', toId, setToId]] as const).map(([title, value, setValue]) => <label key={title} className="block text-xs">{title}<select aria-label={title} value={value} onChange={(event) => setValue(event.target.value)} className="mt-1 min-w-0 w-full max-w-full rounded border bg-white p-1.5">{spans.map((span) => <option key={span.id} value={span.id}>{excerpt(span)} · {labels.find((label) => label.id === span.labelId)?.name ?? "No label"} · {span.id}</option>)}</select></label>)}
        <button type="button" disabled={!labelId || fromId === toId} onClick={() => void saveRelation()} className="rounded bg-zinc-900 px-3 py-1.5 text-xs text-white disabled:opacity-50">{saving ? "Saving…" : "Apply changes"}</button>
      </fieldset>
      {readOnly && <p className="text-xs text-zinc-600">This asset is read-only.</p>}
      {error && <p role="alert" className="text-xs text-rose-700">{error}</p>}
    </section>;
  }

  return <section aria-label="Annotation properties" className="mt-3 space-y-3 rounded-lg border border-sky-200 bg-sky-50 p-3">
    <h3 className="text-xs font-semibold">Entity properties · revision {annotation.revision}</h3>
    <blockquote className="whitespace-pre-wrap break-words text-xs">{excerpt(annotation)}</blockquote>
    <fieldset disabled={readOnly || saving || !policy} className="min-w-0 space-y-3 disabled:opacity-60">
      <label className="block text-xs">Annotation label<select aria-label="Annotation label" value={labelId} onChange={(event) => void saveEntityLabel(event.target.value)} className="mt-1 min-w-0 w-full max-w-full rounded border bg-white p-1.5">
        <option value="">No label</option>
        {labels.filter((label) => eligible.includes(label.id)).map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}
      </select></label>
    </fieldset>
    {saving && <p className="text-xs text-zinc-600">Saving…</p>}
    {readOnly && <p className="text-xs text-zinc-600">This asset is read-only.</p>}
    {error && <p role="alert" className="text-xs text-rose-700">{error}</p>}
  </section>;
}
