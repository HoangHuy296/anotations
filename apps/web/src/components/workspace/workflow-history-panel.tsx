"use client";

import { useEffect, useState } from "react";

type WorkflowEvent = {
  id: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  feedback: string | null;
  createdAt: string;
  actor: { name: string | null; email: string };
};

/** Read-only, asset-scoped workflow history; annotation history is never used here. */
export function WorkflowHistoryPanel({ datasetId, assetId }: { datasetId: string; assetId: string }) {
  const [history, setHistory] = useState<WorkflowEvent[] | null>(null);
  useEffect(() => {
    let active = true;
    void fetch(`/api/datasets/${datasetId}/assets/${assetId}/workflow`, { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as { data?: { history?: WorkflowEvent[] } } : null)
      .then((payload) => { if (active) setHistory(payload?.data?.history ?? []); })
      .catch(() => { if (active) setHistory([]); });
    return () => { active = false; };
  }, [assetId, datasetId]);
  return <section aria-label="Workflow history" className="mt-5 border-t border-zinc-100 pt-4">
    <h3 className="text-xs font-bold text-zinc-950">Workflow history</h3>
    {history === null ? <p className="mt-2 text-xs text-zinc-400">Loading workflow history…</p> : history.length === 0 ? <p className="mt-2 text-xs text-zinc-500">No workflow activity yet.</p> : <ol className="mt-2 space-y-2">{history.map((event) => <li key={event.id} className="border-l-2 border-zinc-200 pl-2 text-xs text-zinc-600"><p><b className="text-zinc-800">{event.action.replaceAll("_", " ")}</b> · {event.actor.name ?? event.actor.email}</p><p>{event.fromStatus ?? "—"} → {event.toStatus ?? "—"}</p>{event.feedback ? <p className="mt-1 text-zinc-800">{event.feedback}</p> : null}</li>)}</ol>}
  </section>;
}
