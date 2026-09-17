"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, CheckCircle, SpinnerGap } from "@phosphor-icons/react";
import { useParams } from "next/navigation";
import { useDatasetLabelsStore, type DatasetLabel } from "@/stores/dataset-labels-store";
import type { AiPredictionPreview, AiPredictionResults } from "@/types/ai-prediction";
import type { SafeAnnotation } from "@/lib/annotations/safe-annotation";

type Props = {
  assetId: string;
  taskId?: string;
  onPreviews: (predictions: AiPredictionPreview[]) => void;
  onSaved: (annotation: SafeAnnotation) => void;
};

export function AiPredictionReview({ assetId, taskId, onPreviews, onSaved }: Props) {
  const { datasetId } = useParams<{ datasetId: string }>();
  const [results, setResults] = useState<AiPredictionResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const savingRef = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    const controller = new AbortController();
    const url = taskId ? `/api/ai/tasks/${encodeURIComponent(taskId)}/predictions?assetId=${encodeURIComponent(assetId)}` : `/api/assets/${encodeURIComponent(assetId)}/ai-results`;
    void fetch(url, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable");
        const { data } = await response.json() as { data: AiPredictionResults };
        if (controller.signal.aborted) return;
        setResults(data);
        setError(null);

      }).catch(() => { if (!controller.signal.aborted) setError("Could not load predictions. Retry to load the results."); });
    return () => { controller.abort(); };
  }, [assetId, taskId, reload]);

  useEffect(() => {
    onPreviews(results?.predictions.filter((p) => !p.saved) ?? []);
    return () => onPreviews([]);
  }, [results, onPreviews]);

  async function findOrCreateLabel(p: AiPredictionPreview): Promise<DatasetLabel> {
    const normalizedName = p.labelKey.trim().toLocaleLowerCase("en-US");
    const cached = useDatasetLabelsStore.getState().entries[datasetId]?.labels.find((label) => label.name.trim().toLocaleLowerCase("en-US") === normalizedName);
    if (cached) return cached;
    const response = await fetch(`/api/datasets/${encodeURIComponent(datasetId)}/labels`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: p.labelKey, color: p.color, description: "", hotkey: "" }),
    });
    const payload = await response.json().catch(() => null) as { data?: DatasetLabel; error?: { message?: string } } | null;
    if (response.ok && payload?.data) {
      useDatasetLabelsStore.getState().addLabel(datasetId, payload.data);
      return payload.data;
    }
    if (response.status === 409) {
      useDatasetLabelsStore.getState().invalidate(datasetId);
      await useDatasetLabelsStore.getState().ensureLoaded(datasetId);
      const existing = useDatasetLabelsStore.getState().entries[datasetId]?.labels.find((label) => label.name.trim().toLocaleLowerCase("en-US") === normalizedName);
      if (existing) return existing;
    }
    throw new Error(payload?.error?.message ?? "The predicted label could not be created.");
  }

  async function save(p: AiPredictionPreview) {
    if (!results?.taskId || !datasetId || savingRef.current) return;
    savingRef.current = true;
    setSaving(p.index);
    setError(null);
    try {
      const label = await findOrCreateLabel(p);
      const response = await fetch(`/api/ai/tasks/${encodeURIComponent(results.taskId)}/predictions`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId, index: p.index, labelId: label.id }),
      });
      const payload = await response.json();
      if (!mounted.current) return;
      if (!response.ok) {
        setError(payload?.error?.message ?? "Could not save the prediction. Try again.");
        return;
      }
      onSaved(payload.data.annotation);
      setResults((current) => current?.taskId === results.taskId ? { ...current, predictions: current.predictions.map((item) => item.index === p.index ? { ...item, saved: true } : item) } : current);
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : "Could not save the prediction. Retry is safe."); }
    finally { savingRef.current = false; if (mounted.current) setSaving(null); }
  }

  return <section aria-label="Prediction previews" className="mt-5 border-t border-zinc-200 pt-4">
    <h3 className="text-sm font-semibold text-zinc-900">Prediction previews</h3>
    {error && <div role="alert" className="mt-2 text-xs text-rose-600">{error}<button type="button" disabled={saving !== null} onClick={() => setReload((value) => value + 1)} className="ml-2 underline">Reload results</button></div>}
    {!results && !error && <p className="mt-2 text-xs text-zinc-500">Loading predictions…</p>}
    {results && !results.taskId && <p className="mt-2 text-xs text-zinc-500">Completed detections will appear here.</p>}
    {results?.taskId && <>
      <p className="mt-2 text-xs text-zinc-500">{results.predictions.length} detection{results.predictions.length === 1 ? "" : "s"} in this completed run. Use the arrow to add a predicted bbox as an AI-labeled draft shape.</p>
      <ul className="mt-3 space-y-1.5">
        {results.predictions.map((p) => <li key={p.index} className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2.5 py-2 shadow-sm">
          <span aria-hidden="true" className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="truncate font-semibold text-zinc-900">#{p.index + 1} {p.labelKey}</span>
              <span className="ml-auto shrink-0 font-medium text-zinc-500">{Math.round(p.confidence * 100)}%</span>
            </div>
            <p aria-label={`Bounding box coordinates for ${p.labelKey}`} className="mt-0.5 truncate font-mono text-[10px] text-zinc-400">
              bbox · x {p.geometry.x.toFixed(3)} · y {p.geometry.y.toFixed(3)} · w {p.geometry.width.toFixed(3)} · h {p.geometry.height.toFixed(3)}
            </p>
          </div>
          {p.saved ? <span title="Added as a shape" className="grid size-8 shrink-0 place-items-center text-emerald-600"><CheckCircle size={18} weight="fill" /><span className="sr-only">Added as a shape</span></span> : <button type="button" aria-label={`Add #${p.index + 1} ${p.labelKey} as a shape`} title={`Add #${p.index + 1} ${p.labelKey} as a shape`} disabled={saving !== null} onClick={() => void save(p)} className="grid size-8 shrink-0 place-items-center rounded-full text-white transition-transform hover:translate-x-0.5 disabled:opacity-50" style={{ backgroundColor: p.color }}>{saving === p.index ? <SpinnerGap size={15} className="animate-spin" /> : <ArrowRight size={16} weight="bold" />}</button>}
        </li>)}
      </ul>
    </>}
  </section>;
}
