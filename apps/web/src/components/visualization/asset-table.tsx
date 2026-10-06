"use client";

import { ArrowDown, ArrowUp, FileText, Image, MusicNote, VideoCamera } from "@phosphor-icons/react";

import { AssetImage } from "@/components/visualization/image-viewer";
import type { VisualizationAssetsQuery } from "@/lib/validation/visualization";
import type { ViewerAsset } from "@/types/visualization";

export function AssetThumbnail({ asset }: { asset: ViewerAsset }) {
  if (asset.modality === "IMAGE" && asset.mediaAvailable) return <AssetImage asset={asset} />;
  const Icon = asset.modality === "VIDEO" ? VideoCamera : asset.modality === "AUDIO" ? MusicNote : asset.modality === "TEXT" ? FileText : Image;
  return <div className="flex h-full min-h-16 flex-col items-center justify-center gap-1 bg-zinc-50 px-2 text-zinc-400 dark:bg-zinc-900/60">
    <Icon aria-hidden="true" size={22} weight="duotone" />
    <span className="text-[9px]">{asset.modality === "IMAGE" ? "Unavailable" : "No preview"}</span>
  </div>;
}

export function AssetTable({ assets, sort, order, onFilenameSort, onInspect }: {
  assets: ViewerAsset[];
  sort: VisualizationAssetsQuery["sort"];
  order: VisualizationAssetsQuery["order"];
  onFilenameSort: () => void;
  onInspect: (assetId: string) => void;
}) {
  return <div role="region" aria-label="Dataset records" tabIndex={0} className="max-h-[640px] overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500">
    <table className="w-full min-w-[720px] table-fixed border-collapse text-left text-xs">
      <caption className="sr-only">Dataset records. Select a filename or image to inspect persisted annotations.</caption>
      <colgroup><col className="w-28" /><col className="w-64" /><col className="w-28" /><col className="w-24" /><col className="w-24" /><col className="w-52" /></colgroup>
      <thead className="sticky top-0 bg-zinc-50 dark:bg-[#10151e]">
        <tr className="divide-x divide-zinc-200 border-b border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          <th scope="col" className="px-3 py-3 align-top"><span className="font-mono font-semibold">image</span><span className="mt-1 block text-[10px] font-normal text-zinc-500">image · preview</span></th>
          <th scope="col" aria-sort={sort === "filename" ? order === "asc" ? "ascending" : "descending" : "none"} className="px-3 py-3 align-top">
            <button type="button" onClick={onFilenameSort} aria-label={sort === "filename" && order === "asc" ? "Sort filename descending" : "Sort filename ascending"} className="flex w-full items-center justify-between gap-2 rounded font-mono font-semibold hover:text-sky-600 focus-visible:outline-2 focus-visible:outline-sky-500">filename{sort === "filename" ? order === "asc" ? <ArrowUp aria-hidden="true" size={12} /> : <ArrowDown aria-hidden="true" size={12} /> : null}</button>
            <span className="mt-1 block text-[10px] font-normal text-zinc-500">string · filename</span>
          </th>
          <th scope="col" className="px-3 py-3 align-top"><span className="font-mono font-semibold">modality</span><span className="mt-1 block text-[10px] font-normal text-zinc-500">string · class</span></th>
          <th scope="col" className="px-3 py-3 align-top"><span className="font-mono font-semibold">width</span><span className="mt-1 block text-[10px] font-normal text-zinc-500">int · pixels</span></th>
          <th scope="col" className="px-3 py-3 align-top"><span className="font-mono font-semibold">height</span><span className="mt-1 block text-[10px] font-normal text-zinc-500">int · pixels</span></th>
          <th scope="col" className="px-3 py-3 align-top"><span className="font-mono font-semibold">row_id</span><span className="mt-1 block text-[10px] font-normal text-zinc-500">string · identifier</span></th>
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {assets.map(asset => <tr key={asset.row_id} className="divide-x divide-zinc-100 odd:bg-white even:bg-zinc-50/60 hover:bg-sky-50/50 dark:divide-zinc-800/70 dark:odd:bg-[#0b0f17] dark:even:bg-[#10151e] dark:hover:bg-zinc-800/50">
          <td className="p-2"><button type="button" aria-label={`Preview ${asset.filename}`} onClick={() => onInspect(asset.row_id)} className="block h-16 w-full overflow-hidden rounded border border-zinc-200 outline-none focus-visible:ring-2 focus-visible:ring-sky-500 [&>div]:h-full [&>div]:min-h-0 [&>div]:rounded-none [&_img]:max-h-16 [&_p]:p-1 [&_p]:text-[9px] dark:border-zinc-800"><AssetThumbnail asset={asset} /></button></td>
          <td className="px-3 py-2"><button type="button" onClick={() => onInspect(asset.row_id)} aria-label={`Inspect ${asset.filename}`} title={asset.filename} className="block w-full truncate rounded py-2 text-left font-mono text-[11px] text-zinc-800 hover:text-sky-700 focus-visible:outline-2 focus-visible:outline-sky-500 dark:text-zinc-200 dark:hover:text-sky-400">{asset.filename}</button></td>
          <td className="px-3 py-2"><span className="rounded border border-zinc-200 bg-zinc-100/50 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-400">{asset.modality.toLowerCase()}</span></td>
          <td className="px-3 py-2 font-mono text-[11px] text-zinc-600 dark:text-zinc-400">{asset.width && asset.width > 0 ? asset.width.toLocaleString() : <span aria-label="Width unavailable">—</span>}</td>
          <td className="px-3 py-2 font-mono text-[11px] text-zinc-600 dark:text-zinc-400">{asset.height && asset.height > 0 ? asset.height.toLocaleString() : <span aria-label="Height unavailable">—</span>}</td>
          <td className="px-3 py-2"><span title={asset.row_id} className="block truncate font-mono text-[10px] text-zinc-500">{asset.row_id}</span></td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}
