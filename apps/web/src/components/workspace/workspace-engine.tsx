import { AnnotationCanvas } from "@/components/workspace/annotation-canvas";
import type {
  SafeImageAnnotation,
  SafeImageWorkspaceAsset,
  SafeWorkspaceAsset,
  SafeWorkspaceLabel,
} from "@/types/image-workspace";

type WorkspaceEngineProps = {
  datasetId: string;
  asset: SafeWorkspaceAsset | null;
  image: SafeImageWorkspaceAsset | null;
  annotations: SafeImageAnnotation[];
  labels: SafeWorkspaceLabel[];
};

/** A single workspace route delegates rendering to the selected asset's modality. */
export function WorkspaceEngine({ datasetId, asset, image, annotations, labels }: WorkspaceEngineProps) {
  if (!asset) return <section className="canvas-grid grid min-h-[520px] min-w-0 place-items-center bg-zinc-900 px-6 text-center lg:min-h-0"><div><p className="text-sm font-semibold text-zinc-300">No asset selected</p><p className="mt-1 text-xs leading-5 text-zinc-500">Choose an asset from the paginated list to open its workspace.</p></div></section>;
  if (asset.modality !== "IMAGE") return <section className="canvas-grid grid min-h-[520px] min-w-0 place-items-center bg-zinc-900 px-6 text-center lg:min-h-0"><div className="max-w-sm"><p className="text-sm font-semibold text-zinc-200">{asset.modality.toLowerCase()} workspace is not available yet</p><p className="mt-1 text-xs leading-5 text-zinc-500">This asset remains selectable because <code className="font-mono text-zinc-400">Asset.modality</code> chooses the workspace engine. Image annotation is the currently available engine.</p></div></section>;
  return <AnnotationCanvas datasetId={datasetId} image={image} annotations={annotations} labels={labels} />;
}
