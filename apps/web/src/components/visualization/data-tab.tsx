"use client";
import { SquaresFour, ListBullets, MagnifyingGlass } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AssetImage, ImageInspector } from "@/components/visualization/image-viewer";
import { PageControls, ReadState } from "@/components/visualization/read-state";
import { useVisualizationRead } from "@/components/visualization/visualization-session";
import type { ViewerAsset, ViewerPage } from "@/types/visualization";

export function DataTab() {
  const [view, setView] = useState<"grid" | "list">("grid");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("filename");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const { data, error, retry } = useVisualizationRead<ViewerPage<ViewerAsset>>(`/assets?${new URLSearchParams({ page: String(page), pageSize: "18", sort, q: query })}`);
  const index = data?.items.findIndex(asset => asset.row_id === selected) ?? -1;
  return <section aria-labelledby="visualization-panel-title" className="min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="visualization-panel-title" className="text-lg font-semibold">Data</h2><p className="mt-1 text-sm text-zinc-500">Browse records and select an image to inspect its annotations.</p></div>
      <div className="flex gap-1 rounded-lg border border-zinc-200 p-1 dark:border-zinc-700" role="group" aria-label="Record layout"><Button size="sm" variant={view === "grid" ? "secondary" : "ghost"} aria-pressed={view === "grid"} aria-label="Grid view" onClick={() => setView("grid")}><SquaresFour aria-hidden="true" size={17} /></Button><Button size="sm" variant={view === "list" ? "secondary" : "ghost"} aria-pressed={view === "list"} aria-label="List view" onClick={() => setView("list")}><ListBullets aria-hidden="true" size={17} /></Button></div>
    </div>
    <form className="my-5 flex flex-wrap items-end gap-3 rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40" onSubmit={event => { event.preventDefault(); setPage(1); setQuery(search); setSelected(null); }}>
      <label className="min-w-0 basis-full sm:flex-1 sm:basis-0 text-xs font-medium text-zinc-500">Search records<input placeholder="Search by filename…" className="mt-1.5 block h-10 w-full min-w-0 rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100" maxLength={100} value={search} onChange={event => setSearch(event.target.value)} /></label>
      <Button type="submit" variant="secondary"><MagnifyingGlass aria-hidden="true" size={16} />Search</Button>
      <label className="text-xs font-medium text-zinc-500">Sort by<select className="mt-1.5 block h-10 rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 focus-visible:outline-sky-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100" value={sort} onChange={event => { setSort(event.target.value); setPage(1); setSelected(null); }}><option value="filename">Filename</option><option value="createdAt">Created date</option></select></label>
    </form>
    {!data ? <ReadState error={error} retry={retry} /> : <>
      {data.items.length === 0 && <p className="py-10 text-center">No assets match this view.</p>}
      <div className={view === "grid" ? "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" : "divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800"}>{data.items.map(asset => <button key={asset.row_id} type="button" onClick={() => setSelected(asset.row_id)} className={view === "grid" ? "group min-w-0 overflow-hidden rounded-xl border border-zinc-200 bg-white text-left transition-colors hover:border-sky-400 focus-visible:outline-2 focus-visible:outline-sky-500 dark:border-zinc-800 dark:bg-zinc-900" : "flex w-full min-w-0 items-center gap-4 p-3 text-left hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-sky-500 dark:hover:bg-zinc-900"} aria-label={`Inspect ${asset.filename}`}>
        <div className={view === "grid" ? "[&>div]:aspect-[4/3] [&>div]:rounded-none [&_img]:max-h-48" : "w-20 shrink-0 [&>div]:h-16 [&>div]:min-h-0 [&_img]:max-h-16 [&_p]:p-1 [&_p]:text-[10px]"}><AssetImage asset={asset} /></div>
        <div className={view === "grid" ? "p-3" : "min-w-0 flex-1"}><span className="block truncate text-sm font-medium">{asset.filename}</span><span className="mt-1 block text-xs text-zinc-500">{asset.modality} · {asset.width && asset.height ? `${asset.width} × ${asset.height} px` : "Dimensions unavailable"}</span></div>
      </button>)}</div>
      <PageControls {...data} onPage={value => { setPage(value); setSelected(null); }} />
    </>}
    {selected && <ImageInspector assetId={selected} close={() => setSelected(null)} previous={index > 0 ? () => setSelected(data!.items[index - 1].row_id) : undefined} next={data && index >= 0 && index + 1 < data.items.length ? () => setSelected(data.items[index + 1].row_id) : undefined} />}
  </section>;
}
