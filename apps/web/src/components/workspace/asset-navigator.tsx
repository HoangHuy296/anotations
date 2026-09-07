"use client";

import Link from "next/link";
import { useEffect } from "react";
import type { MouseEvent } from "react";
import type { AssetStatus, Modality } from "@internal/db";

import { useAssetSelectionStore } from "@/stores/asset-selection-store";
import type { AssetListOrder, AssetListQuery, AssetListSort, SafeWorkspaceAsset } from "@/types/workspace";

export type AssetNavigatorFilters = {
  filterModality?: Modality;
  labelId?: string[];
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  sort?: AssetListSort;
  order?: AssetListOrder;
};

/** The active search/filter query, excluding sort/order/pagination -- what a `FILTERED` selection actually matches (FR-013). */
function buildQuery(search: string, statuses: AssetStatus[], filters?: AssetNavigatorFilters): AssetListQuery {
  return {
    q: search || undefined,
    status: statuses.length ? statuses : undefined,
    modality: filters?.filterModality,
    labelId: filters?.labelId?.length ? filters.labelId : undefined,
    createdFrom: filters?.createdFrom,
    createdTo: filters?.createdTo,
    updatedFrom: filters?.updatedFrom,
    updatedTo: filters?.updatedTo,
  };
}

/**
 * Shared asset list/pagination/selection control. Used by every engine's
 * PropertiesPanel "Assets" tab content (`SafeWorkspaceAsset` already carries
 * `modality`, so this component itself never branches on engine). Selection
 * (022) is independent of pagination -- it lives in `useAssetSelectionStore`,
 * not in this component's own state, so it survives Previous/Next.
 */
