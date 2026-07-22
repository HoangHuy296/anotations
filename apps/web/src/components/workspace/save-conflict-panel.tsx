"use client";

type SaveConflictPanelProps = {
  message: string;
  onReload: () => void;
  onDiscard: () => void;
  onReconcile?: () => void;
};

/** Conflict recovery is explicit: no stale draft is retried or overwritten automatically. */
export function SaveConflictPanel({ message, onReload, onDiscard, onReconcile }: SaveConflictPanelProps) {
  return <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
    <p className="font-semibold">A newer version exists</p>
    <p className="mt-1 text-xs leading-5">{message}</p>
    <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={onReload} className="rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white">Reload current version</button><button type="button" onClick={onDiscard} className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-semibold text-amber-950">Discard local draft</button>{onReconcile && <button type="button" onClick={onReconcile} className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-semibold text-amber-950">Keep draft to reconcile</button>}</div>
  </div>;
}
