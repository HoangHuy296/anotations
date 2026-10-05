"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AssetStatus } from "@internal/db";

import { imageStatusOptions, imageStatusPresentation } from "@/lib/image-status";
import type { DatasetLabel } from "@/stores/dataset-labels-store";
import { useAssetSelectionStore } from "@/stores/asset-selection-store";
import { BULK_SYNC_MAX_ASSETS, type BulkOperationResult, type BulkSelection } from "@/types/workspace";

type Member = { id: string; name: string; email: string; role: string };

type BulkAction = "ADD_LABEL" | "REMOVE_LABEL" | "CHANGE_STATUS" | "ASSIGN" | "DELETE";

const TERMINAL_JOB_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELED"]);

function currentSelectionPayload(datasetId: string): BulkSelection | null {
  const state = useAssetSelectionStore.getState();
  if (state.datasetId !== datasetId) return null;
  if (state.mode === "EXPLICIT") return { mode: "EXPLICIT", assetIds: [...state.explicitIds] };
  if (state.mode === "FILTERED" && state.filteredQuery) return { mode: "FILTERED", datasetId, query: state.filteredQuery };
  return null;
}

/**
 * The centralized bulk-action area (022 §10/§30) -- every action shares the
 * same selection abstraction (`useAssetSelectionStore`) and result envelope
 * (`BulkOperationResult`) rather than independent per-button state.
 * Export Selected is User Story 4's job; the backend already validates its
 * request shape but returns "not yet available" for it.
 */
