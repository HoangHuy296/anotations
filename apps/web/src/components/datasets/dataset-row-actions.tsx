"use client";

import { CheckCircle, DotsThree, PencilSimple, SpinnerGap, Trash } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

const statuses = ["IN_PROGRESS", "COMPLETED", "REVIEWED"] as const;

type DatasetRowActionsProps = {
  datasetId: string;
  datasetName: string;
  workflowStatus: (typeof statuses)[number];
};

export function DatasetRowActions({ datasetId, datasetName, workflowStatus }: DatasetRowActionsProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(datasetName);
  const [status, setStatus] = useState(workflowStatus);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function update(payload: Record<string, string>) {
    setError(null);
    startTransition(() => {
      void fetch(`/api/datasets/${datasetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then(async (response) => {
        if (!response.ok) throw new Error("The dataset could not be updated.");
        setOpen(false);
        router.refresh();
      }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "The dataset could not be updated."));
    });
  }

  function archive() {
    if (!window.confirm(`Archive “${datasetName}”? Its data will remain recoverable and no binary is deleted.`)) return;
    setError(null);
    startTransition(() => {
      void fetch(`/api/datasets/${datasetId}`, { method: "DELETE" })
        .then(async (response) => {
          if (!response.ok) throw new Error("The dataset could not be archived.");
          setOpen(false);
          router.refresh();
        })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "The dataset could not be archived."));
    });
  }

  return (
    <div className="relative">
      <Button aria-expanded={open} aria-label={`Manage ${datasetName}`} disabled={isPending} onClick={() => setOpen((value) => !value)} title="Manage dataset" type="button" variant="icon">
        {isPending ? <SpinnerGap aria-hidden="true" className="animate-spin" size={17} /> : <DotsThree aria-hidden="true" size={18} weight="bold" />}
      </Button>
      {open ? (
        <div className="absolute right-0 z-20 mt-2 w-72 rounded-2xl border border-zinc-200 bg-white p-3 shadow-[0_20px_45px_-24px_rgba(24,24,27,0.35)]">
          <label className="block text-xs font-semibold text-zinc-700">Rename
            <div className="mt-2 flex gap-2"><input className="h-9 min-w-0 flex-1 rounded-lg border border-zinc-200 px-2 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100" onChange={(event) => setName(event.currentTarget.value)} value={name} /><button className="rounded-lg border border-zinc-200 px-2 text-zinc-700 hover:bg-zinc-50" disabled={isPending || name.trim().length < 2 || name === datasetName} onClick={() => update({ name: name.trim() })} type="button"><PencilSimple aria-hidden="true" size={15} /></button></div>
          </label>
          <label className="mt-4 block text-xs font-semibold text-zinc-700">Status
            <select className="mt-2 h-9 w-full rounded-lg border border-zinc-200 bg-white px-2 text-sm text-zinc-800 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100" onChange={(event) => setStatus(event.currentTarget.value as typeof status)} value={status}>
              {statuses.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}
            </select>
          </label>
          <button className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 text-xs font-semibold text-zinc-700 hover:bg-zinc-50" disabled={isPending || status === workflowStatus} onClick={() => update({ workflowStatus: status })} type="button"><CheckCircle aria-hidden="true" size={15} /> Update status</button>
          <div className="mt-4 border-t border-zinc-100 pt-3"><button className="flex h-9 w-full items-center justify-center gap-2 rounded-lg text-xs font-semibold text-rose-700 hover:bg-rose-50" disabled={isPending} onClick={archive} type="button"><Trash aria-hidden="true" size={15} /> Delete dataset</button></div>
          {error ? <p className="mt-2 text-xs text-rose-700" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
