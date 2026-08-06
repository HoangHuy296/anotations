import { AnnotationCanvas } from "@/components/workspace/annotation-canvas";
import { AudioEngine } from "@/components/workspace/audio-engine";
import { TextEngine } from "@/components/workspace/text-engine";
import { VideoEngine } from "@/components/workspace/video-engine";
import type { WorkspaceSelection } from "@/types/workspace";

type WorkspaceEngineProps = {
  selection: WorkspaceSelection | null;
};

/** A single workspace route delegates rendering to the selected asset's modality. */
export function WorkspaceEngine({ selection }: WorkspaceEngineProps) {
  if (!selection) return <section className="canvas-grid grid min-h-[520px] min-w-0 place-items-center bg-zinc-900 px-6 text-center lg:min-h-0"><div><p className="text-sm font-semibold text-zinc-300">No asset selected</p><p className="mt-1 text-xs leading-5 text-zinc-500">Choose an asset from the paginated list to open its workspace.</p></div></section>;
  switch (selection.engine) {
    case "IMAGE": return <AnnotationCanvas image={selection.asset} annotations={selection.annotations} unsupportedAnnotations={selection.unsupportedAnnotations} labels={selection.labels} />;
    case "VIDEO": return <VideoEngine key={selection.asset.id} asset={selection.asset} readiness={selection.readiness} annotations={selection.annotations} />;
    case "AUDIO": return <AudioEngine key={selection.asset.id} asset={selection.asset} readiness={selection.readiness} />;
    case "TEXT": return <TextEngine key={selection.asset.id} asset={selection.asset} />;
  }
}
