"use client";

import { useEffect, useRef, useState } from "react";
import type { AiPredictionPreview, AiPredictionResults } from "@/types/ai-prediction";
import type { SafeWorkspaceLabel } from "@/types/image-workspace";
import type { SafeAnnotation } from "@/lib/annotations/safe-annotation";

type Props = {
  assetId: string;
  taskId?: string;
  labels: SafeWorkspaceLabel[];
  onPreviews: (predictions: AiPredictionPreview[]) => void;
  onSaved: (annotation: SafeAnnotation) => void;
};

export function AiPredictionReview({ assetId, taskId, labels, onPreviews, onSaved }: Props) {
  const [results, setResults] = useState<AiPredictionResults | null>(null);
  const [assigned, setAssigned] = useState<Record<number, string>>({});
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
        setAssigned({});
        setError(null);

      }).catch(() => { if (!controller.signal.aborted) setError("Could not load predictions. Retry to load the results."); });
    return () => { controller.abort(); };
  }, [assetId, taskId, reload]);

  useEffect(() => {
    onPreviews(results?.predictions.filter((p) => !p.saved) ?? []);
    return () => onPreviews([]);
  }, [results, onPreviews]);

  async function save(p: AiPredictionPreview) {
    if (!results?.taskId || !assigned[p.index] || savingRef.current) return;
    savingRef.current = true;
    setSaving(p.index);
    setError(null);
    try {
      const response = await fetch(`/api/ai/tasks/${encodeURIComponent(results.taskId)}/predictions`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId, index: p.index, labelId: assigned[p.index] }),
      });
      const payload = await response.json();
      if (!mounted.current) return;
      if (!response.ok) {
        setError(payload?.error?.message ?? "Could not save the prediction. Try again.");
        return;
      }
      onSaved(payload.data.annotation);
      setResults((current) => current?.taskId === results.taskId ? { ...current, predictions: current.predictions.map((item) => item.index === p.index ? { ...item, saved: true } : item) } : current);
    } catch { if (mounted.current) setError("Could not save the prediction. Retry is safe."); }
    finally { savingRef.current = false; if (mounted.current) setSaving(null); }
  }

  return <section aria-label="Prediction previews" className="mt-5 border-t border-zinc-200 pt-4">
    <h3 className="text-sm font-semibold text-zinc-900">Prediction previews</h3>
    {error && <div role="alert" className="mt-2 text-xs text-rose-600">{error}<button type="button" disabled={saving !== null} onClick={() => setReload((value) => value + 1)} className="ml-2 underline">Reload results</button></div>}
    {!results && !error && <p className="mt-2 text-xs text-zinc-500">Loading predictions…</p>}
    {results && !results.taskId && <p className="mt-2 text-xs text-zinc-500">Completed detections will appear here.</p>}
    {results?.taskId && <>
      <p className="mt-2 text-xs text-zinc-500">{results.predictions.length} detection{results.predictions.length === 1 ? "" : "s"} in this completed run. Dashed boxes are previews. Assign a dataset label and save to add a draft annotation.</p>
      {labels.length === 0 && <p className="mt-2 text-xs text-amber-700">Create a dataset label before saving predictions.</p>}
      <ul className="mt-3 space-y-3">
        {results.predictions.map((p) => <li key={p.index} className="rounded-lg border border-zinc-200 p-2.5">
          <div className="flex justify-between gap-2 text-xs"><span className="font-semibold">#{p.index + 1} {p.labelKey}</span><span>{Math.round(p.confidence * 100)}%</span></div>
          {p.saved ? <p className="mt-2 text-xs text-emerald-700">Saved as an annotation</p> : <div className="mt-2 flex gap-2">
            <select aria-label={`Dataset label for prediction ${p.index + 1}`} disabled={saving !== null} value={assigned[p.index] ?? ""} onChange={(event) => setAssigned((current) => ({ ...current, [p.index]: event.target.value }))} className="min-w-0 flex-1 rounded border border-zinc-200 bg-white px-1 py-1 text-xs">
              <option value="">Choose label</option>
              {labels.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}
            </select>
            <button type="button" disabled={!assigned[p.index] || saving !== null} onClick={() => void save(p)} className="rounded bg-sky-600 px-2 py-1 text-xs font-semibold text-white disabled:opacity-50">{saving === p.index ? "Saving…" : "Save"}</button>
          </div>}
        </li>)}
      </ul>
    </>}
  </section>;
}
