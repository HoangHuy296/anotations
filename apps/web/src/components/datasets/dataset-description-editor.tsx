"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Reuses the existing `PATCH /api/datasets/{datasetId}` route/authorization (FR-033) -- no new edit endpoint. */
export function DatasetDescriptionEditor({ datasetId, description }: { datasetId: string; description: string | null }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return <div className="mt-3 max-w-2xl">
      {description ? <p className="text-sm leading-6 text-zinc-500">{description}</p> : <p className="text-sm italic text-zinc-400">No description yet.</p>}
      <button type="button" onClick={() => { setDraft(description ?? ""); setEditing(true); }} className="mt-1 text-xs font-semibold text-sky-700 hover:text-sky-800">Edit description</button>
    </div>;
  }

  async function save() {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/datasets/${datasetId}`, {
        method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: draft }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "The description could not be saved.");
        return;
      }
      setEditing(false);
      router.refresh();
    } finally { setBusy(false); }
  }

  return <div className="mt-3 max-w-2xl">
    <textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={2_000} rows={4} className="w-full resize-y rounded-xl border border-zinc-200 p-3 text-sm text-zinc-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100" placeholder="Describe this dataset" />
    <div className="mt-2 flex gap-2">
      <button type="button" disabled={busy} onClick={() => void save()} className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
      <button type="button" disabled={busy} onClick={() => setEditing(false)} className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-600">Cancel</button>
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-rose-700">{error}</p>}
  </div>;
}
