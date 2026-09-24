"use client";

import { useState } from "react";
import type { SafeTextAnnotation } from "@annotationplatform/domain/text-annotation-contract";
import { TEXT_CUSTOM_PROPERTY_LIMITS } from "@annotationplatform/domain/text-properties-contract";
import { submitTextAnnotationCommand } from "@/lib/annotations/text-annotation-client";
import { describeTextCommandFailure } from "@/lib/annotations/text-command-error";
import { randomUUIDAuto } from "@/lib/browser-random-uuid";
import { useTextAnnotationStore } from "@/stores/text-annotation-store";

export type DraftValueType = "string" | "number" | "boolean" | "null";
export type DraftRow = { key: string; type: DraftValueType; value: string };

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Exported for `text-properties-editor.vitest.spec.ts` -- this repo has no `@testing-library/react` (or any component-rendering test infra) installed, so UI logic is proven as extracted pure functions, matching `text-span-selection.ts`'s own testing pattern, not full render/keyboard-event tests. */
export function toDraftRows(custom: Record<string, unknown>): DraftRow[] {
  return Object.entries(custom).map(([key, value]) => ({
    key,
    type: value === null ? "null" : typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string",
    value: value === null ? "" : String(value),
  }));
}

export function draftValueToStored(row: DraftRow): string | number | boolean | null {
  if (row.type === "null") return null;
  if (row.type === "boolean") return row.value === "true";
  if (row.type === "number") { const parsed = Number(row.value); return Number.isFinite(parsed) ? parsed : 0; }
  return row.value;
}

/**
 * T084: custom-property editor for a selected TEXT span (T073's
 * `updateSpan` `propertyPatch` -- span-only; relation property patching is
 * a separate, not-yet-built command, see T128). Typed key/value rows with
 * an explicit null value; "Remove" marks a key for `unset` rather than
 * deleting it locally. Everything commits in exactly one `propertyPatch` on
 * deliberate Save -- never per-keystroke, matching every other TEXT
 * mutation's action-boundary commit rule.
 */
