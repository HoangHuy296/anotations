"use client";

import dynamic from "next/dynamic";

import type { SafeImageAnnotation, SafeImageWorkspaceAsset, SafeReadOnlyImageAnnotation, SafeWorkspaceLabel } from "@/types/image-workspace";
import { useAnnotationStore } from "@/stores/image-annotation-store";

const CanvasStage = dynamic(() => import("@/components/workspace/canvas-stage"), { ssr: false, loading: () => <section className="canvas-grid grid min-h-[520px] min-w-0 place-items-center bg-zinc-900 lg:min-h-0"><div className="h-2 w-40 animate-pulse rounded-full bg-zinc-700" /></section> });

type ImageEngineProps = {
  image: SafeImageWorkspaceAsset | null;
  annotations: SafeImageAnnotation[];
  unsupportedAnnotations: SafeReadOnlyImageAnnotation[];
  labels: SafeWorkspaceLabel[];
};

export function ImageEngine({ image, annotations, unsupportedAnnotations, labels }: ImageEngineProps) {
  const tool = useAnnotationStore((store) => store.tool);
  const setTool = useAnnotationStore((store) => store.setTool);
  if (!image) return <section className="canvas-grid grid min-h-[520px] min-w-0 place-items-center bg-zinc-900 px-6 text-center lg:min-h-0"><div><p className="text-sm font-semibold text-zinc-300">No image selected</p><p className="mt-1 text-xs leading-5 text-zinc-500">Adjust the sidebar filters or import images into this dataset.</p></div></section>;
  return <CanvasStage key={image.id} image={image} annotations={annotations} unsupportedAnnotations={unsupportedAnnotations} labels={labels} tool={tool} onToolChange={setTool} />;
}
