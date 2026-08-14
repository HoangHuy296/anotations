"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AssetStatus } from "@internal/db";

import { AssetNavigator } from "@/components/workspace/asset-navigator";
import { useAnnotationStore } from "@/stores/image-annotation-store";
import { flushVideoAutosaves } from "@/lib/workspace/video-autosave";
import { workspaceEngineRegistry } from "@/lib/workspace/workspace-engine-registry";
import type { SafeWorkspaceAsset } from "@/types/workspace";
import type { WorkspaceSelection } from "@/types/workspace";

type PropertiesPanelProps = {
  datasetId: string;
  selection: WorkspaceSelection | null;
  /** Shared, modality-neutral list for the Assets tab. */
  assets: SafeWorkspaceAsset[];
  page: number;
  pageSize: number;
  totalAssets: number;
  completedAssets: number;
  search: string;
  statuses: AssetStatus[];
  selectedAssetId: string | null;
};

/**
 * One shared `PropertiesPanel`. Its tab content is sourced from
 * `workspaceEngineRegistry` (spec FR-036, FR-041–FR-044) — this component
 * does not itself branch on modality beyond that one lookup. Tab selection
 * state stays mounted across re-renders of the same asset; switching assets
 * remounts asset-specific editor state via `key`.
 */
export function PropertiesPanel(props: PropertiesPanelProps) {
  const [tab, setTab] = useState("description");
  const remountKey = props.selection ? `${props.selection.engine}:${props.selection.asset.id}` : (props.selectedAssetId ?? "none");
  return <PropertiesPanelShell key={remountKey} {...props} tab={tab} setTab={setTab} />;
}

function PropertiesPanelShell({ datasetId, selection, assets, page, pageSize, totalAssets, completedAssets, search, statuses, selectedAssetId, tab, setTab }: PropertiesPanelProps & { tab: string; setTab: (tab: string) => void }) {
  const router = useRouter();
  const flushAllAutosaves = useAnnotationStore((store) => store.flushAllAutosaves);

  if (!selection) {
    return <aside className="min-h-0 overflow-y-auto border-l border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-bold text-zinc-950">Assets</h2>
      <p className="mt-1 text-xs leading-5 text-zinc-500">Select an asset from the list to open its details.</p>
      <AssetNavigator datasetId={datasetId} assets={assets} page={page} pageSize={pageSize} totalAssets={totalAssets} search={search} statuses={statuses} selectedAssetId={selectedAssetId} onNavigate={async (event, href) => {
        event.preventDefault();
        await flushAllAutosaves();
        await flushVideoAutosaves();
        router.push(href);
      }} />
    </aside>;
  }

  const { Tabs } = workspaceEngineRegistry[selection.engine];
  return <Tabs datasetId={datasetId} selection={selection} assets={assets} page={page} pageSize={pageSize} totalAssets={totalAssets} completedAssets={completedAssets} search={search} statuses={statuses} selectedAssetId={selectedAssetId} tab={tab} setTab={setTab} />;
}
