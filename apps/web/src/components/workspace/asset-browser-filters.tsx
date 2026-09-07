"use client";

import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import type { AssetStatus, Modality } from "@internal/db";

import { imageStatusOptions, imageStatusPresentation } from "@/lib/image-status";

const MODALITIES: Modality[] = ["IMAGE", "VIDEO", "AUDIO", "TEXT"] as Modality[];

export type AssetBrowserFiltersProps = {
  datasetId: string;
  search: string;
  statuses: AssetStatus[];
  filterModality?: Modality;
  /** Runs before navigating away (autosave flush etc.); navigation is skipped if it resolves false. */
  beforeNavigate: () => Promise<boolean>;
};

/**
 * Shared Assets-tab controls. This deliberately keeps the established
 * search/status form intact and adds only the modality filter.
 */
export function AssetBrowserFilters({ datasetId, search, statuses, filterModality, beforeNavigate }: AssetBrowserFiltersProps) {
  const router = useRouter();

  async function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // React clears `currentTarget` once the synchronous handler exits; capture
    // the form before awaiting the flush, mirroring the pre-022 handlers.
    const formElement = event.currentTarget;
    if (!(await beforeNavigate())) return;
    const form = new FormData(formElement);
    const params = new URLSearchParams({ page: "1" });
    const nextSearch = String(form.get("q") ?? "").trim();
    if (nextSearch) params.set("q", nextSearch);
    const nextStatus = String(form.get("status") ?? "ALL");
    if (nextStatus === "MULTIPLE") { for (const status of statuses) params.append("status", status); }
    else if (imageStatusOptions.includes(nextStatus as AssetStatus)) params.set("status", nextStatus);
    const nextModality = String(form.get("filterModality") ?? "");
    if (nextModality) params.set("filterModality", nextModality);
    router.push(`/workspace/${datasetId}?${params.toString()}`);
  }

  const selectedStatus = statuses.length === 1 ? statuses[0] : statuses.length > 1 ? "MULTIPLE" : "ALL";

  return <form method="get" onSubmit={(event) => { void applyFilters(event); }} className="mt-3 space-y-2">
    <label className="sr-only" htmlFor="workspace-asset-search">Search assets</label>
    <input id="workspace-asset-search" name="q" type="search" defaultValue={search} placeholder="Search assets" className="w-full rounded-lg border border-zinc-200 px-2 py-2 text-xs outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100" />
    <div className="grid grid-cols-2 gap-2">
      <label className="sr-only" htmlFor="workspace-asset-status">Filter by status</label>
      <select id="workspace-asset-status" name="status" defaultValue={selectedStatus} className="min-w-0 rounded-lg border border-zinc-200 bg-white px-2 py-2 text-xs text-zinc-700">
        <option value="ALL">All statuses</option>
        {statuses.length > 1 && <option value="MULTIPLE">Keep multiple status filters</option>}
        {imageStatusOptions.map((option) => <option key={option} value={option}>{imageStatusPresentation[option].label}</option>)}
      </select>
      <label className="sr-only" htmlFor="workspace-asset-modality">Filter by modality</label>
      <select id="workspace-asset-modality" name="filterModality" defaultValue={filterModality ?? ""} className="min-w-0 rounded-lg border border-zinc-200 bg-white px-2 py-2 text-xs text-zinc-700">
        <option value="">All modalities</option>
        {MODALITIES.map((modality) => <option key={modality} value={modality}>{modality[0]}{modality.slice(1).toLowerCase()}</option>)}
      </select>
    </div>
    <button type="submit" className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-semibold text-white hover:bg-zinc-800">Apply</button>
  </form>;
}
