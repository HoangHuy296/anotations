"use client";

import { CheckCircle, DotsThree, PencilSimple, SpinnerGap, Trash } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { shouldRestoreTriggerFocus } from "@/lib/datasets/popover-focus";

const statuses = ["IN_PROGRESS", "COMPLETED", "REVIEWED"] as const;

type DatasetRowActionsProps = {
  datasetId: string;
  datasetName: string;
  workflowStatus: (typeof statuses)[number];
  /** Dataset owner (or system admin) only: shows the permanent delete. The server enforces the same rule. */
  canDelete?: boolean;
};

export function DatasetRowActions({ datasetId, datasetName, workflowStatus, canDelete = false }: DatasetRowActionsProps) {
  const [confirming, setConfirming] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);
  const titleId = useId();
  const panelId = `${titleId}-panel`;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(datasetName);
  const [status, setStatus] = useState(workflowStatus);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!isPending && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus({ preventScroll: true });
    }
  }, [isPending]);

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    function positionPanel() {
      const surface = panel.current;
      const button = trigger.current;
      if (!surface || !button) return;
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
      const topEdge = (viewport?.offsetTop ?? 0) + 8;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const rightEdge = leftEdge + width - 16;
      const bottomEdge = topEdge + height - 16;
      const bounds = button.getBoundingClientRect();
      if (bounds.bottom < topEdge || bounds.top > bottomEdge || bounds.right < leftEdge || bounds.left > rightEdge) {
        surface.hidePopover();
        return;
      }
      surface.style.width = `${Math.min(352, width - 16)}px`;
      surface.style.maxHeight = `${height - 16}px`;
      const panelWidth = surface.offsetWidth;
      const panelHeight = surface.offsetHeight;
      let left: number;
      let top: number;
      if (bounds.left - panelWidth - 8 >= leftEdge) {
        left = bounds.left - panelWidth - 8;
        top = Math.max(topEdge, Math.min(bounds.top, bottomEdge - panelHeight));
      } else if (bounds.right + panelWidth + 8 <= rightEdge) {
        left = bounds.right + 8;
        top = Math.max(topEdge, Math.min(bounds.top, bottomEdge - panelHeight));
      } else {
        left = Math.max(leftEdge, Math.min(bounds.right - panelWidth, rightEdge - panelWidth));
        const below = bottomEdge - bounds.bottom - 8;
        const above = bounds.top - topEdge - 8;
        const placeBelow = below >= panelHeight || below >= above;
        surface.style.maxHeight = `${Math.max(0, placeBelow ? below : above)}px`;
        top = placeBelow ? bounds.bottom + 8 : bounds.top - 8 - surface.offsetHeight;
      }
      surface.style.left = `${left}px`;
      surface.style.top = `${top}px`;
    }
    function schedulePosition() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(positionPanel);
    }
    positionPanel();
    panel.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    const observer = new ResizeObserver(schedulePosition);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", schedulePosition);
    document.addEventListener("scroll", schedulePosition, true);
    window.visualViewport?.addEventListener("resize", schedulePosition);
    window.visualViewport?.addEventListener("scroll", schedulePosition);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedulePosition);
      document.removeEventListener("scroll", schedulePosition, true);
      window.visualViewport?.removeEventListener("resize", schedulePosition);
      window.visualViewport?.removeEventListener("scroll", schedulePosition);
    };
  }, [open]);

  /** Native Escape / light dismissal runs no script, so focus would be left on <body>; put it back on the Manage trigger when it would otherwise be lost. */
  function restoreTriggerFocusAfterDismissal() {
    const button = trigger.current;
    const active = document.activeElement;
    if (!button || !shouldRestoreTriggerFocus({ activeIsBody: !active || active === document.body, activeInsidePanel: Boolean(active && panel.current?.contains(active)), triggerConnected: button.isConnected, triggerDisabled: button.disabled })) return;
    button.focus({ preventScroll: true });
  }

  function closePanel() {
    panel.current?.hidePopover();
    restoreFocus.current = Boolean(trigger.current?.disabled);
    trigger.current?.focus({ preventScroll: true });
  }

  function update(payload: Record<string, string>) {
    setError(null);
    startTransition(async () => {
      await fetch(`/api/datasets/${datasetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then(async (response) => {
        if (!response.ok) throw new Error("The dataset could not be updated.");
        closePanel();
        router.refresh();
      }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "The dataset could not be updated."));
    });
  }

  function deletePermanently() {
    setError(null);
    startTransition(async () => {
      await fetch(`/api/datasets/${datasetId}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmName }) })
        .then(async (response) => {
          if (!response.ok) {
            const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
            throw new Error(body?.error?.message ?? "The dataset could not be deleted.");
          }
          closePanel();
          router.refresh();
        })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "The dataset could not be deleted."));
    });
  }

  return (
    <div className="relative">
      <Button aria-haspopup="dialog" aria-controls={panelId} aria-expanded={open} aria-label={`Manage ${datasetName}`} disabled={isPending} onClick={event => { trigger.current = event.currentTarget; if (!open) { setName(datasetName); setStatus(workflowStatus); setError(null); } }} popoverTarget={panelId} title="Manage dataset" type="button" variant="icon">
        {isPending ? <SpinnerGap aria-hidden="true" className="animate-spin" size={17} /> : <DotsThree aria-hidden="true" size={18} weight="bold" />}
      </Button>
      <div ref={panel} id={panelId} popover="auto" role="dialog" aria-labelledby={titleId} onToggle={event => { const isOpen = event.newState === "open"; setOpen(isOpen); if (!isOpen) restoreTriggerFocusAfterDismissal(); }} className="fixed inset-auto m-0 max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-[22rem] overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-6 text-zinc-950 shadow-xl dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
          <div className="mb-5 flex items-start justify-between gap-4"><div><h2 id={titleId} className="text-lg font-semibold">Manage dataset</h2><p className="mt-1 break-words text-sm text-zinc-500">{datasetName}</p></div><Button variant="ghost" size="sm" onClick={closePanel}>Close</Button></div>
          <div className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300"><label htmlFor={`${titleId}-name`}>Rename</label>
            <div className="mt-2 flex gap-2"><input id={`${titleId}-name`} maxLength={200} className="h-9 min-w-0 flex-1 rounded-lg border border-zinc-200 px-2 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:focus:ring-sky-900" onChange={(event) => setName(event.currentTarget.value)} value={name} /><button aria-label="Save dataset name" className="rounded-lg border border-zinc-200 px-2 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800" disabled={isPending || name.trim().length < 2 || name === datasetName} onClick={() => update({ name: name.trim() })} type="button"><PencilSimple aria-hidden="true" size={15} /></button></div>
          </div>
          <label className="mt-4 block text-xs font-semibold text-zinc-700 dark:text-zinc-300">Status
            <select className="mt-2 h-9 w-full rounded-lg border border-zinc-200 bg-white px-2 text-sm text-zinc-800 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:focus:ring-sky-900" onChange={(event) => setStatus(event.currentTarget.value as typeof status)} value={status}>
              {statuses.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}
            </select>
          </label>
          <button className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800" disabled={isPending || status === workflowStatus} onClick={() => update({ workflowStatus: status })} type="button"><CheckCircle aria-hidden="true" size={15} /> Update status</button>
          {canDelete ? <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
            {confirming ? <div className="space-y-2">
              <p className="text-xs leading-5 text-rose-800 dark:text-rose-300">This permanently deletes the dataset, its assets, annotations and every stored file. It cannot be undone. Type <b className="break-all">{datasetName}</b> to confirm.</p>
              <input aria-label="Type the dataset name to confirm" autoComplete="off" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} className="h-9 w-full rounded-lg border border-rose-200 px-2 text-sm outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-100 dark:border-rose-900 dark:bg-zinc-800 dark:text-zinc-100" />
              <div className="flex gap-2">
                <button type="button" className="h-9 flex-1 rounded-lg border border-zinc-200 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300" onClick={() => { setConfirming(false); setConfirmName(""); }}>Cancel</button>
                <button type="button" className="flex h-9 flex-1 items-center justify-center gap-2 rounded-lg bg-rose-700 text-xs font-semibold text-white disabled:opacity-40" disabled={isPending || confirmName.trim() !== datasetName} onClick={deletePermanently}><Trash aria-hidden="true" size={15} /> Delete permanently</button>
              </div>
            </div> : <button className="flex h-9 w-full items-center justify-center gap-2 rounded-lg text-xs font-semibold text-rose-700 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/50" disabled={isPending} onClick={() => setConfirming(true)} type="button"><Trash aria-hidden="true" size={15} /> Delete dataset permanently</button>}
          </div> : null}
          {error ? <p className="mt-2 text-xs text-rose-700 dark:text-rose-400" role="alert">{error}</p> : null}
      </div>
    </div>
  );
}