export function TextCustomPropertiesEditor({ annotation, expectedPolicyRevision, readOnly }: {
  annotation: SafeTextAnnotation; expectedPolicyRevision: number | null; readOnly: boolean;
}) {
  const custom = annotation.properties.custom;
  const [rows, setRows] = useState<DraftRow[]>(() => toDraftRows(custom));
  const [removedKeys, setRemovedKeys] = useState<Set<string>>(new Set());
  const [newKey, setNewKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateRow(index: number, changes: Partial<DraftRow>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...changes } : row)));
  }

  function removeRow(index: number) {
    setRows((current) => {
      const row = current[index];
      if (row) setRemovedKeys((keys) => new Set(keys).add(row.key));
      return current.filter((_, i) => i !== index);
    });
  }

  function addRow() {
    const key = newKey.trim();
    if (!key) return;
    if (!KEY_PATTERN.test(key) || key.length > TEXT_CUSTOM_PROPERTY_LIMITS.maxKeyLength) { setError("Keys must start with a letter and contain only letters, numbers, and underscores."); return; }
    if (rows.some((row) => row.key === key)) { setError("That key already exists."); return; }
    setError(null);
    setRows((current) => [...current, { key, type: "string", value: "" }]);
    setRemovedKeys((keys) => { const next = new Set(keys); next.delete(key); return next; });
    setNewKey("");
  }

  async function save() {
    if (readOnly || saving || expectedPolicyRevision === null) return;
    const set: Record<string, string | number | boolean | null> = {};
    for (const row of rows) { if (row.key) set[row.key] = draftValueToStored(row); }
    const unset = [...removedKeys].filter((key) => !(key in set));
    if (Object.keys(set).length === 0 && unset.length === 0) return;
    // Compute the inverse patch against `custom` (this component's original
    // prop, the pre-edit map) before submitting -- T095's Undo/Redo core. A
    // changed/newly-set key restores its old value if it had one, else it
    // must be unset (it did not exist before); an unset key is always
    // restored to its old value (it existed, or it could not have been in
    // `removedKeys` in the first place).
    const inverseSet: Record<string, string | number | boolean | null> = {};
    const inverseUnset: string[] = [];
    for (const key of Object.keys(set)) {
      if (Object.hasOwn(custom, key)) inverseSet[key] = custom[key] as string | number | boolean | null;
      else inverseUnset.push(key);
    }
    for (const key of unset) { if (Object.hasOwn(custom, key)) inverseSet[key] = custom[key] as string | number | boolean | null; }
    setSaving(true); setError(null);
    const result = await submitTextAnnotationCommand<SafeTextAnnotation>(annotation.assetId, {
      operationId: randomUUIDAuto(), sourceIdentity: annotation.geometry.sourceIdentity, expectedPolicyRevision,
      command: { kind: "updateSpan", annotationId: annotation.id, expectedRevision: annotation.revision, propertyPatch: { set, unset } },
    });
    if (useTextAnnotationStore.getState().assetId !== annotation.assetId) return;
    setSaving(false);
    if (result.ok) {
      useTextAnnotationStore.getState().upsertAnnotation(result.result);
      setRemovedKeys(new Set());
      if (Object.keys(inverseSet).length > 0 || inverseUnset.length > 0) {
        useTextAnnotationStore.getState().pushUndoEntry({ kind: "properties", annotationId: annotation.id, inversePatch: { set: inverseSet, unset: inverseUnset }, redoPatch: { set, unset } });
      }
    }
    else setError(describeTextCommandFailure(result));
  }

  return (
    <section aria-label="Custom properties" className="mt-3 space-y-2 rounded-lg border border-zinc-200 p-3">
      <h4 className="text-xs font-semibold text-zinc-700">Custom properties</h4>
      <fieldset disabled={readOnly || saving || expectedPolicyRevision === null} className="space-y-2 disabled:opacity-60">
        {rows.length === 0 ? <p className="text-[11px] text-zinc-400">No custom properties yet.</p> : rows.map((row, index) => (
          <div key={`${row.key}-${index}`} className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate rounded border border-zinc-200 bg-zinc-50 px-2 py-1 font-mono text-[11px]" title={row.key}>{row.key}</span>
            <select aria-label={`Type for ${row.key}`} value={row.type} onChange={(event) => updateRow(index, { type: event.target.value as DraftValueType })} className="shrink-0 rounded border border-zinc-200 bg-white px-1 py-1 text-[11px]">
              <option value="string">Text</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
              <option value="null">Null</option>
            </select>
            {row.type === "boolean" ? (
              <select aria-label={`Value for ${row.key}`} value={row.value === "true" ? "true" : "false"} onChange={(event) => updateRow(index, { value: event.target.value })} className="w-16 shrink-0 rounded border border-zinc-200 bg-white px-1 py-1 text-[11px]">
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : row.type === "null" ? (
              <span className="w-16 shrink-0 px-1 py-1 text-center font-mono text-[11px] text-zinc-400">null</span>
            ) : (
              <input aria-label={`Value for ${row.key}`} value={row.value} onChange={(event) => updateRow(index, { value: event.target.value })} maxLength={TEXT_CUSTOM_PROPERTY_LIMITS.maxStringCodeUnits} className="w-20 min-w-0 flex-1 rounded border border-zinc-200 px-1.5 py-1 text-[11px]" />
            )}
            <button type="button" onClick={() => removeRow(index)} className="shrink-0 text-[11px] font-semibold text-rose-700">Remove</button>
          </div>
        ))}
        <div className="flex items-center gap-1.5 border-t border-zinc-100 pt-2">
          <input aria-label="New property key" value={newKey} onChange={(event) => setNewKey(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addRow(); } }} maxLength={TEXT_CUSTOM_PROPERTY_LIMITS.maxKeyLength} disabled={rows.length >= TEXT_CUSTOM_PROPERTY_LIMITS.maxKeys} placeholder="key" className="min-w-0 flex-1 rounded border border-zinc-200 px-2 py-1 font-mono text-[11px] disabled:opacity-50" />
          <button type="button" onClick={addRow} disabled={rows.length >= TEXT_CUSTOM_PROPERTY_LIMITS.maxKeys} className="shrink-0 rounded border border-zinc-200 px-2 py-1 text-[11px] font-semibold text-zinc-700 disabled:opacity-50">Add</button>
        </div>
        <button type="button" onClick={() => void save()} className="rounded bg-zinc-900 px-3 py-1.5 text-xs text-white disabled:opacity-50">{saving ? "Saving…" : "Save properties"}</button>
      </fieldset>
      {error && <p role="alert" className="text-[11px] text-rose-700">{error}</p>}
    </section>
  );
}
