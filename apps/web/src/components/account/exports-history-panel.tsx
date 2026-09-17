"use client";

import { CheckCircle, DownloadSimple, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { fetchExportDownload, fetchExportHistory } from "@/lib/exports/export-history-client";
import type { SafeExportJobWithDataset } from "@/lib/exports/types";

const dateFormatter = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

function statusView(status: SafeExportJobWithDataset["status"]) {
  if (status === "COMPLETED") return { label: "Completed", icon: CheckCircle, className: "text-emerald-600" };
  if (status === "FAILED" || status === "CANCELED") return { label: status === "FAILED" ? "Failed" : "Canceled", icon: WarningCircle, className: "text-rose-600" };
  return { label: "In progress", icon: SpinnerGap, className: "text-sky-600" };
}

export function ExportsHistoryPanel({ initialItems, initialNextCursor }: { initialItems: SafeExportJobWithDataset[]; initialNextCursor: string | null }) {
  const [items, setItems] = useState(initialItems);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchExportHistory({ cursor: nextCursor, limit: 10 });
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "More exports could not be loaded.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function download(jobId: string) {
    if (downloadingId) return;
    setDownloadingId(jobId);
    setError(null);
    try {
      const result = await fetchExportDownload(jobId);
      if (!result) { setError("This export's download is not available yet."); return; }
      window.location.assign(result.url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "This export could not be downloaded.");
    } finally {
      setDownloadingId(null);
    }
  }

  if (items.length === 0) {
    return <div className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50/60 px-5 py-8 text-center text-sm leading-6 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-400">You have not created any exports yet. Start one from the <a className="font-semibold text-sky-700 hover:text-sky-800 dark:text-sky-400 dark:hover:text-sky-300" href="/exports">Exports</a> page.</div>;
  }

  return (
    <div>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {items.map((job) => {
          const view = statusView(job.status);
          const Icon = view.icon;
          const filename = job.datasetName ? `${job.datasetName}.json` : "export.json";
          return (
            <div key={job.id} className="flex items-center justify-between gap-4 py-3.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{job.datasetName ?? "Deleted dataset"}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                  <span className="inline-flex items-center gap-1.5"><Icon aria-hidden="true" className={`${view.className} ${job.status !== "COMPLETED" && job.status !== "FAILED" && job.status !== "CANCELED" ? "animate-spin" : ""}`} size={13} weight={job.status === "COMPLETED" || job.status === "FAILED" ? "fill" : "regular"} />{view.label}</span>
                  <span aria-hidden="true">·</span>
                  <time dateTime={job.createdAt}>{dateFormatter.format(new Date(job.createdAt))}</time>
                </div>
              </div>
              {job.status === "COMPLETED" ? (
                <Button variant="secondary" size="sm" disabled={downloadingId === job.id} onClick={() => void download(job.id)} type="button">
                  {downloadingId === job.id ? <SpinnerGap aria-hidden="true" className="animate-spin" size={15} /> : <DownloadSimple aria-hidden="true" size={15} />}
                  {filename}
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
      {error ? <p role="alert" className="mt-3 text-xs text-rose-700 dark:text-rose-400">{error}</p> : null}
      {nextCursor ? (
        <Button variant="ghost" size="sm" className="mt-3" disabled={loadingMore} onClick={() => void loadMore()} type="button">
          {loadingMore ? <SpinnerGap aria-hidden="true" className="animate-spin" size={14} /> : null}
          {loadingMore ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}
