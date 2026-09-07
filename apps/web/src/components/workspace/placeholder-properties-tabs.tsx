"use client";

import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import type { AssetStatus } from "@internal/db";

import { AssetNavigator, type AssetNavigatorFilters } from "@/components/workspace/asset-navigator";
import { useAnnotationStore } from "@/stores/image-annotation-store";
import { flushVideoAutosaves } from "@/lib/workspace/video-autosave";
import { WorkflowHistoryPanel } from "@/components/workspace/workflow-history-panel";
import type { SafeWorkspaceAsset } from "@/types/workspace";
import type { WorkspaceSelection } from "@/types/workspace";

export type PlaceholderPropertiesTabsProps = {
  datasetId: string;
  selection: Extract<WorkspaceSelection, { engine: | "AUDIO" | "TEXT" }>;
  assets: SafeWorkspaceAsset[];
  page: number;
  pageSize: number;
  totalAssets: number;
  completedAssets: number;
  search: string;
  statuses: AssetStatus[];
  selectedAssetId: string | null;
  filters: AssetNavigatorFilters;
};

function formatBytes(sizeBytes: string | null): string {
  if (!sizeBytes) return "Unknown";
  const bytes = Number(sizeBytes);
  if (!Number.isFinite(bytes)) return "Unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined) return "Unknown";
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

const tabLabelsByEngine: Record< "AUDIO" | "TEXT", string[]> = {
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
export function PlaceholderPropertiesTabs({ datasetId, selection, assets, page, pageSize, totalAssets, completedAssets, search, statuses, selectedAssetId, filters }: PlaceholderPropertiesTabsProps) {
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
    <h2 className="text-sm font-bold text-zinc-950">{selection.engine === "AUDIO" ? "AUDIO" : "TEXT"} details</h2>
    <p className="mt-1 break-all text-xs font-semibold text-zinc-800">{selection.asset.filename}</p>
    {/*
      Real per-modality metadata (022 FR-031) -- populated from fields the
      schema already carries (AudioAsset via SafeMediaReadiness.audio,
      TextAsset/base Asset fields via readWorkspaceSelection), not a new
      annotation-editing surface. The disabled sub-tabs below (Segments/
      Properties/Annotations) remain future-phase, untouched.
    */}
    {selection.engine === "AUDIO" && <dl className="mt-4 space-y-2 text-xs">
      <Detail label="Duration" value={formatDuration(selection.readiness.audio?.durationMs)} />
      <Detail label="Sample rate" value={selection.readiness.audio?.sampleRate ? `${selection.readiness.audio.sampleRate} Hz` : "Unknown"} />
      <Detail label="Channels" value={selection.readiness.audio?.channels ? String(selection.readiness.audio.channels) : "Unknown"} />
      <Detail label="Codec" value={selection.readiness.audio?.codec ?? "Unknown"} />
      <Detail label="Bit rate" value={selection.readiness.audio?.bitRate ? `${Math.round(selection.readiness.audio.bitRate / 1000)} kbps` : "Unknown"} />
      <Detail label="Waveform" value={selection.readiness.audio?.waveformReady ? "Ready" : "Not generated"} />
    </dl>}
    {selection.engine === "TEXT" && <dl className="mt-4 space-y-2 text-xs">
      <Detail label="Language" value={selection.asset.language ?? "Unknown"} />
      <Detail label="Length" value={selection.asset.textLength !== null ? `${selection.asset.textLength.toLocaleString()} chars` : "Unknown"} />
      <Detail label="File size" value={formatBytes(selection.asset.sizeBytes)} />
      <Detail label="Format" value={selection.asset.mimeType} />
      <Detail label="Created" value={new Date(selection.asset.createdAt).toLocaleDateString()} />
      <Detail label="Updated" value={new Date(selection.asset.updatedAt).toLocaleDateString()} />
    </dl>}
    <nav aria-label={`${selection.engine} panel tabs`} className="mt-4 flex flex-wrap gap-1.5">
      {tabLabels.map((label) => <span key={label} className="rounded-lg border border-zinc-100 px-2 py-1.5 text-[11px] font-medium text-zinc-300" title="Not yet available in this phase">{label}</span>)}
    </nav>
    <p className="mt-2 text-[11px] leading-5 text-zinc-400">This modality&apos;s annotation panel is not yet implemented; asset navigation and Details stay available.</p>
    <WorkflowHistoryPanel datasetId={datasetId} assetId={selection.asset.id} />
    <div className="mt-4 border-t border-zinc-100 pt-3">
      <h3 className="text-xs font-bold text-zinc-950">Assets</h3>
      <AssetNavigator datasetId={datasetId} assets={assets} page={page} pageSize={pageSize} totalAssets={totalAssets} search={search} statuses={statuses} selectedAssetId={selectedAssetId} filters={filters} onNavigate={guardNavigation} />
      <p className="mt-3 text-[11px] text-zinc-400">Dataset progress: {completedAssets} / {totalAssets}</p>
    </div>
  </aside>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><dt className="text-zinc-400">{label}</dt><dd className="max-w-[150px] truncate font-mono text-zinc-700">{value}</dd></div>;
}