export function BulkActionBar({ datasetId, labels, onRunAi }: { datasetId: string; labels: DatasetLabel[]; onRunAi?: () => void }) {
  const router = useRouter();
  const mode = useAssetSelectionStore((state) => state.mode);
  const storeDatasetId = useAssetSelectionStore((state) => state.datasetId);
  const selectedCount = useAssetSelectionStore((state) => state.selectedCount());
  const clear = useAssetSelectionStore((state) => state.clear);

  const [openAction, setOpenAction] = useState<BulkAction | null>(null);
  const [labelId, setLabelId] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#0EA5E9");
  const [creatingNewLabel, setCreatingNewLabel] = useState(false);
  const [status, setStatus] = useState<AssetStatus>("NEEDS_REVIEW");
  const [assigneeId, setAssigneeId] = useState("");
  const [members, setMembers] = useState<Member[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<{ affectedAssetCount: number } | null>(null);
  const [result, setResult] = useState<BulkOperationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobPolling, setJobPolling] = useState<{ jobId: string; status: string } | null>(null);

  useEffect(() => {
    if (openAction !== "ASSIGN" || members !== null) return;
    fetch(`/api/datasets/${datasetId}/members`, { credentials: "same-origin" })
      .then((response) => response.json())
      .then((payload: { data?: { items: Member[] } }) => setMembers(payload.data?.items ?? []))
      .catch(() => setMembers([]));
  }, [openAction, members, datasetId]);

  // A background bulk Job (large Delete) is polled until it reaches a
  // terminal state, then treated exactly like a synchronous result --
  // same refresh/reconcile per FR-036.
  useEffect(() => {
    if (!jobPolling || TERMINAL_JOB_STATUSES.has(jobPolling.status)) return;
    const timer = setTimeout(async () => {
      const response = await fetch(`/api/jobs/${jobPolling.jobId}`, { credentials: "same-origin" });
      const body = await response.json().catch(() => null) as { data?: { status: string; successCount: number | null; failedCount: number | null; skippedCount: number | null } } | null;
      if (!body?.data) return;
      setJobPolling({ jobId: jobPolling.jobId, status: body.data.status });
      if (TERMINAL_JOB_STATUSES.has(body.data.status)) {
        const succeeded = body.data.successCount ?? 0, failed = body.data.failedCount ?? 0, skipped = body.data.skippedCount ?? 0;
        setResult({ processed: succeeded + failed + skipped, succeeded, failed, skipped });
        clear();
        router.refresh();
      }
    }, 2_000);
    return () => clearTimeout(timer);
  }, [jobPolling, clear, router]);

  if (storeDatasetId !== datasetId || mode === "NONE") return null;

  async function callBulk(action: BulkAction, payload: Record<string, unknown>) {
    const selection = currentSelectionPayload(datasetId);
    if (!selection) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/datasets/${datasetId}/assets/bulk`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, selection, payload }),
      });
      const body = await response.json().catch(() => null) as { data?: { mode: "SYNC" | "JOB"; result?: BulkOperationResult; jobId?: string }; error?: { code?: string; message?: string; fieldErrors?: Record<string, string[]> } } | null;
      if (response.status === 409 && body?.error?.code === "ANNOTATION_REFERENCE_WARNING") {
        setWarning({ affectedAssetCount: Number(body.error.fieldErrors?.affectedAssetCount?.[0] ?? 0) });
        return;
      }
      if (!response.ok || !body?.data) { setError(body?.error?.message ?? "The bulk action failed."); return; }
      setWarning(null);
      setOpenAction(null);
      if (body.data.mode === "JOB" && body.data.jobId) {
        // Large operation: don't clear/refresh yet -- that happens once the
        // background Job actually finishes (see the polling effect above).
        setJobPolling({ jobId: body.data.jobId, status: "QUEUED" });
        return;
      }
      if (body.data.result) setResult(body.data.result);
      // FR-036: refresh the list/counts, then reconcile selection -- a
      // completed action's targets no longer need to stay selected.
      clear();
      router.refresh();
    } finally { setBusy(false); }
  }

  async function submitAddLabel() {
    if (creatingNewLabel) {
      if (!newLabelName.trim()) { setError("Name is required."); return; }
      await callBulk("ADD_LABEL", { createLabel: { name: newLabelName.trim(), color: newLabelColor } });
      return;
    }
    if (!labelId) { setError("Choose a label."); return; }
    await callBulk("ADD_LABEL", { labelId });
  }

  async function submitRemoveLabel(confirmedAnnotationWarning = false) {
    if (!labelId) { setError("Choose a label."); return; }
    await callBulk("REMOVE_LABEL", { labelId, confirmedAnnotationWarning });
  }

  const deleteRunsInBackground = selectedCount > BULK_SYNC_MAX_ASSETS;

  return <div className="border-t border-zinc-200 bg-zinc-50 p-3">
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-semibold text-zinc-700">
        {mode === "FILTERED" ? `All ${selectedCount.toLocaleString()} matching assets selected` : `${selectedCount.toLocaleString()} selected`}
      </span>
      <button type="button" onClick={() => { clear(); setOpenAction(null); }} className="text-[11px] font-semibold text-zinc-500 hover:text-zinc-700">Clear</button>
    </div>
    <div className="mt-2 flex flex-wrap gap-1.5">
      <button type="button" onClick={() => { setOpenAction(openAction === "ADD_LABEL" ? null : "ADD_LABEL"); setError(null); }} className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-[11px] font-semibold text-zinc-700 hover:bg-zinc-100">Add Label</button>
      <button type="button" onClick={() => { setOpenAction(openAction === "REMOVE_LABEL" ? null : "REMOVE_LABEL"); setError(null); setWarning(null); }} className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-[11px] font-semibold text-zinc-700 hover:bg-zinc-100">Remove Label</button>
      <button type="button" onClick={() => { setOpenAction(openAction === "CHANGE_STATUS" ? null : "CHANGE_STATUS"); setError(null); }} className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-[11px] font-semibold text-zinc-700 hover:bg-zinc-100">Change Status</button>
      <button type="button" onClick={() => { setOpenAction(openAction === "ASSIGN" ? null : "ASSIGN"); setError(null); }} className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-[11px] font-semibold text-zinc-700 hover:bg-zinc-100">Assign</button>
      {onRunAi && <button type="button" onClick={onRunAi} className="rounded-lg border border-sky-200 bg-white px-2 py-1.5 text-[11px] font-semibold text-sky-700 hover:bg-sky-50">AI Detect</button>}
      <button type="button" onClick={() => { setOpenAction(openAction === "DELETE" ? null : "DELETE"); setError(null); }} className="rounded-lg border border-rose-200 bg-white px-2 py-1.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-50">Delete</button>
    </div>

    {openAction === "ADD_LABEL" && <div className="mt-2 space-y-2 rounded-lg border border-zinc-200 bg-white p-2">
      {!creatingNewLabel ? <>
        <select value={labelId} onChange={(event) => setLabelId(event.target.value)} className="w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-xs">
          <option value="">Choose a label…</option>
          {labels.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}
        </select>
        <button type="button" onClick={() => setCreatingNewLabel(true)} className="text-[11px] font-semibold text-sky-700">Create a new label instead</button>
      </> : <>
        <div className="flex gap-2">
          <input aria-label="New label name" value={newLabelName} onChange={(event) => setNewLabelName(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-2 py-1.5 text-xs" placeholder="Label name" maxLength={50} />
          <input aria-label="New label color" type="color" value={newLabelColor} onChange={(event) => setNewLabelColor(event.target.value)} className="h-8 w-9 shrink-0 cursor-pointer rounded-lg border border-zinc-200 p-0.5" />
        </div>
        <button type="button" onClick={() => setCreatingNewLabel(false)} className="text-[11px] font-semibold text-zinc-500">Choose an existing label instead</button>
      </>}
      <button type="button" disabled={busy} onClick={() => void submitAddLabel()} className="w-full rounded-lg bg-zinc-900 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50">{busy ? "Applying…" : "Add Label"}</button>
    </div>}

    {openAction === "REMOVE_LABEL" && <div className="mt-2 space-y-2 rounded-lg border border-zinc-200 bg-white p-2">
      <select value={labelId} onChange={(event) => setLabelId(event.target.value)} className="w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-xs">
        <option value="">Choose a label…</option>
        {labels.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}
      </select>
      {warning ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">
        This label is referenced by existing annotations on {warning.affectedAssetCount} selected asset{warning.affectedAssetCount === 1 ? "" : "s"}. Removing the Asset label will not delete or modify those annotations.
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={() => setWarning(null)} className="rounded-lg border border-zinc-200 px-2 py-1 text-[11px] font-semibold text-zinc-600">Cancel</button>
          <button type="button" disabled={busy} onClick={() => void submitRemoveLabel(true)} className="rounded-lg bg-rose-700 px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50">Remove Label</button>
        </div>
      </div> : <button type="button" disabled={busy} onClick={() => void submitRemoveLabel(false)} className="w-full rounded-lg bg-zinc-900 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50">{busy ? "Applying…" : "Remove Label"}</button>}
    </div>}

    {openAction === "CHANGE_STATUS" && <div className="mt-2 space-y-2 rounded-lg border border-zinc-200 bg-white p-2">
      <select value={status} onChange={(event) => setStatus(event.target.value as AssetStatus)} className="w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-xs">
        {imageStatusOptions.map((option) => <option key={option} value={option}>{imageStatusPresentation[option].label}</option>)}
      </select>
      <button type="button" disabled={busy} onClick={() => void callBulk("CHANGE_STATUS", { status })} className="w-full rounded-lg bg-zinc-900 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50">{busy ? "Applying…" : "Change Status"}</button>
    </div>}

    {openAction === "ASSIGN" && <div className="mt-2 space-y-2 rounded-lg border border-zinc-200 bg-white p-2">
      <select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} className="w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-xs">
        <option value="">Unassign</option>
        {members === null ? <option disabled>Loading members…</option> : members.map((member) => <option key={member.id} value={member.id}>{member.name} ({member.role})</option>)}
      </select>
      <button type="button" disabled={busy} onClick={() => void callBulk("ASSIGN", { assignedToId: assigneeId || null })} className="w-full rounded-lg bg-zinc-900 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50">{busy ? "Applying…" : "Assign"}</button>
    </div>}

    {openAction === "DELETE" && <div className="mt-2 space-y-2 rounded-lg border border-rose-200 bg-rose-50 p-2 text-[11px] text-rose-900">
      <p>
        Delete {mode === "FILTERED" ? `all ${selectedCount.toLocaleString()} matching` : selectedCount.toLocaleString()} asset{selectedCount === 1 ? "" : "s"}?
        This will remove the asset{selectedCount === 1 ? "" : "s"} from the dataset. Associated storage objects will be cleaned up asynchronously.
        {deleteRunsInBackground && " This affects a large number of assets and will run in the background."}
      </p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setOpenAction(null)} className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-[11px] font-semibold text-zinc-600">Cancel</button>
        <button type="button" disabled={busy} onClick={() => void callBulk("DELETE", {})} className="rounded-lg bg-rose-700 px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50">{busy ? "Deleting…" : "Delete"}</button>
      </div>
    </div>}

    {jobPolling && !TERMINAL_JOB_STATUSES.has(jobPolling.status) && <p role="status" className="mt-2 text-[11px] text-zinc-600">Running in the background ({jobPolling.status.toLowerCase()})…</p>}
    {error && <p role="alert" className="mt-2 text-[11px] text-rose-700">{error}</p>}
    {result && <p role="status" className="mt-2 text-[11px] text-zinc-600">Processed {result.processed} · Succeeded {result.succeeded} · Skipped {result.skipped} · Failed {result.failed}</p>}
  </div>;
}
