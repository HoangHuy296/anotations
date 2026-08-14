"use client";

import dynamic from "next/dynamic";

import { AiDetectDialog } from "@/components/workspace/ai-detect-dialog";
import { getAssetAnnotations } from "@/lib/annotations/annotation-api-client";
import type { SafeAnnotation } from "@/lib/annotations/safe-annotation";
import { predictionsForTask } from "@/lib/ai/ai-detect-view";
import type { SafeImageAnnotation, SafeImageWorkspaceAsset, SafeReadOnlyImageAnnotation, SafeWorkspaceLabel } from "@/types/image-workspace";
import { useAnnotationStore } from "@/stores/image-annotation-store";

const CanvasStage = dynamic(() => import("@/components/workspace/canvas-stage"), { ssr: false, loading: () => <section className="canvas-grid grid min-h-[520px] min-w-0 place-items-center bg-zinc-900 lg:min-h-0"><div className="h-2 w-40 animate-pulse rounded-full bg-zinc-700" /></section> });

const IMAGE_ANNOTATION_TYPES = new Set(["BOUNDING_BOX", "POLYGON", "CIRCLE", "POINT", "POLYLINE"]);

// Mirrors canvas-stage.tsx's own (unexported) `toCanvasAnnotation` -- kept as
// a separate small copy rather than a shared import so this file never
// statically pulls in canvas-stage.tsx's react-konva dependency chain, which
// only ever loads through the `dynamic(..., { ssr: false })` boundary above.
function toImageAnnotation(annotation: SafeAnnotation): SafeImageAnnotation | null {
  if (annotation.modality !== "IMAGE" || !IMAGE_ANNOTATION_TYPES.has(annotation.type)) return null;
  return { ...annotation, modality: "IMAGE", type: annotation.type as SafeImageAnnotation["type"], geometry: annotation.geometry as SafeImageAnnotation["geometry"] };
}

type ImageEngineProps = {
  image: SafeImageWorkspaceAsset | null;
  annotations: SafeImageAnnotation[];
  unsupportedAnnotations: SafeReadOnlyImageAnnotation[];
  labels: SafeWorkspaceLabel[];
};

export function ImageEngine({ image, annotations, unsupportedAnnotations, labels }: ImageEngineProps) {
  const tool = useAnnotationStore((store) => store.tool);
  const setTool = useAnnotationStore((store) => store.setTool);
  const upsertSafeAnnotation = useAnnotationStore((store) => store.upsertSafeAnnotation);
  if (!image) return <section className="canvas-grid grid min-h-[520px] min-w-0 place-items-center bg-zinc-900 px-6 text-center lg:min-h-0"><div><p className="text-sm font-semibold text-zinc-300">No image selected</p><p className="mt-1 text-xs leading-5 text-zinc-500">Adjust the sidebar filters or import images into this dataset.</p></div></section>;

  // A `const` alias so the null-check above narrows into `applyAiResults`
  // below -- `image` itself is a plain parameter binding, which TS does not
  // treat as narrowed inside a nested closure.
  const currentImage = image;

  // Engine-owned: a completed AI task only ever produces ordinary
  // Annotation rows (source: AI, status: DRAFT -- ai-prediction-writer.ts),
  // so applying its results is exactly "reload this asset's annotations and
  // merge in the ones this task produced" through the same store every
  // manual edit already goes through. AiDetectDialog itself never touches
  // this store or knows what an annotation is.
  async function applyAiResults(taskId: string): Promise<number> {
    const result = await getAssetAnnotations(currentImage.id);
    if (!result.ok) return 0;
    const applied = predictionsForTask(result.annotations.map(toImageAnnotation).filter((item): item is SafeImageAnnotation => item !== null), taskId);
    for (const annotation of applied) upsertSafeAnnotation(annotation);
    return applied.length;
  }

  return <>
    <CanvasStage key={`canvas-${currentImage.id}`} image={currentImage} annotations={annotations} unsupportedAnnotations={unsupportedAnnotations} labels={labels} tool={tool} onToolChange={setTool} />
    {tool === "aidetect" && <AiDetectDialog key={`ai-detect-${currentImage.id}`} assetId={currentImage.id} modality={currentImage.modality} onClose={() => setTool("select")} onCompleted={applyAiResults} />}
  </>;
}
