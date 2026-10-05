"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { boxPixels } from "@/lib/visualization/geometry";
import { useVisualizationRead, useVisualizationSession } from "@/components/visualization/visualization-session";
import { ReadState } from "@/components/visualization/read-state";
import type { ViewerAsset, ViewerAssetDetail } from "@/types/visualization";

export function AssetImage({ asset, detail, showBoxes = false, mediaPath }: { asset: ViewerAsset; detail?: ViewerAssetDetail; showBoxes?: boolean; mediaPath?: string }) {
  const { read } = useVisualizationSession();
  const container = useRef<HTMLDivElement>(null);
  const [dimensionMismatch, setDimensionMismatch] = useState(false);
  const [media, setMedia] = useState<{ id: string; url?: string; failed?: boolean; derived?: boolean } | null>(null);
  useEffect(() => {
    if (!asset.mediaAvailable || asset.modality !== "IMAGE") return;
    const controller = new AbortController();
    let url: string | undefined;
    let started = false;
    const load = () => {
      if (started) return;
      started = true;
      void read(mediaPath ?? `/assets/${asset.row_id}/media?variant=${detail ? "PREVIEW" : "THUMBNAIL"}`, controller.signal).then(async response => ({ blob: await response.blob(), derived: response.headers.get("X-Visualization-Preview") === "ready" })).then(({ blob, derived }) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setMedia({ id: asset.row_id, url, derived });
      }).catch(() => { if (!controller.signal.aborted) setMedia({ id: asset.row_id, failed: true }); });
    };
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) load(); });
    if (container.current) observer.observe(container.current);
    return () => { controller.abort(); observer.disconnect(); if (url) URL.revokeObjectURL(url); };
  }, [asset.row_id, asset.mediaAvailable, asset.modality, read, detail, mediaPath]);
  const current = media?.id === asset.row_id ? media : null;
  const dimensionsValid = Boolean(asset.width && asset.height && asset.width > 0 && asset.height > 0);
  return <div ref={container} className="flex min-h-40 items-center justify-center overflow-hidden rounded-xl bg-zinc-100 dark:bg-zinc-950">
    {asset.modality !== "IMAGE" ? <p className="p-5 text-sm">{asset.modality} viewing is not supported yet.</p>
      : !asset.mediaAvailable || current?.failed ? <p className="p-5 text-sm" role="status">Image media unavailable.</p>
      : !current?.url ? <p className="p-5 text-sm" role="status">Loading image…</p>
      : <div className="relative inline-block max-w-full">
        {/* Original bytes are authorized by the application route, never the Next image proxy. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={current.url} alt={asset.filename} className="block max-h-[65vh] max-w-full object-contain" onLoad={event => { const image = event.currentTarget; setDimensionMismatch(Boolean(dimensionsValid && (current.derived ? Math.abs(image.naturalWidth * asset.height! - image.naturalHeight * asset.width!) > Math.max(asset.width!, asset.height!) : image.naturalWidth !== asset.width || image.naturalHeight !== asset.height))); }} onError={() => setMedia({ id: asset.row_id, failed: true })} />
        {showBoxes && dimensionsValid && !dimensionMismatch && detail && <BoundingBoxOverlay detail={detail} />}
        {dimensionMismatch && <p role="status" className="p-3 text-sm">Overlay unavailable: media dimensions do not match the stored original dimensions.</p>}
      </div>}
  </div>;
}

export function BoundingBoxOverlay({ detail }: { detail: ViewerAssetDetail }) {
  if (!detail.width || !detail.height || detail.width <= 0 || detail.height <= 0) return null;
  return <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${detail.width} ${detail.height}`} role="img" aria-label="Persisted bounding-box overlays">
    {detail.annotations.filter(annotation => annotation.geometry).map(annotation => {
      const box = boxPixels(annotation.geometry!, detail.width!, detail.height!);
      const color = annotation.label?.color ?? "#64748b";
      return <g key={annotation.id}><title>{annotation.label?.name ?? "Unlabeled"}</title><rect {...box} fill="none" stroke={/^#[0-9a-f]{6}$/i.test(color) ? color : "#64748b"} strokeWidth={2} vectorEffect="non-scaling-stroke" /></g>;
    })}
  </svg>;
}

export function ImageInspector({ assetId, close, previous, next }: { assetId: string; close: () => void; previous?: () => void; next?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [showBoxes, setShowBoxes] = useState(true);
  const { data, error, retry } = useVisualizationRead<ViewerAssetDetail>(`/assets/${assetId}`);
  useEffect(() => {
    const element = dialog.current;
    const focused = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => { element?.close(); focused?.focus(); };
  }, []);
  return <dialog ref={dialog} aria-labelledby="asset-inspector-title" onCancel={close} className="m-auto max-h-[95dvh] w-[min(1100px,95vw)] overflow-auto rounded-2xl border border-zinc-200 bg-white p-5 text-zinc-900 backdrop:bg-black/60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
    onKeyDown={event => { if (event.key === "ArrowLeft" && previous) { event.preventDefault(); previous(); } if (event.key === "ArrowRight" && next) { event.preventDefault(); next(); } }}>
    <div className="mb-5 flex items-center justify-between gap-3"><h2 id="asset-inspector-title" className="min-w-0 break-words text-lg font-semibold">{data?.filename ?? "Image inspector"}</h2><Button variant="secondary" onClick={close}>Close</Button></div>
    {!data ? <ReadState error={error} retry={retry} /> : <>
      {data.modality === "IMAGE" && <label className="mb-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={showBoxes} onChange={event => setShowBoxes(event.target.checked)} />Show bounding boxes</label>}
      <AssetImage key={data.row_id} asset={data} detail={data} showBoxes={showBoxes} />
      {(!data.width || !data.height || data.width <= 0 || data.height <= 0) && <p className="mt-3 text-sm">Overlay unavailable: original image dimensions are missing or invalid.</p>}
      <p className="mt-4 text-sm">{data.annotationCount} persisted annotations. Completion does not imply annotation review or correctness.</p>
      {data.annotationsTruncated && <p className="mt-2 text-sm">Showing the first 500 annotations. Additional overlays are unavailable in this view.</p>}
      <ul className="mt-3 max-h-48 space-y-2 overflow-auto text-sm">{data.annotations.map(annotation => <li key={annotation.id} className="flex flex-wrap items-center gap-2">
        <span aria-hidden="true" className="size-3 rounded-full" style={{ backgroundColor: annotation.label?.color ?? "#64748b" }} />
        <span>{annotation.label?.name ?? "Unlabeled"}</span><span className="text-zinc-500">{annotation.type} · revision {annotation.revision}</span>
        {annotation.overlayUnavailable && <span>Overlay unavailable: {annotation.overlayUnavailable}</span>}
      </li>)}</ul>
    </>}
    <div className="mt-5 flex gap-2"><Button variant="secondary" disabled={!previous} onClick={previous}>Previous asset</Button><Button variant="secondary" disabled={!next} onClick={next}>Next asset</Button></div>
    <p className="mt-2 text-xs text-zinc-500">Arrow keys navigate this page. Escape closes the inspector.</p>
  </dialog>;
}
