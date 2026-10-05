"use client";

import { CheckCircle, DotsThree, PencilSimple, SpinnerGap, Trash } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

const statuses = ["IN_PROGRESS", "COMPLETED", "REVIEWED"] as const;

type DatasetRowActionsProps = {
  datasetId: string;
  datasetName: string;
  workflowStatus: (typeof statuses)[number];
};

export function DatasetRowActions({ datasetId, datasetName, workflowStatus }: DatasetRowActionsProps) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(datasetName);
  const [status, setStatus] = useState(workflowStatus);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  function update(payload: Record<string, string>) {
    setError(null);
    startTransition(async () => {
      await fetch(`/api/datasets/${datasetId}`, {
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
    startTransition(async () => {
      await fetch(`/api/datasets/${datasetId}`, { method: "DELETE" })
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
      <Button aria-haspopup="dialog" aria-expanded={open} aria-label={`Manage ${datasetName}`} disabled={isPending} onClick={() => { setName(datasetName); setStatus(workflowStatus); setError(null); setOpen(true); }} title="Manage dataset" type="button" variant="icon">
        {isPending ? <SpinnerGap aria-hidden="true" className="animate-spin" size={17} /> : <DotsThree aria-hidden="true" size={18} weight="bold" />}
      </Button>
      <dialog ref={dialog} aria-labelledby={titleId} onClose={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setOpen(false); } }} className="fixed inset-0 m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-6 text-zinc-950 shadow-xl backdrop:bg-zinc-950/35 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
          <div className="mb-5 flex items-start justify-between gap-4"><div><h2 id={titleId} className="text-lg font-semibold">Manage dataset</h2><p className="mt-1 break-words text-sm text-zinc-500">{datasetName}</p></div><Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</Button></div>
          <div className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300"><label htmlFor={`${titleId}-name`}>Rename</label>
            <div className="mt-2 flex gap-2"><input id={`${titleId}-name`} maxLength={200} className="h-9 min-w-0 flex-1 rounded-lg border border-zinc-200 px-2 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:focus:ring-sky-900" onChange={(event) => setName(event.currentTarget.value)} value={name} /><button aria-label="Save dataset name" className="rounded-lg border border-zinc-200 px-2 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800" disabled={isPending || name.trim().length < 2 || name === datasetName} onClick={() => update({ name: name.trim() })} type="button"><PencilSimple aria-hidden="true" size={15} /></button></div>
          </div>
          <label className="mt-4 block text-xs font-semibold text-zinc-700 dark:text-zinc-300">Status
            <select className="mt-2 h-9 w-full rounded-lg border border-zinc-200 bg-white px-2 text-sm text-zinc-800 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:focus:ring-sky-900" onChange={(event) => setStatus(event.currentTarget.value as typeof status)} value={status}>
              {statuses.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}
            </select>
          </label>
          <button className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800" disabled={isPending || status === workflowStatus} onClick={() => update({ workflowStatus: status })} type="button"><CheckCircle aria-hidden="true" size={15} /> Update status</button>
          <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800"><button className="flex h-9 w-full items-center justify-center gap-2 rounded-lg text-xs font-semibold text-rose-700 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/50" disabled={isPending} onClick={archive} type="button"><Trash aria-hidden="true" size={15} /> Archive dataset</button></div>
          {error ? <p className="mt-2 text-xs text-rose-700 dark:text-rose-400" role="alert">{error}</p> : null}
      </dialog>
    </div>
  );
}
