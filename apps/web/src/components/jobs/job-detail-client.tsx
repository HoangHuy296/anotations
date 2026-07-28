"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowClockwise, SpinnerGap } from "@phosphor-icons/react";

import { JobActionButtons } from "@/components/jobs/job-action-buttons";
import { JobEventList } from "@/components/jobs/job-event-list";
import { JobProgressCard } from "@/components/jobs/job-progress-card";
import { Button } from "@/components/ui/button";
import { shouldPollJob, type JobDisplayEvent, type JobDisplayStatus } from "@/lib/jobs/job-progress-view";
import { repositoryImportProgressPath, repositoryImportProgressState } from "@/lib/repository-import/progress-state";

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  const body = await response.json() as { data?: T; error?: { message?: string } };
  if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Unable to refresh job.");
  return body.data;
}

export function JobDetailClient({ initialJob, initialEvents, variant = "generic" }: { initialJob: JobDisplayStatus; initialEvents: JobDisplayEvent[]; variant?: "generic" | "repository-import" }) {
  const router = useRouter();
  const [job, setJob] = useState(initialJob);
  const [events, setEvents] = useState(initialEvents);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setRefreshing(true); setRefreshError(null);
    const [nextJob, nextEvents] = await Promise.all([
      readJson<JobDisplayStatus>(`/api/jobs/${job.id}`),
      readJson<{ events: JobDisplayEvent[] }>(`/api/jobs/${job.id}/events?limit=50`),
    ]);
    setJob(nextJob); setEvents(nextEvents.events); setRefreshing(false);
  }, [job.id]);
  useEffect(() => {
    if (!shouldPollJob(job.status, typeof document === "undefined" ? false : !document.hidden)) return;
    const quietlyRefresh = () => { void refresh().catch(() => { setRefreshError("Could not refresh this job. Try again shortly."); setRefreshing(false); }); };
    const timer = window.setInterval(() => { if (!document.hidden) quietlyRefresh(); }, 10_000);
    const visibility = () => { if (!document.hidden && shouldPollJob(job.status)) quietlyRefresh(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [job.status, refresh]);
  const importState = variant === "repository-import" ? repositoryImportProgressState(job) : null;
  return <div className="mx-auto grid w-full max-w-4xl gap-5 px-4 py-8 sm:px-6"><header className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><p className="text-xs font-bold uppercase tracking-[.14em] text-zinc-400">Background jobs</p><h1 className="mt-1 text-2xl font-bold tracking-tight text-zinc-950">Job detail</h1><p className="mt-1 font-mono text-xs text-zinc-400">{job.id}</p></div><Button type="button" variant="secondary" size="sm" disabled={refreshing} onClick={() => { void refresh().catch(() => { setRefreshError("Could not refresh this job. Try again shortly."); setRefreshing(false); }); }}><span aria-hidden>{refreshing ? <SpinnerGap className="animate-spin" size={16} /> : <ArrowClockwise size={16} />}</span>Refresh</Button></header>{importState ? <p className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950" role="status" data-import-progress-state={importState.kind}>{importState.message}</p> : null}{refreshError ? <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">{refreshError}</p> : null}<div aria-live="polite"><JobProgressCard job={job} /></div><JobActionButtons job={job} onChanged={(result) => { if (result?.successorId) router.push(variant === "repository-import" ? repositoryImportProgressPath(job.datasetId, result.successorId) : `/jobs/${result.successorId}`); else void refresh().catch(() => { setRefreshError("Could not refresh this job. Try again shortly."); setRefreshing(false); }); }} /><JobEventList events={events} /></div>;
}
