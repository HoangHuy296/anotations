"use client";
import { useState } from "react";
import { useVisualizationRead } from "@/components/visualization/visualization-session";
import { PageControls, ReadState } from "@/components/visualization/read-state";
import type { ViewerActivity } from "@/types/visualization";
export function ActivityTab() {
  const [page, setPage] = useState(1);
  const { data, error, retry } = useVisualizationRead<ViewerActivity>(`/activity?page=${page}&pageSize=20`);
  return <section aria-labelledby="visualization-panel-title" className="mt-6"><h2 id="visualization-panel-title" className="text-lg font-semibold">Activity</h2><p className="mt-2 text-sm text-zinc-500">Persisted dataset Jobs only, newest first. This is not a complete edit, review, or lifecycle audit history. Job state is independent of dataset completion.</p>
    {!data ? <ReadState error={error} retry={retry} /> : <><ul className="mt-5 divide-y divide-zinc-200 dark:divide-zinc-800">{data.items.map(job => <li key={job.id} className="py-4 text-sm"><p className="font-semibold">{job.type === "VISUALIZATION_CAPTURE" ? "Immutable snapshot capture" : job.type === "VISUALIZATION_DERIVE" ? "Snapshot profiles and previews" : job.type} · {job.status}</p><p className="mt-1 break-all font-mono text-xs text-zinc-500">{job.id}</p><p className="mt-2">Created {job.createdAt}{job.finishedAt ? ` · Finished ${job.finishedAt}` : ""}</p></li>)}</ul>{data.total === 0 && <p className="py-6">No persisted Jobs are available.</p>}<PageControls {...data} onPage={setPage} /></>}
  </section>;
}
