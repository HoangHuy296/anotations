import { workspaceEngineRegistry } from "@/lib/workspace/workspace-engine-registry";
import type { WorkspaceSelection } from "@/types/workspace";

type WorkspaceEngineProps = {
  selection: WorkspaceSelection | null;
};

/**
 * A single workspace route delegates rendering to the selected asset's
 * modality. This is the only component allowed to switch on
 * `asset.modality`/`selection.engine` (spec FR-032, FR-041–FR-044) — it does
 * so via one lookup into `workspaceEngineRegistry`, not an inline `switch`.
 */
export function WorkspaceEngine({ selection }: WorkspaceEngineProps) {
  if (!selection) return <section className="canvas-grid grid min-h-[520px] min-w-0 place-items-center bg-zinc-900 px-6 text-center lg:min-h-0"><div><p className="text-sm font-semibold text-zinc-300">No asset selected</p><p className="mt-1 text-xs leading-5 text-zinc-500">Choose an asset from the paginated list to open its workspace.</p></div></section>;
  const { Component } = workspaceEngineRegistry[selection.engine];
  return <Component selection={selection} />;
}
