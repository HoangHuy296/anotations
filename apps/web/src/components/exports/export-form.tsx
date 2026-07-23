"use client";

import { CheckCircle, DownloadSimple, Export, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

type ExportJob = {
  id: string;
  datasetId: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED" | string;
  stage: string | null;
  progress: number | null;
  totalItems: number | null;
  processedItems: number | null;
  summary: { message?: string; outcome?: "completed" | "failed" | "canceled" } | null;
  updatedAt: string;
};

type Download = { url: string; filename: string; expiresAt: string } | null;
type ApiEnvelope<T> = { data?: T; error?: { message?: string } };
const terminalStates = new Set(["COMPLETED", "FAILED", "CANCELED"]);

export function ExportForm({ datasets }: { datasets: Array<{ id: string; name: string }> }) {
  const [isPending, startTransition] = useTransition();
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? "");
  const [job, setJob] = useState<ExportJob | null>(null);
  const [download, setDownload] = useState<Download>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!job || terminalStates.has(job.status)) return;
    const timer = window.setTimeout(() => {
      void fetch(`/api/export/${job.id}`, { cache: "no-store" })
        .then(async (response) => {
          const body = await response.json() as ApiEnvelope<{ job: ExportJob; download: Download }>;
          if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Unable to refresh export status.");
          setJob(body.data.job);
          setDownload(body.data.download);
        })
        .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Unable to refresh export status."));
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [job]);

  function createExport() {
    setMessage(null);
    setDownload(null);
    startTransition(() => {
      void fetch("/api/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasetId, format: "JSON", manifestSchemaVersion: "1" }) })
        .then(async (response) => {
          const body = await response.json() as ApiEnvelope<{ job: ExportJob; deliveryPending: boolean }>;
          if (!response.ok || !body.data) throw new Error(body.error?.message ?? "The export could not be started.");
          setJob(body.data.job);
          setMessage(body.data.deliveryPending ? "Export was saved and will begin when queue delivery recovers." : "Export started. This status updates automatically.");
        })
        .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "The export could not be started."));
    });
  }

  if (datasets.length === 0) return <div className="mt-7 rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 p-8 text-center text-sm leading-6 text-zinc-500">Create or join a dataset before requesting an export.</div>;

  return <div className="mt-7 grid gap-7 xl:grid-cols-[minmax(300px,0.72fr)_minmax(0,1.28fr)]">
    <section className="rounded-2xl border border-zinc-200 bg-zinc-50 p-5 lg:p-6">
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-400">New export</p>
      <h2 className="mt-2 text-lg font-bold text-zinc-950">Annotation manifest</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-500">Exports are generated asynchronously as a JSON manifest. CSV and other formats are not available.</p>
      <label className="mt-6 block"><span className="text-xs font-semibold text-zinc-700">Dataset</span><select className="mt-2 h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100" disabled={isPending} onChange={(event) => setDatasetId(event.target.value)} value={datasetId}>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</select></label>
      <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900"><span className="font-semibold">Format:</span> JSON</div>
      <Button className="mt-6 w-full" disabled={isPending || !datasetId} onClick={createExport} type="button">{isPending ? <SpinnerGap aria-hidden="true" className="animate-spin" size={17} /> : <Export aria-hidden="true" size={17} />}{isPending ? "Starting export..." : "Create JSON export"}</Button>
    </section>
    <section className="min-h-80 rounded-2xl border border-zinc-200 bg-white p-5 lg:p-6" aria-live="polite">
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-400">Export status</p>
      {!job ? <div className="grid min-h-56 place-items-center text-center"><p className="max-w-xs text-sm leading-6 text-zinc-400">Choose an authorized dataset and start a JSON export. Progress and a download link will appear here.</p></div> : <ExportStatus download={download} job={job} message={message} />}
      {!job && message && <p className="mt-4 text-xs text-rose-700">{message}</p>}
    </section>
  </div>;
}

function ExportStatus({ job, download, message }: { job: ExportJob; download: Download; message: string | null }) {
  const failed = job.status === "FAILED" || job.status === "CANCELED";
  const completed = job.status === "COMPLETED";
  const progress = Math.max(0, Math.min(100, job.progress ?? 0));
  return <div className="mt-5">
    <div className="flex items-start justify-between gap-4"><div><h2 className="text-lg font-bold text-zinc-950">{completed ? "Export ready" : failed ? "Export did not finish" : "Preparing export"}</h2><p className="mt-1 font-mono text-xs text-zinc-500">{job.stage ?? job.status}</p></div>{completed ? <CheckCircle aria-hidden="true" className="text-emerald-600" size={24} weight="fill" /> : failed ? <WarningCircle aria-hidden="true" className="text-rose-600" size={24} weight="fill" /> : <SpinnerGap aria-hidden="true" className="animate-spin text-sky-600" size={24} />}</div>
    <div className="mt-7"><div className="flex justify-between text-xs text-zinc-500"><span>{job.processedItems ?? 0}{job.totalItems !== null ? ` / ${job.totalItems}` : ""} items</span><span className="font-mono font-semibold text-zinc-800">{progress}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100"><div className="h-full rounded-full bg-sky-600 transition-[width]" style={{ width: `${progress}%` }} /></div></div>
    <p className={`mt-5 text-sm leading-6 ${failed ? "text-rose-700" : "text-zinc-500"}`}>{message ?? job.summary?.message ?? (completed ? "Your JSON manifest is available for download." : "The export status refreshes automatically.")}</p>
    {completed && download && <Button className="mt-6" onClick={() => window.location.assign(download.url)} type="button"><DownloadSimple aria-hidden="true" size={17} />Download JSON</Button>}
    {completed && !download && <p className="mt-5 text-sm text-amber-700">The export completed, but its download is not yet available.</p>}
  </div>;
}
