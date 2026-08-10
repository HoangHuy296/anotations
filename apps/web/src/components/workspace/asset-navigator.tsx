"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import type { AssetStatus } from "@internal/db";

import type { SafeWorkspaceAsset } from "@/types/image-workspace";

/**
 * Shared asset list/pagination control. Used by every engine's
 * PropertiesPanel "Assets" tab content (`SafeWorkspaceAsset` already carries
 * `modality`, so this component itself never branches on engine).
 */
export function AssetNavigator({ datasetId, assets, page, pageSize, totalAssets, search, statuses, selectedAssetId, onNavigate }: { datasetId: string; assets: SafeWorkspaceAsset[]; page: number; pageSize: number; totalAssets: number; search: string; statuses: AssetStatus[]; selectedAssetId: string | null; onNavigate: (event: MouseEvent<HTMLAnchorElement>, href: string) => void | Promise<void> }) {
  const href = (nextPage: number, assetId?: string) => {
    const params = new URLSearchParams({ page: String(nextPage) });
    if (search) params.set("q", search);
    for (const status of statuses) params.append("status", status);
    if (assetId) params.set("image", assetId);
    return `/workspace/${datasetId}?${params.toString()}`;
  };
  return <div className="mt-3"><div className="space-y-1">{assets.map((asset) => { const assetHref = href(page, asset.id); return <Link key={asset.id} href={assetHref} onClick={(event) => { void onNavigate(event, assetHref); }} className={`flex items-center justify-between gap-2 rounded-lg px-2 py-2 text-xs ${asset.id === selectedAssetId ? "bg-sky-50 font-semibold text-sky-800" : "text-zinc-700 hover:bg-zinc-50"}`}><span className="min-w-0 truncate">{asset.filename}</span><span className="shrink-0 font-mono text-[10px] text-zinc-400">{asset.modality}</span></Link>; })}</div><div className="mt-3 flex items-center justify-between gap-2 border-t border-zinc-100 pt-3"><span className="text-[11px] text-zinc-400">{totalAssets === 0 ? "0 assets" : `${Math.min((page - 1) * pageSize + 1, totalAssets)}–${Math.min(page * pageSize, totalAssets)} of ${totalAssets}`}</span><span className="flex gap-1"><PageButton href={href(page - 1)} disabled={page <= 1} label="Previous" onNavigate={onNavigate} /><PageButton href={href(page + 1)} disabled={page * pageSize >= totalAssets} label="Next" onNavigate={onNavigate} /></span></div></div>;
}

function PageButton({ href, disabled, label, onNavigate }: { href: string; disabled: boolean; label: string; onNavigate: (event: MouseEvent<HTMLAnchorElement>, href: string) => void | Promise<void> }) {
  return disabled ? <span className="rounded-md border border-zinc-200 px-2 py-1 text-[10px] text-zinc-300">{label}</span> : <Link href={href} onClick={(event) => { void onNavigate(event, href); }} className="rounded-md border border-zinc-200 px-2 py-1 text-[10px] font-semibold text-zinc-600 hover:bg-zinc-50">{label}</Link>;
}
