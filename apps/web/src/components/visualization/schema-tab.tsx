"use client";
import { useState } from "react";
import { useVisualizationRead } from "@/components/visualization/visualization-session";
import { PageControls, ReadState } from "@/components/visualization/read-state";
import type { ViewerSchema, ViewerDerivedProfile } from "@/types/visualization";
export function SchemaTab() {
  const [page, setPage] = useState(1);
  const { data, error, retry } = useVisualizationRead<ViewerSchema>(`/schema?page=${page}&pageSize=50`);
  const derived = useVisualizationRead<ViewerDerivedProfile>("/derived");
  return <section aria-labelledby="visualization-panel-title" className="mt-6"><h2 id="visualization-panel-title" className="text-lg font-semibold">Schema</h2>
    <p className="mt-2 text-sm text-zinc-500">Actual viewer projections. Bounding boxes use normalized xywh 0..1; rendering multiplies by original image dimensions without changing stored coordinates.</p>
    {!data ? <ReadState error={error} retry={retry} /> : <><div className="mt-5 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-3">Field</th><th className="p-3">Type / units</th></tr></thead><tbody>{data.fields.map(field => <tr key={field.name} className="border-t border-zinc-200 dark:border-zinc-800"><td className="p-3 font-mono">{field.name}</td><td className="p-3">{field.type}</td></tr>)}</tbody></table></div>
      <h3 className="mt-6 font-semibold">Dataset label definitions</h3><ul className="mt-3 space-y-3">{data.labels.items.map(label => <li key={label.id} className="flex flex-wrap items-center gap-2 text-sm"><span aria-hidden="true" className="size-3 rounded-full" style={{ backgroundColor: label.color }} />{label.name}<span className="font-mono text-xs text-zinc-500">{label.id} · {label.color}</span></li>)}</ul>
      {data.labels.total === 0 && <p className="mt-3 text-sm">No label definitions exist.</p>}<PageControls {...data.labels} onPage={setPage} />
    </>}
    <h3 className="mt-6 font-semibold">Captured schema profile</h3>
    {!derived.data?.profile ? <p className="mt-2 text-sm text-zinc-500">No derived schema profile is available.</p> : <>
      <p className="mt-2 text-sm text-zinc-500">{derived.data.profileCurrent ? "Current immutable snapshot." : "Earlier immutable snapshot; live definitions above may differ."} Counts describe captured field availability, not annotation quality.</p>
      <ul className="mt-3 space-y-2 text-sm">{derived.data.profile.schema.map(field => <li key={field.field}>{field.field}: {field.type}{field.units ? ` · ${field.units}` : ""} · {field.presentCount} present</li>)}</ul>
    </>}
  </section>;
}
