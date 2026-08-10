"use client";

import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import type { AssetStatus } from "@internal/db";

import { AssetNavigator } from "@/components/workspace/asset-navigator";
import { useAnnotationStore } from "@/stores/image-annotation-store";
import { flushVideoAutosaves } from "@/lib/workspace/video-autosave";
import type { SafeWorkspaceAsset } from "@/types/image-workspace";
import type { WorkspaceSelection } from "@/types/workspace";

export type PlaceholderPropertiesTabsProps = {
  datasetId: string;
  selection: Extract<WorkspaceSelection, { engine: "VIDEO" | "AUDIO" | "TEXT" }>;
  images: SafeWorkspaceAsset[];
  page: number;
  pageSize: number;
  totalAssets: number;
  completedAssets: number;
  search: string;
  statuses: AssetStatus[];
  selectedAssetId: string | null;
};

const tabLabelsByEngine: Record<"VIDEO" | "AUDIO" | "TEXT", string[]> = {
  VIDEO: ["Video Details", "Tracks", "Labels", "Shapes", "Properties", "Assets"],
  AUDIO: ["Audio Details", "Labels", "Segments", "Properties"],
  TEXT: ["Text Details", "Labels", "Annotations"],
};

/**
 * VIDEO/AUDIO/TEXT's `PropertiesPanel` tabs content until spec User Story 8
 * (VIDEO) and future phases (AUDIO/TEXT) fill in real per-engine content.
 * Asset navigation is kept always-visible rather than gated behind a tab, so
 * this placeholder never regresses the asset-switching capability the prior
 * generic "select an image" fallback offered for any non-image selection.
 */
export function PlaceholderPropertiesTabs({ datasetId, selection, images, page, pageSize, totalAssets, completedAssets, search, statuses, selectedAssetId }: PlaceholderPropertiesTabsProps) {
  const router = useRouter();
  const flushAllAutosaves = useAnnotationStore((store) => store.flushAllAutosaves);
  const tabLabels = tabLabelsByEngine[selection.engine];

  async function guardNavigation(event: MouseEvent<HTMLAnchorElement>, href: string) {
    event.preventDefault();
    await flushAllAutosaves();
    await flushVideoAutosaves();
    router.push(href);
  }

  return <aside className="min-h-0 overflow-y-auto border-l border-zinc-200 bg-white p-4">
    <h2 className="text-sm font-bold text-zinc-950">{selection.engine === "VIDEO" ? "Video" : selection.engine === "AUDIO" ? "Audio" : "Text"} details</h2>
    <p className="mt-1 break-all text-xs font-semibold text-zinc-800">{selection.asset.filename}</p>
    <nav aria-label={`${selection.engine} panel tabs`} className="mt-4 flex flex-wrap gap-1.5">
      {tabLabels.map((label) => <span key={label} className="rounded-lg border border-zinc-100 px-2 py-1.5 text-[11px] font-medium text-zinc-300" title="Not yet available in this phase">{label}</span>)}
    </nav>
    <p className="mt-2 text-[11px] leading-5 text-zinc-400">This modality&apos;s panel content is not yet implemented; asset navigation stays available below.</p>
    <div className="mt-4 border-t border-zinc-100 pt-3">
      <h3 className="text-xs font-bold text-zinc-950">Assets</h3>
      <AssetNavigator datasetId={datasetId} assets={images} page={page} pageSize={pageSize} totalAssets={totalAssets} search={search} statuses={statuses} selectedAssetId={selectedAssetId} onNavigate={guardNavigation} />
      <p className="mt-3 text-[11px] text-zinc-400">Dataset progress: {completedAssets} / {totalAssets}</p>
    </div>
  </aside>;
}
