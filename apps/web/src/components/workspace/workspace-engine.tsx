"use client";

import { UnresolvedDatasetWorkspace } from "@/components/workspace/unresolved-dataset-workspace";
import { workspaceEngineRegistry } from "@/lib/workspace/workspace-engine-registry";
import type { WorkspaceDataset, WorkspaceSelection } from "@/types/workspace";

type WorkspaceEngineProps = {
  dataset: WorkspaceDataset;
  selection: WorkspaceSelection | null;
};

/** The authorized Dataset chooses the engine; the Asset supplies its content. */
export function WorkspaceEngine({ dataset, selection }: WorkspaceEngineProps) {
  if (dataset.modality === null) return <UnresolvedDatasetWorkspace key={dataset.id} dataset={dataset} />;
  if (selection && (selection.engine !== dataset.modality || selection.asset.modality !== dataset.modality)) {
    return <section role="alert" className="canvas-grid grid min-h-[520px] min-w-0 place-items-center bg-zinc-950 px-6 text-center lg:min-h-0"><div><p className="text-sm font-semibold text-zinc-200">Selected asset is incompatible with this dataset</p><p className="mt-2 text-xs text-zinc-400">Refresh the workspace to load a valid selection.</p></div></section>;
  }
  const { Component } = workspaceEngineRegistry[dataset.modality];
  // Stable across selected-Asset changes; a different Dataset resets its boundary.
  return <div key={dataset.id} data-workspace-engine={dataset.modality} data-workspace-dataset={dataset.id} className="grid min-h-0 min-w-0"><Component selection={selection} /></div>;
}
