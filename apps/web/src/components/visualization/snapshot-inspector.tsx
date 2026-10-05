"use client";
import { useState } from "react";
import { AssetImage } from "@/components/visualization/image-viewer";
import { PageControls, ReadState } from "@/components/visualization/read-state";
import { useVisualizationRead } from "@/components/visualization/visualization-session";
import type { ViewerSnapshotContent } from "@/types/visualization";
export function SnapshotInspector({ snapshotId }: { snapshotId: string }) {
  const [page, setPage] = useState(1);
  const { data, error, retry } = useVisualizationRead<ViewerSnapshotContent>(`/versions/${snapshotId}?page=${page}&pageSize=12`);
  if (!data) return <ReadState error={error} retry={retry} />;
  return <div className="mt-4">
    <p className="mb-3 text-sm text-zinc-500">Captured images and persisted overlays. Coordinates remain normalized 0..1 and use captured original dimensions.</p>
    <div className="grid gap-3 sm:grid-cols-2">{data.items.map(row => {
      const annotations = data.annotations.filter(a => a.assetId === row.id);
      const asset = { row_id: row.id, filename: row.filename, modality: row.modality, width: row.width, height: row.height, mediaAvailable: Boolean(row.imageArtifactId) };
      return <div key={row.id} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800"><AssetImage asset={asset} detail={{ ...asset, annotations, annotationCount: annotations.length, annotationsTruncated: data.annotationsTruncated }} showBoxes mediaPath={row.imageArtifactId ? `/artifacts/${row.imageArtifactId}` : undefined} /><p className="mt-2 break-words text-sm font-semibold">{row.filename}</p>{annotations.some(a => a.overlayUnavailable) && <p className="mt-1 text-sm">Some captured overlays are unavailable.</p>}</div>;
    })}</div>
    {data.annotationsTruncated && <p className="mt-2 text-sm">Overlays are bounded to the first 500 annotations for this page.</p>}
    <PageControls {...data} onPage={setPage} />
  </div>;
}
