"use client";

import { useEffect, useRef, useState } from "react";

import type { SafeVideoTemporalLabel } from "@/types/video-annotation";
import { TemporalLabelAutosaveCoordinator, type VideoSaveState } from "@/lib/workspace/video-autosave";
import { createVideoTemporalLabel, deleteVideoTemporalLabel } from "@/lib/workspace/video-annotation-client";

type Draft = { startMs: number; endMs: number; labelId: string };
type Props = { labels: SafeVideoTemporalLabel[]; selectedId?: string | null; onSelect?: (id: string) => void; assetId?: string; durationMs?: number | null };

const minimumIntervalMs = 1;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function boundedTemporalDraft(input: Draft, durationMs: number): Draft {
  const startMs = clamp(Math.round(input.startMs), 0, Math.max(0, durationMs - minimumIntervalMs));
  const endMs = clamp(Math.round(input.endMs), startMs + minimumIntervalMs, durationMs);
  return { ...input, startMs, endMs };
}
export function translateTemporalDraft(input: Draft, deltaMs: number, durationMs: number): Draft {
  const bounded = boundedTemporalDraft(input, durationMs);
  const length = bounded.endMs - bounded.startMs;
  const startMs = clamp(Math.round(bounded.startMs + deltaMs), 0, Math.max(0, durationMs - length));
  return { ...bounded, startMs, endMs: startMs + length };
}

