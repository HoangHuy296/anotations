"use client";

import { LockSimple } from "@phosphor-icons/react";
import { DerivedStatus } from "@/components/visualization/derived-status";
import { useVisualizationRead } from "@/components/visualization/visualization-session";
import type { ViewerInsights, VisualizationDatasetIdentity } from "@/types/visualization";

export function DatasetSummary({ dataset }: { dataset: VisualizationDatasetIdentity }) {
  const { data, error } = useVisualizationRead<ViewerInsights>("/insights");
  return <aside aria-label="Dataset overview" className="min-w-0 border-t border-zinc-200 pt-6 lg:border-l lg:border-t-0 lg:pl-6 dark:border-zinc-800">
    <h2 className="text-sm font-semibold">Dataset overview</h2>
    <dl className="mt-4 divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
      {[["Active records", data?.assetCount], ["Images", data?.imageCount], ["Persisted annotations", data?.annotationCount], ["Unsupported records", data?.unsupportedCount]].map(([label, value]) => <div key={label} className="flex justify-between gap-3 py-3"><dt className="text-zinc-500">{label}</dt><dd className="font-mono font-medium">{value ?? (error ? "Unavailable" : "…")}</dd></div>)}
    </dl>
    <p className="mt-3 text-xs leading-5 text-zinc-500">Counts cover active records and saved annotations, across all review states.</p>
    <h3 className="mt-7 text-sm font-semibold">Preview availability</h3><DerivedStatus />
    <div className="mt-7 border-t border-zinc-200 pt-5 dark:border-zinc-800"><h3 className="flex items-center gap-2 text-sm font-semibold"><LockSimple aria-hidden="true" size={15} />Read-only dataset</h3><p className="mt-2 text-xs leading-5 text-zinc-500">Explore without changing source data. Completed does not mean every annotation has been reviewed or accepted.</p></div>
    <h3 className="mt-6 text-xs font-medium text-zinc-500">Dataset ID</h3><p className="mt-2 break-all font-mono text-xs text-zinc-500">{dataset.id}</p>
  </aside>;
}
