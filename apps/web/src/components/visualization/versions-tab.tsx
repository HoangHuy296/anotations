"use client";
import { SnapshotInspector } from "@/components/visualization/snapshot-inspector";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { PageControls, ReadState } from "@/components/visualization/read-state";
import { useVisualizationRead } from "@/components/visualization/visualization-session";
import type { ViewerVersions } from "@/types/visualization";

export function VersionsTab() {
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const { data, error, retry } = useVisualizationRead<ViewerVersions>(`/versions?page=${page}&pageSize=20`);
  return <section aria-labelledby="visualization-panel-title" className="mt-6">
    <h2 id="visualization-panel-title" className="text-lg font-semibold">Versions</h2>
    <p className="mt-2 text-sm text-zinc-500">Immutable captures of active assets, original image bytes, label definitions and persisted annotations. Only successfully published snapshots appear here; earlier history is not reconstructed.</p>
    {!data ? <ReadState error={error} retry={retry} /> : <>
      <p role="status" className="my-4 text-sm">Current content processing: {data.state.status}. {data.state.snapshotId && !data.state.current && "The last published snapshot is retained; source content has changed."}</p>
      {data.total === 0 && <p className="rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">No immutable snapshots have been published.</p>}
      <ol className="my-4 space-y-3">{data.items.map(snapshot => <li key={snapshot.id} className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
        <h3 className="font-semibold">Version {snapshot.ordinal}{data.state.current && data.state.snapshotId === snapshot.id ? " · Current content" : ""}</h3>
        <p className="mt-2 text-sm">{snapshot.assetCount} assets · {snapshot.annotationCount} persisted annotations</p>
        <p className="mt-1 text-sm text-zinc-500">Published <time dateTime={snapshot.publishedAt}>{new Date(snapshot.publishedAt).toLocaleString()}</time></p>
        <details className="mt-3 text-sm"><summary className="cursor-pointer focus-visible:outline-2">Snapshot identity</summary><p className="mt-2 break-all font-mono text-xs">{snapshot.id}</p><p className="mt-1">Content generation: {snapshot.generation}</p></details>
        <Button type="button" variant="secondary" className="mt-3" aria-expanded={selected === snapshot.id} onClick={() => setSelected(selected === snapshot.id ? null : snapshot.id)}>{selected === snapshot.id ? "Close capture" : "Inspect capture"}</Button>
        {selected === snapshot.id && <SnapshotInspector key={snapshot.id} snapshotId={snapshot.id} />}
      </li>)}</ol>
      <PageControls {...data} onPage={setPage} />
    </>}
  </section>;
}