/** Client-only drafts preview duration; server duration validation remains authoritative. */
export function VideoTemporalLabels({ labels, selectedId = null, onSelect, assetId, durationMs }: Props) {
  const [items, setItems] = useState(labels);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saveStates, setSaveStates] = useState<Record<string, VideoSaveState>>({});
  const [error, setError] = useState<string | null>(null);
  const coordinators = useRef(new Map<string, TemporalLabelAutosaveCoordinator>());
  const drag = useRef<{ id: string; kind: "start" | "end" | "move"; startX: number; width: number; original: Draft } | null>(null);
  useEffect(() => () => { void Promise.all([...coordinators.current.values()].map((coordinator) => coordinator.dispose())); }, []);

  const getDraft = (label: SafeVideoTemporalLabel) => drafts[label.id] ?? { startMs: label.startMs, endMs: label.endMs, labelId: label.labelId ?? "" };
  const coordinatorFor = (label: SafeVideoTemporalLabel) => {
    const current = coordinators.current.get(label.id);
    if (current) { current.setRevision(label.revision); return current; }
    const next = new TemporalLabelAutosaveCoordinator(label.id, label.revision, (state) => setSaveStates((values) => ({ ...values, [label.id]: state })), (saved) => {
      setItems((values) => values.map((value) => value.id === saved.id ? saved : value));
    });
    coordinators.current.set(label.id, next);
    return next;
  };
  const stageDraft = (label: SafeVideoTemporalLabel, next: Draft) => {
    if (!durationMs || durationMs <= minimumIntervalMs) return;
    const bounded = boundedTemporalDraft(next, durationMs);
    setDrafts((values) => ({ ...values, [label.id]: bounded }));
    coordinatorFor(label).schedule({ startMs: bounded.startMs, endMs: bounded.endMs, labelId: bounded.labelId || null });
  };
  const flush = async (label: SafeVideoTemporalLabel) => {
    setError(null);
    try { await coordinatorFor(label).flush(); } catch { setError("This temporal label changed on the server. Your local interval was retained."); }
  };
  const add = async () => {
    if (!assetId || !durationMs || durationMs <= minimumIntervalMs) return;
    setError(null);
    try { const result = await createVideoTemporalLabel(assetId, { type: "EVENT", startMs: 0, endMs: Math.min(1000, durationMs) }); setItems((values) => [...values, result.temporalLabel]); }
    catch { setError("Temporal label could not be created."); }
  };
  const remove = async (label: SafeVideoTemporalLabel) => {
    setError(null);
    try {
      await coordinatorFor(label).flush();
      const current = items.find((item) => item.id === label.id) ?? label;
      await deleteVideoTemporalLabel(label.id, current.revision);
      coordinators.current.delete(label.id);
      setItems((values) => values.filter((item) => item.id !== label.id));
      setDrafts((values) => { const next = { ...values }; delete next[label.id]; return next; });
    } catch { setError("Temporal label could not be deleted. Any local interval was retained."); }
  };
  const beginDrag = (event: React.PointerEvent<HTMLDivElement>, label: SafeVideoTemporalLabel, kind: "start" | "end" | "move") => {
    if (!durationMs || durationMs <= minimumIntervalMs) return;
    const width = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
    if (!width) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: label.id, kind, startX: event.clientX, width, original: getDraft(label) };
    const move = (moveEvent: PointerEvent) => {
      const active = drag.current;
      if (!active || active.id !== label.id) return;
      const delta = Math.round((moveEvent.clientX - active.startX) / active.width * durationMs);
      const next = active.kind === "start"
        ? { ...active.original, startMs: active.original.startMs + delta }
        : active.kind === "end"
          ? { ...active.original, endMs: active.original.endMs + delta }
          : translateTemporalDraft(active.original, delta, durationMs);
      stageDraft(label, next);
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); drag.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const mutationDisabled = !assetId || !durationMs || durationMs <= minimumIntervalMs;
  return <section aria-label="Temporal labels" className="rounded-lg border border-zinc-800 bg-zinc-900/80 p-3 text-xs text-zinc-300">
    <div className="flex items-center justify-between"><h2 className="font-semibold text-zinc-100">Temporal labels</h2><div className="flex items-center gap-2"><span className="text-zinc-500">{items.length}</span><button type="button" disabled={mutationDisabled} onClick={() => void add()} className="rounded border border-zinc-700 px-2 py-1 text-[10px] disabled:opacity-50">Add event</button></div></div>
    {!durationMs ? <p className="mt-2 text-zinc-500">Editing is unavailable until the server provides a valid video duration.</p> : null}
    {error ? <p role="alert" className="mt-2 text-rose-300">{error}</p> : null}
    {items.length === 0 ? <p className="mt-2 text-zinc-500">No temporal labels.</p> : <ul className="mt-2 space-y-2">{items.map((label) => {
      const draft = getDraft(label);
      const state = saveStates[label.id] ?? "clean";
      const left = durationMs ? draft.startMs / durationMs * 100 : 0;
      const width = durationMs ? (draft.endMs - draft.startMs) / durationMs * 100 : 0;
      return <li key={label.id} className="rounded border border-zinc-800 p-2"><button type="button" aria-pressed={selectedId === label.id} onClick={() => onSelect?.(label.id)} className="flex w-full items-center justify-between text-left hover:text-white aria-pressed:text-sky-300"><span>{label.type.replaceAll("_", " ")}</span><span className="text-zinc-500">{(draft.startMs / 1000).toFixed(2)}–{(draft.endMs / 1000).toFixed(2)}s · {state}</span></button>
        <div className="relative mt-2 h-5 rounded bg-zinc-800" aria-label={`${label.type} interval editor`}>
          <div className="absolute top-0 h-5 rounded bg-amber-400/70" style={{ left: `${left}%`, width: `${width}%` }} onPointerDown={(event) => beginDrag(event, label, "move")} />
          <div role="slider" aria-label={`${label.type} start boundary`} aria-valuemin={0} aria-valuemax={durationMs ?? 0} aria-valuenow={draft.startMs} tabIndex={0} className="absolute top-0 h-5 w-2 cursor-ew-resize rounded bg-amber-200" style={{ left: `calc(${left}% - 4px)` }} onPointerDown={(event) => beginDrag(event, label, "start")} />
          <div role="slider" aria-label={`${label.type} end boundary`} aria-valuemin={0} aria-valuemax={durationMs ?? 0} aria-valuenow={draft.endMs} tabIndex={0} className="absolute top-0 h-5 w-2 cursor-ew-resize rounded bg-amber-200" style={{ left: `calc(${left + width}% - 4px)` }} onPointerDown={(event) => beginDrag(event, label, "end")} />
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1"><label className="text-[10px] text-zinc-500">Start<input aria-label={`${label.type} start`} type="number" min={0} max={durationMs ?? undefined} value={draft.startMs} disabled={mutationDisabled} onChange={(event) => stageDraft(label, { ...draft, startMs: Number(event.target.value) })} className="mt-1 w-full rounded bg-zinc-800 px-1 py-0.5 text-zinc-200" /></label><label className="text-[10px] text-zinc-500">End<input aria-label={`${label.type} end`} type="number" min={0} max={durationMs ?? undefined} value={draft.endMs} disabled={mutationDisabled} onChange={(event) => stageDraft(label, { ...draft, endMs: Number(event.target.value) })} className="mt-1 w-full rounded bg-zinc-800 px-1 py-0.5 text-zinc-200" /></label><label className="text-[10px] text-zinc-500">Label<input aria-label={`${label.type} label`} value={draft.labelId} disabled={mutationDisabled} onChange={(event) => stageDraft(label, { ...draft, labelId: event.target.value })} className="mt-1 w-full rounded bg-zinc-800 px-1 py-0.5 text-zinc-200" /></label></div>
        <div className="mt-2 flex flex-wrap gap-1"><button type="button" disabled={mutationDisabled} onClick={() => void flush(label)} className="rounded border border-emerald-800 px-1.5 py-0.5 text-[10px] text-emerald-300 disabled:opacity-50">Save</button><button type="button" disabled={mutationDisabled} onClick={() => durationMs && stageDraft(label, translateTemporalDraft(draft, -100, durationMs))} className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] disabled:opacity-50">← Move</button><button type="button" disabled={mutationDisabled} onClick={() => durationMs && stageDraft(label, translateTemporalDraft(draft, 100, durationMs))} className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] disabled:opacity-50">Move →</button><button type="button" onClick={() => void remove(label)} className="rounded border border-rose-900 px-1.5 py-0.5 text-[10px] text-rose-300">Delete</button></div>
      </li>;
    })}</ul>}
  </section>;
}
