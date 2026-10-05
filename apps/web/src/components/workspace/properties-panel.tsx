"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AssetStatus, Modality } from "@internal/db";

import { AssetNavigator, type AssetNavigatorFilters } from "@/components/workspace/asset-navigator";
import { workspaceEngineRegistry } from "@/lib/workspace/workspace-engine-registry";
import type { SafeWorkspaceAsset } from "@/types/workspace";
import type { WorkspaceSelection } from "@/types/workspace";

type PropertiesPanelProps = {
  datasetId: string;
  engine: Modality;
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
  /** Active Asset Browser filters/sort (022). */
  filters: AssetNavigatorFilters;
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
  const remountKey = `${props.datasetId}:${props.selection?.asset.id ?? "none"}`;
  return <PropertiesPanelShell key={remountKey} {...props} tab={tab} setTab={setTab} />;
}

function PropertiesPanelShell({ datasetId, engine, selection, assets, page, pageSize, totalAssets, completedAssets, search, statuses, selectedAssetId, filters, tab, setTab }: PropertiesPanelProps & { tab: string; setTab: (tab: string) => void }) {
  const router = useRouter();

  if (selection && selection.engine !== engine) {
    return <aside role="alert" className="border-l border-zinc-200 bg-white p-4 text-sm">Asset details are incompatible with this Dataset. Reload the workspace.</aside>;
  }

  if (!selection) {
    return <aside className="min-h-0 overflow-y-auto border-l border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-bold text-zinc-950">Assets</h2>
      <p className="mt-1 text-xs leading-5 text-zinc-500">Select an asset from the list to open its details.</p>
      <AssetNavigator datasetId={datasetId} assets={assets} page={page} pageSize={pageSize} totalAssets={totalAssets} search={search} statuses={statuses} selectedAssetId={selectedAssetId} filters={filters} onNavigate={async (event, href) => {
        event.preventDefault();
        router.push(href);
      }} />
    </aside>;
  }

  const { Tabs } = workspaceEngineRegistry[engine];
  return <Tabs datasetId={datasetId} selection={selection} assets={assets} page={page} pageSize={pageSize} totalAssets={totalAssets} completedAssets={completedAssets} search={search} statuses={statuses} selectedAssetId={selectedAssetId} filters={filters} tab={tab} setTab={setTab} />;
}
