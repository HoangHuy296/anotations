"use client";

import { ChartBar, LockSimple } from "@phosphor-icons/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DerivedStatus } from "@/components/visualization/derived-status";
import { useVisualizationRead } from "@/components/visualization/visualization-session";
import { visualizationTabHref } from "@/lib/validation/visualization";
import type { ViewerInsights, VisualizationDatasetIdentity } from "@/types/visualization";

const numberFormat = new Intl.NumberFormat("en");

export function DatasetSummary({ dataset }: { dataset: VisualizationDatasetIdentity }) {
  const { data, error, retry } = useVisualizationRead<ViewerInsights>("/insights");
  const counts = [
    { label: "Rows", value: data?.assetCount },
    { label: "Images", value: data?.imageCount },
    { label: "Annotations", value: data?.annotationCount },
    { label: "Other modalities", value: data?.unsupportedCount },
  ];

  return (
    <aside aria-label="Dataset overview" className="min-w-0 border-t border-zinc-200 pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0 dark:border-zinc-800">
      <section aria-labelledby="dataset-details-title">
        <h2 id="dataset-details-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Dataset details</h2>
        {error ? (
          <div role="status" className="mt-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">Dataset statistics could not be loaded.</p>
            <Button type="button" variant="secondary" size="sm" className="mt-2 h-7 min-h-7 rounded-md" onClick={retry}>Retry statistics</Button>
          </div>
        ) : (
          <dl className="mt-3 grid grid-cols-2 gap-2" aria-busy={!data}>
            {counts.map(({ label, value }) => (
              <div key={label} className="min-w-0 rounded-md border border-zinc-200 bg-zinc-50/70 px-3 py-2.5 dark:border-zinc-800 dark:bg-[#101722]">
                <dt className="text-[11px] text-zinc-500 dark:text-zinc-400">{label}</dt>
                <dd className="mt-1 font-mono text-sm font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
                  {value === undefined ? <span className="block h-4 w-12 rounded bg-zinc-200 motion-safe:animate-pulse dark:bg-zinc-700"><span className="sr-only">Loading {label.toLowerCase()}</span></span> : numberFormat.format(value)}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <p className="mt-3 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">Live counts of active records and saved annotations, across all review states.</p>
      </section>

      {!error && (
        <section aria-labelledby="dataset-labels-title" className="mt-5 border-t border-zinc-200 pt-5 dark:border-zinc-800">
          <h3 id="dataset-labels-title" className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100"><ChartBar aria-hidden="true" size={15} />Label distribution</h3>
          {!data ? (
            <div role="status" className="mt-4 space-y-3">
              <span className="sr-only">Loading label distribution</span>
              {[0, 1, 2].map(row => <span key={row} aria-hidden="true" className="block h-5 rounded bg-zinc-100 motion-safe:animate-pulse dark:bg-zinc-800" />)}
            </div>
          ) : data.labelDistribution.length === 0 ? (
            <p className="mt-3 text-xs leading-5 text-zinc-500 dark:text-zinc-400">No saved annotations yet.</p>
          ) : (
            <>
              <ul className="mt-4 space-y-3">
                {data.labelDistribution.slice(0, 6).map((row, index) => {
                  const percentage = data.annotationCount > 0 ? Math.min(100, row.count / data.annotationCount * 100) : 0;
                  return (
                    <li key={row.label?.id ?? `unlabeled-${index}`}>
                      <div className="flex min-w-0 items-center justify-between gap-3 text-xs">
                        <span className="min-w-0 break-words text-zinc-700 dark:text-zinc-300">{row.label?.name ?? "Unlabeled"}</span>
                        <span className="shrink-0 font-mono tabular-nums text-zinc-500 dark:text-zinc-400">{numberFormat.format(row.count)}<span className="sr-only"> annotations, {percentage.toFixed(1)} percent</span></span>
                      </div>
                      <div aria-hidden="true" className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                        <div className="h-full rounded-full" style={{ width: `${percentage}%`, backgroundColor: row.label?.color ?? "#64748b" }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">Share of saved annotations; includes unlabeled annotations.</p>
              {(data.labelDistribution.length > 6 || data.distributionTruncated) && <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">Showing the six largest label groups.</p>}
              <Link href={visualizationTabHref(dataset.id, "insights")} prefetch={false} className="mt-2 inline-flex rounded text-xs text-sky-700 hover:underline focus-visible:outline-2 focus-visible:outline-sky-500 dark:text-sky-400">View distribution</Link>
            </>
          )}
        </section>
      )}

      <section aria-labelledby="dataset-preview-title" className="mt-5 border-t border-zinc-200 pt-5 dark:border-zinc-800">
        <h3 id="dataset-preview-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Snapshot previews</h3>
        <DerivedStatus />
      </section>

      <section className="mt-5 border-t border-zinc-200 pt-5 dark:border-zinc-800">
        <h3 className="flex items-center gap-2 text-xs font-medium text-zinc-700 dark:text-zinc-300"><LockSimple aria-hidden="true" size={14} />Read-only dataset</h3>
        <p className="mt-2 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">Completed datasets can be explored without changing source data. Completion does not imply annotation review or acceptance.</p>
        <details className="mt-4 text-[11px] text-zinc-500 dark:text-zinc-400">
          <summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-sky-500">Dataset ID</summary>
          <p className="mt-2 break-all font-mono leading-5">{dataset.id}</p>
        </details>
      </section>
    </aside>
  );
}
