"use client";
import { useVisualizationRead } from "@/components/visualization/visualization-session";
import { ReadState } from "@/components/visualization/read-state";
import type { ViewerDerivedProfile, ViewerInsights } from "@/types/visualization";
export function InsightsTab() {
  const { data, error, retry } = useVisualizationRead<ViewerInsights>("/insights");
  const derived = useVisualizationRead<ViewerDerivedProfile>("/derived");
  return <section aria-labelledby="visualization-panel-title" className="mt-6"><h2 id="visualization-panel-title" className="text-lg font-semibold">Insights</h2>
    <p className="mt-2 text-sm text-zinc-500">Dataset-wide counts of active assets and their persisted annotations, across all modalities and annotation statuses. These are not review or quality scores.</p>
    {!data ? <ReadState error={error} retry={retry} /> : <>
      <dl className="my-6 grid gap-3 sm:grid-cols-3">{[["Assets", data.assetCount], ["Images", data.imageCount], ["Unsupported assets", data.unsupportedCount], ["Persisted annotations", data.annotationCount]].map(([label, value]) => <div key={label} className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800"><dt className="text-sm text-zinc-500">{label}</dt><dd className="mt-2 text-2xl font-semibold">{value}</dd></div>)}</dl>
      <h3 className="font-semibold">Annotation label distribution</h3><p className="mt-1 text-sm text-zinc-500">Denominator: {data.annotationCount} persisted annotations on active assets. Counts are annotations, not distinct images. Includes unlabeled annotations.</p>
      <ul className="my-4 space-y-2">{data.labelDistribution.map((row, index) => <li key={row.label?.id ?? index} className="flex items-center gap-2 text-sm"><span aria-hidden="true" className="size-3 rounded-full" style={{ backgroundColor: row.label?.color ?? "#64748b" }} />{row.label?.name ?? "Unlabeled"}: {row.count}</li>)}</ul>
      {data.distributionTruncated && <p className="text-sm">Showing the 50 largest label groups; other groups are not displayed.</p>}
      <h3 className="mt-6 font-semibold">Original image dimensions</h3><p className="mt-2 text-sm">{data.dimensions.count} of {data.imageCount} images have valid dimensions. {data.dimensions.count > 0 ? `Width: ${data.dimensions.minWidth}–${data.dimensions.maxWidth} px. Height: ${data.dimensions.minHeight}–${data.dimensions.maxHeight} px.` : "Dimension ranges unavailable."}</p>
    </>}
    <h3 className="mt-6 font-semibold">Snapshot profile</h3>
    {!derived.data ? <ReadState error={derived.error} retry={derived.retry} /> : <>
      <p role="status" className="mt-2 text-sm">Derived processing: {derived.data.state.status}. {derived.data.profileCurrent ? "Profile scope: the current published snapshot." : "Any profile below describes an earlier immutable snapshot, not current source content."}</p>
      {!derived.data.profile ? <p className="mt-2 text-sm text-zinc-500">No derived profile has been published. Live counts above remain available.</p> : <>
        <p className="mt-3 text-sm">Snapshot denominator: {derived.data.profile.assetCount} active assets and {derived.data.profile.annotationCount} persisted annotations. {derived.data.profile.unlabeledAssetCount} assets have no annotations.</p>
        <p className="mt-2 text-sm">{derived.data.profile.validBoundingBoxCount} valid normalized image bounding boxes; {derived.data.profile.invalidBoundingBoxCount} invalid boxes excluded from area distribution. Completion does not imply review or correctness.</p>
        <h4 className="mt-3 text-sm font-semibold">Bounding-box area as a fraction of the original image</h4>
        <ul className="mt-2 grid gap-2 text-sm sm:grid-cols-2">{derived.data.profile.boxAreaHistogram.map(bin => <li key={bin.lower}>{bin.lower.toFixed(1)}–{bin.upper.toFixed(1)}: {bin.count} boxes</li>)}</ul>
      </>}
    </>}
  </section>;
}
