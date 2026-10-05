"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { WarningCircle } from "@phosphor-icons/react";
import { datasetModalities, datasetModalityReceiptSchema, type DatasetModality } from "@annotationplatform/domain/dataset-modality";

import { Button } from "@/components/ui/button";
import type { WorkspaceDataset } from "@/types/workspace";

type UnresolvedDataset = Extract<WorkspaceDataset, { modality: null }>;

const MODALITY_LABELS: Record<DatasetModality, string> = {
  IMAGE: "Image", VIDEO: "Video", AUDIO: "Audio", TEXT: "Text",
};

const UNRESOLVED_COPY = {
  EMPTY_UNRESOLVED: {
    title: "Choose a dataset modality",
    description: "This historical dataset has no assets. Its owner or a system administrator must choose its fixed modality before annotation or imports can begin.",
  },
  MIXED_UNRESOLVED: {
    title: "Mixed dataset needs review",
    description: "This historical dataset contains several modalities. Its assets remain unchanged, and this workspace is unavailable until an approved resolution is completed.",
  },
  SINGLE_UNRESOLVED: {
    title: "Dataset verification is pending",
    description: "This historical dataset needs a verified modality resolution before its workspace can open. Existing assets remain unchanged.",
  },
} as const;

/** Unresolved history never mounts an engine or selects a default modality. */
export function UnresolvedDatasetWorkspace({ dataset }: { dataset: UnresolvedDataset }) {
  const router = useRouter();
  const inputId = useId();
  const [modality, setModality] = useState<DatasetModality | "">("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = UNRESOLVED_COPY[dataset.modalityResolution];
  const eligible = dataset.modalityResolution === "EMPTY_UNRESOLVED" && dataset.canResolve;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!eligible || !modality || !confirmed || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/datasets/${encodeURIComponent(dataset.id)}/modality-resolution`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modality }),
      });
      const payload = await response.json().catch(() => null);
      const receipt = datasetModalityReceiptSchema.safeParse(payload?.data);
      if (!response.ok || !receipt.success || receipt.data.id !== dataset.id || receipt.data.modality !== modality) {
        setError("The dataset could not be resolved. Refresh the page and check that it is still empty and you have permission.");
        return;
      }
      // The refreshed authorized server Dataset is the only engine-routing input.
      router.refresh();
    } catch {
      setError("The dataset could not be resolved. Please try again.");
    } finally { setPending(false); }
  }

  return <section data-workspace-unresolved={dataset.modalityResolution} className="canvas-grid grid min-h-[520px] min-w-0 place-items-center bg-zinc-950 px-6 py-10 text-center lg:min-h-0">
    <div className="w-full max-w-md">
      <WarningCircle size={30} weight="duotone" className="mx-auto text-amber-400" aria-hidden />
      <h2 className="mt-4 text-base font-semibold text-zinc-100">{copy.title}</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-400">{copy.description}</p>
      {eligible && <form className="mt-6 space-y-4 text-left" onSubmit={submit} aria-label="Resolve empty dataset modality">
        <div>
          <label htmlFor={inputId} className="mb-2 block text-sm font-medium text-zinc-200">Dataset modality</label>
          <select id={inputId} value={modality} disabled={pending} required onChange={event => { setModality(event.target.value as DatasetModality | ""); setConfirmed(false); setError(null); }} className="h-11 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
            <option value="">Choose a modality</option>
            {datasetModalities.map(value => <option key={value} value={value}>{MODALITY_LABELS[value]}</option>)}
          </select>
        </div>
        <label className="flex items-start gap-3 text-sm leading-5 text-zinc-300">
          <input type="checkbox" checked={confirmed} disabled={pending || !modality} onChange={event => setConfirmed(event.target.checked)} className="mt-1 accent-sky-500" />
          <span>I understand that the dataset modality is permanent and cannot be changed through normal dataset editing.</span>
        </label>
        {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
        <Button type="submit" className="w-full" disabled={!modality || !confirmed || pending}>{pending ? "Resolving…" : "Confirm dataset modality"}</Button>
      </form>}
    </div>
  </section>;
}