export function AssetNavigator({ datasetId, assets, page, pageSize, totalAssets, search, statuses, selectedAssetId, onNavigate, filters }: { datasetId: string; assets: SafeWorkspaceAsset[]; page: number; pageSize: number; totalAssets: number; search: string; statuses: AssetStatus[]; selectedAssetId: string | null; onNavigate: (event: MouseEvent<HTMLAnchorElement>, href: string) => void | Promise<void>; filters?: AssetNavigatorFilters }) {
  const query = buildQuery(search, statuses, filters);
  const mode = useAssetSelectionStore((state) => state.mode);
  const storeDatasetId = useAssetSelectionStore((state) => state.datasetId);
  const selectedCount = useAssetSelectionStore((state) => state.selectedCount());
  const isSelected = useAssetSelectionStore((state) => state.isSelected);
  const toggle = useAssetSelectionStore((state) => state.toggle);
  const selectVisible = useAssetSelectionStore((state) => state.selectVisible);
  const selectAllFiltered = useAssetSelectionStore((state) => state.selectAllFiltered);
  const clear = useAssetSelectionStore((state) => state.clear);
  const reconcile = useAssetSelectionStore((state) => state.reconcile);

  // FR-013: whenever the active query changes (and we're already in a
  // FILTERED selection for this dataset), re-represent it and refresh the
  // displayed count -- declaratively, on every render of a new query, so
  // there's never a stale copy to fall out of sync.
  const queryKey = JSON.stringify(query);
  useEffect(() => { reconcile(datasetId, query, totalAssets); }, [datasetId, queryKey, totalAssets, reconcile]); // eslint-disable-line react-hooks/exhaustive-deps -- `query` is derived fresh every render; `queryKey` is its stable dependency.

  const activeForDataset = storeDatasetId === datasetId;
  const visibleIds = assets.map((asset) => asset.id);
  const allVisibleSelected = activeForDataset && mode === "EXPLICIT" && visibleIds.length > 0 && visibleIds.every((id) => isSelected(id));

  // The selection query key must match the target's own modality (`?image=`,
  // `?video=`, `?audio=`, `?text=`) -- readWorkspacePage cross-checks id and
  // modality together, so a mismatched pairing (e.g. every asset routed
  // through `?image=`) fails to resolve instead of opening the asset.
  //
  // Every active Asset Browser filter/sort (022) is carried along on every
  // Previous/Next/asset link, so paging or opening an asset never silently
  // drops the user's active query (FR-005: sorting/filtering must work
  // together with pagination).
  const href = (nextPage: number, asset?: Pick<SafeWorkspaceAsset, "id" | "modality">) => {
    const params = new URLSearchParams({ page: String(nextPage) });
    if (search) params.set("q", search);
    for (const status of statuses) params.append("status", status);
    if (filters?.filterModality) params.set("filterModality", filters.filterModality);
    for (const label of filters?.labelId ?? []) params.append("labelId", label);
    if (filters?.createdFrom) params.set("createdFrom", filters.createdFrom);
    if (filters?.createdTo) params.set("createdTo", filters.createdTo);
    if (filters?.updatedFrom) params.set("updatedFrom", filters.updatedFrom);
    if (filters?.updatedTo) params.set("updatedTo", filters.updatedTo);
    if (filters?.sort) { params.set("sort", filters.sort); params.set("order", filters.order ?? "desc"); }
    if (asset) params.set(asset.modality.toLowerCase(), asset.id);
    return `/workspace/${datasetId}?${params.toString()}`;
  };
  return <div className="mt-3">
    {assets.length > 0 && <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
      <label className="flex items-center gap-1.5 font-semibold text-zinc-600"><input type="checkbox" checked={allVisibleSelected} onChange={() => selectVisible(datasetId, visibleIds)} />Select visible</label>
      {totalAssets > visibleIds.length && <button type="button" onClick={() => selectAllFiltered(datasetId, query, totalAssets)} className="font-semibold text-sky-700 hover:text-sky-800">Select all {totalAssets.toLocaleString()} filtered</button>}
      {activeForDataset && mode !== "NONE" && <>
        <span className="text-zinc-400">·</span>
        <span className="font-semibold text-zinc-700">{mode === "FILTERED" ? `All ${selectedCount.toLocaleString()} matching selected` : `${selectedCount.toLocaleString()} selected`}</span>
        <button type="button" onClick={clear} className="text-zinc-500 hover:text-zinc-700">Clear</button>
      </>}
    </div>}
    {assets.length === 0
      ? <p role="status" className="rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-center text-xs text-zinc-500">No assets match the current search and filters.</p>
      : <div className="space-y-1">{assets.map((asset) => {
        const assetHref = href(page, asset);
        const checked = mode === "EXPLICIT" && activeForDataset && isSelected(asset.id);
        return <div key={asset.id} className={`flex items-center gap-1.5 rounded-lg ${asset.id === selectedAssetId ? "bg-sky-50" : ""}`}>
          <input type="checkbox" checked={checked} onChange={() => toggle(datasetId, asset.id)} onClick={(event) => event.stopPropagation()} aria-label={`Select ${asset.filename}`} className="ml-2 shrink-0" />
          <Link href={assetHref} onClick={(event) => { void onNavigate(event, assetHref); }} className={`flex min-w-0 flex-1 items-center justify-between gap-2 px-1 py-2 text-xs ${asset.id === selectedAssetId ? "font-semibold text-sky-800" : "text-zinc-700 hover:bg-zinc-50"}`}><span className="min-w-0 truncate">{asset.filename}</span><span className="shrink-0 font-mono text-[10px] text-zinc-400">{asset.modality}</span></Link>
        </div>;
      })}</div>}
    <div className="mt-3 flex items-center justify-between gap-2 border-t border-zinc-100 pt-3"><span className="text-[11px] text-zinc-400">{totalAssets === 0 ? "0 assets" : `${Math.min((page - 1) * pageSize + 1, totalAssets)}–${Math.min(page * pageSize, totalAssets)} of ${totalAssets}`}</span><span className="flex gap-1"><PageButton href={href(page - 1)} disabled={page <= 1} label="Previous" onNavigate={onNavigate} /><PageButton href={href(page + 1)} disabled={page * pageSize >= totalAssets} label="Next" onNavigate={onNavigate} /></span></div>
  </div>;
}

function PageButton({ href, disabled, label, onNavigate }: { href: string; disabled: boolean; label: string; onNavigate: (event: MouseEvent<HTMLAnchorElement>, href: string) => void | Promise<void> }) {
  return disabled ? <span className="rounded-md border border-zinc-200 px-2 py-1 text-[10px] text-zinc-300">{label}</span> : <Link href={href} onClick={(event) => { void onNavigate(event, href); }} className="rounded-md border border-zinc-200 px-2 py-1 text-[10px] font-semibold text-zinc-600 hover:bg-zinc-50">{label}</Link>;
}
