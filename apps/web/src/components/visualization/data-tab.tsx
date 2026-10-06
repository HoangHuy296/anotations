"use client";

import { ArrowDown, ArrowUp, Database, MagnifyingGlass, SquaresFour, Table, X } from "@phosphor-icons/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { AssetTable, AssetThumbnail } from "@/components/visualization/asset-table";
import { ImageInspector } from "@/components/visualization/image-viewer";
import { PageControls, ReadState } from "@/components/visualization/read-state";
import { useVisualizationRead } from "@/components/visualization/visualization-session";
import { visualizationAssetsQuerySchema, type VisualizationAssetsQuery } from "@/lib/validation/visualization";
import { cn } from "@/lib/utils";
import type { ViewerAsset, ViewerPage } from "@/types/visualization";

const inputClass = "mt-1.5 block h-9 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-xs text-zinc-900 outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-zinc-800 dark:bg-[#0b0f17] dark:text-zinc-100";

export function DataTab() {
  const [view, setView] = useState<"grid" | "table">("table");
  const [filters, setFilters] = useState<VisualizationAssetsQuery>(() => visualizationAssetsQuerySchema.parse({}));
  const [search, setSearch] = useState("");
  const [searchError, setSearchError] = useState<string>();
  const [selected, setSelected] = useState<string | null>(null);
  const { page, pageSize, sort, order, modality, q } = filters;
  const { data, error, retry } = useVisualizationRead<ViewerPage<ViewerAsset>>(`/assets?${new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort, order, modality, q })}`);
  const index = data?.items.findIndex(asset => asset.row_id === selected) ?? -1;
  const filtered = Boolean(q) || modality !== "ALL";
  const updateFilters = (patch: Partial<VisualizationAssetsQuery>) => {
    setFilters(current => visualizationAssetsQuerySchema.parse({ ...current, ...patch }));
    setSelected(null);
  };
  const clearFilters = () => {
    setFilters(visualizationAssetsQuerySchema.parse({}));
    setSearch("");
    setSearchError(undefined);
    setSelected(null);
  };

  return <section aria-labelledby="visualization-panel-title" className="min-w-0 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-[#0b0f17]">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <h2 id="visualization-panel-title" className="flex items-center gap-2 text-sm font-semibold"><Table aria-hidden="true" size={17} className="text-zinc-500" />Dataset viewer</h2>
      <div className="flex items-center gap-3">
        <span className="hidden text-[11px] text-zinc-500 sm:inline">Select a record to inspect annotations</span>
        <div className="flex gap-0.5 rounded-md border border-zinc-200 p-0.5 dark:border-zinc-800" role="group" aria-label="Record layout">
          {(["table", "grid"] as const).map(value => {
            const Icon = value === "table" ? Table : SquaresFour;
            return <Button key={value} size="sm" variant="ghost" className={cn("h-7 min-h-7 rounded px-2", view === value && "bg-zinc-100 text-zinc-950 dark:bg-zinc-800 dark:text-white")} aria-pressed={view === value} aria-label={value === "table" ? "Table view" : "Grid view"} onClick={() => setView(value)}><Icon aria-hidden="true" size={15} /></Button>;
          })}
        </div>
      </div>
    </div>

    <div className="grid divide-y divide-zinc-200 bg-zinc-50/50 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:divide-x sm:divide-y-0 dark:divide-zinc-800 dark:bg-zinc-900/30">
      <label className="px-4 py-3 text-[11px] text-zinc-500">Modality
        <select className={inputClass} value={modality} onChange={event => updateFilters({ modality: event.target.value as VisualizationAssetsQuery["modality"], page: 1 })}>
          <option value="ALL">All records</option><option value="IMAGE">Image</option><option value="VIDEO">Video</option><option value="AUDIO">Audio</option><option value="TEXT">Text</option>
        </select>
      </label>
      <div className="flex items-end gap-2 px-4 py-3">
        <label className="min-w-0 flex-1 text-[11px] text-zinc-500">Sort by
          <select className={inputClass} value={sort} onChange={event => updateFilters({ sort: event.target.value as VisualizationAssetsQuery["sort"], page: 1 })}><option value="filename">Filename</option><option value="createdAt">Created date</option></select>
        </label>
        <Button variant="secondary" size="sm" className="h-9 rounded-md px-2.5" aria-label={order === "asc" ? "Sort descending" : "Sort ascending"} title={order === "asc" ? "Ascending; switch to descending" : "Descending; switch to ascending"} onClick={() => updateFilters({ order: order === "asc" ? "desc" : "asc", page: 1 })}>{order === "asc" ? <ArrowUp aria-hidden="true" size={15} /> : <ArrowDown aria-hidden="true" size={15} />}</Button>
      </div>
    </div>

    <form className="border-y border-zinc-200 px-4 py-3 dark:border-zinc-800" onSubmit={event => {
      event.preventDefault();
      const result = visualizationAssetsQuerySchema.safeParse({ ...filters, q: search, page: 1 });
      if (!result.success) { setSearchError("Use at most 100 characters for the filename search."); return; }
      setSearchError(undefined);
      setFilters(result.data);
      setSelected(null);
    }}>
      <label htmlFor="viewer-search" className="sr-only">Search this dataset by filename</label>
      <div className="flex items-center gap-2">
        <MagnifyingGlass aria-hidden="true" size={16} className="shrink-0 text-zinc-400" />
        <input id="viewer-search" type="search" placeholder="Search this dataset by filename" maxLength={100} value={search} onChange={event => setSearch(event.target.value)} aria-invalid={Boolean(searchError)} aria-describedby={searchError ? "viewer-search-error" : undefined} className="h-8 min-w-0 flex-1 rounded bg-transparent px-1 text-sm outline-none placeholder:text-zinc-400 focus-visible:ring-2 focus-visible:ring-sky-500" />
        <Button type="submit" size="sm" variant="secondary" className="h-8 min-h-8 rounded-md">Search</Button>
      </div>
      {searchError && <p id="viewer-search-error" role="alert" className="mt-2 text-xs text-rose-600 dark:text-rose-400">{searchError}</p>}
      {filtered && <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
        {q && <span className="break-all">Filename contains “{q}”</span>}{modality !== "ALL" && <span>{modality.toLowerCase()} records</span>}
        <button type="button" onClick={clearFilters} className="inline-flex min-h-7 items-center gap-1 rounded px-1 text-zinc-700 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-sky-500 dark:text-zinc-300 dark:hover:bg-zinc-800"><X aria-hidden="true" size={12} />Clear filters</button>
      </div>}
    </form>

    {!data ? <ReadState error={error} retry={retry} /> : <>
      {data.items.length === 0 ? <div className="flex min-h-72 flex-col items-center justify-center px-6 py-10 text-center" role="status">
        <Database aria-hidden="true" size={30} weight="duotone" className="text-zinc-400" />
        <h3 className="mt-4 text-sm font-semibold">{page > 1 ? "No records on this page" : filtered ? "No matching records" : "No assets yet"}</h3>
        <p className="mt-2 max-w-xs text-xs leading-5 text-zinc-500">{page > 1 ? "The dataset may have changed. Return to the first page to browse its records." : filtered ? "Try another filename or modality to find records in this dataset." : "This completed dataset has no active records to display."}</p>
        {page > 1 ? <Button variant="secondary" size="sm" className="mt-4" onClick={() => updateFilters({ page: 1 })}>Back to first page</Button> : filtered ? <Button variant="secondary" size="sm" className="mt-4" onClick={clearFilters}>Clear filters</Button> : null}
      </div> : view === "table" ? <AssetTable assets={data.items} sort={sort} order={order} onFilenameSort={() => updateFilters({ sort: "filename", order: sort === "filename" && order === "asc" ? "desc" : "asc", page: 1 })} onInspect={setSelected} /> : <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">{data.items.map(asset => <button key={asset.row_id} type="button" onClick={() => setSelected(asset.row_id)} className="group min-w-0 overflow-hidden rounded-md border border-zinc-200 text-left transition-colors hover:border-sky-400 focus-visible:outline-2 focus-visible:outline-sky-500 dark:border-zinc-800" aria-label={`Inspect ${asset.filename}`}>
        <div className="aspect-[4/3] overflow-hidden bg-zinc-50 [&>div]:h-full [&>div]:rounded-none [&_img]:max-h-48 dark:bg-zinc-900"><AssetThumbnail asset={asset} /></div>
        <div className="p-3"><span className="block truncate text-xs font-medium">{asset.filename}</span><span className="mt-1 block font-mono text-[10px] text-zinc-500">{asset.modality.toLowerCase()} · {asset.width && asset.height ? `${asset.width} × ${asset.height} px` : "Dimensions unavailable"}</span></div>
      </button>)}</div>}
      <PageControls {...data} onPage={value => updateFilters({ page: value })} />
    </>}

    {selected && <ImageInspector assetId={selected} close={() => setSelected(null)} previous={index > 0 ? () => setSelected(data!.items[index - 1].row_id) : undefined} next={data && index >= 0 && index + 1 < data.items.length ? () => setSelected(data.items[index + 1].row_id) : undefined} />}
  </section>;
}
