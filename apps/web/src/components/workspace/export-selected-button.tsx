"use client";

import { DownloadSimple } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { useAssetSelectionStore } from "@/stores/asset-selection-store";
import type { BulkSelection } from "@/types/workspace";

const TERMINAL_JOB_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELED"]);

/**
 * Export Selected (022 User Story 4) -- lives in the Workspace Toolbox, not
 * the Canvas, and operates on the current Asset Browser selection. Always
 * runs as a background Job (research.md/route decision: one code path,
 * never a duplicate sync manifest builder in `apps/web`); this button
 * reflects that by immediately showing "Preparing export…" rather than
 * pretending it might resolve instantly.
 */
export function ExportSelectedButton({ datasetId }: { datasetId: string }) {
  const mode = useAssetSelectionStore((state) => state.mode);
  const storeDatasetId = useAssetSelectionStore((state) => state.datasetId);
  const selectedCount = useAssetSelectionStore((state) => state.selectedCount());
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId || (status && TERMINAL_JOB_STATUSES.has(status))) return;
    const timer = setTimeout(async () => {
      const response = await fetch(`/api/jobs/${jobId}`, { credentials: "same-origin" });
      const body = await response.json().catch(() => null) as { data?: { status: string } } | null;
      if (!body?.data) return;
      setStatus(body.data.status);
      if (body.data.status === "COMPLETED") {
        const download = await fetch(`/api/export-selected/${jobId}`, { credentials: "same-origin" });
        const downloadBody = await download.json().catch(() => null) as { data?: { download: { url: string } | null } } | null;
        if (downloadBody?.data?.download) setDownloadUrl(downloadBody.data.download.url);
      } else if (body.data.status === "FAILED" || body.data.status === "CANCELED") {
        setError("The export did not complete successfully.");
      }
    }, 2_000);
    return () => clearTimeout(timer);
  }, [jobId, status]);

  if (storeDatasetId !== datasetId || mode === "NONE") return null;

  async function startExport() {
    setError(null); setDownloadUrl(null); setStatus("QUEUED");
    const selection: BulkSelection | null = mode === "EXPLICIT"
      ? { mode: "EXPLICIT", assetIds: [...useAssetSelectionStore.getState().explicitIds] }
      : useAssetSelectionStore.getState().filteredQuery ? { mode: "FILTERED", datasetId, query: useAssetSelectionStore.getState().filteredQuery! } : null;
    if (!selection) return;
    const response = await fetch(`/api/datasets/${datasetId}/assets/bulk`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "EXPORT_SELECTED", selection, payload: {} }),
    });
    const body = await response.json().catch(() => null) as { data?: { jobId: string }; error?: { message?: string } } | null;
    if (!response.ok || !body?.data) { setError(body?.error?.message ?? "The export could not be started."); setStatus(null); return; }
    setJobId(body.data.jobId);
  }

  return <div className="mt-2">
    <button type="button" onClick={() => void startExport()} disabled={Boolean(jobId) && !TERMINAL_JOB_STATUSES.has(status ?? "")} className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">
      <DownloadSimple size={15} />Export Selected ({selectedCount.toLocaleString()})
    </button>
    {status && !TERMINAL_JOB_STATUSES.has(status) && <p role="status" className="mt-1 text-center text-[10px] text-zinc-500">Preparing export ({status.toLowerCase()})…</p>}
    {downloadUrl && <a href={downloadUrl} target="_blank" rel="noreferrer" className="mt-1 block text-center text-[10px] font-semibold text-sky-700 hover:text-sky-800">Download export</a>}
    {error && <p role="alert" className="mt-1 text-center text-[10px] text-rose-700">{error}</p>}
  </div>;
}
