"use client";

import type Konva from "konva";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image as KonvaImage, Layer, Rect, Stage, Transformer } from "react-konva";

import { createBoundingBoxAction, deleteBoundingBoxAction, updateBoundingBoxGeometryAction } from "@/app/(app)/workspace/[datasetId]/actions";
import { Toolbar } from "@/components/workspace/toolbar";
import { SaveConflictPanel } from "@/components/workspace/save-conflict-panel";
import { normalizeBoundingBox, viewportPointToImage } from "@/lib/workspace/geometry";
import { useAnnotationStore } from "@/stores/annotation-store";
import type { AnnotationTool } from "@/types/annotation";
import type { NormalizedBoundingBox, SafeImageAnnotation, SafeImageWorkspaceAsset, SafeWorkspaceLabel } from "@/types/image-workspace";

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
const FIT_PADDING = 48;
const VIEW_URL_CACHE_MS = 4 * 60 * 1000;
const cachedViewUrls = new Map<string, { url: string; expiresAt: number }>();
const inFlightViewUrls = new Map<string, Promise<string>>();

type CanvasStageProps = {
  datasetId: string;
  image: SafeImageWorkspaceAsset;
  annotations: SafeImageAnnotation[];
  labels: SafeWorkspaceLabel[];
  tool: AnnotationTool;
  onToolChange: (tool: AnnotationTool) => void;
};

function colorFor(annotation: SafeImageAnnotation, labels: SafeWorkspaceLabel[]) {
  return labels.find((label) => label.id === annotation.labelId)?.color ?? "#38bdf8";
}

async function getViewUrl(assetId: string) {
  const cached = cachedViewUrls.get(assetId);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const inFlight = inFlightViewUrls.get(assetId);
  if (inFlight) return inFlight;
  const request = (async () => {
    const response = await fetch(`/api/assets/${assetId}/view-url`, { credentials: "same-origin", cache: "no-store" });
    const payload = await response.json().catch(() => null) as { data?: { viewUrl?: string } } | null;
    if (!response.ok || !payload?.data?.viewUrl) throw new Error("unavailable");
    cachedViewUrls.set(assetId, { url: payload.data.viewUrl, expiresAt: Date.now() + VIEW_URL_CACHE_MS });
    return payload.data.viewUrl;
  })();
  inFlightViewUrls.set(assetId, request);
  try { return await request; } finally { inFlightViewUrls.delete(assetId); }
}

export default function CanvasStage({ datasetId, image: asset, annotations: initialAnnotations, labels, tool, onToolChange }: CanvasStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const selectedNodeRef = useRef<Konva.Rect | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const pendingCreateCounterRef = useRef(0);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error" | "expired">("loading");
  const [zoomPercent, setZoomPercent] = useState(100);
  const annotations = useAnnotationStore((state) => state.persistedAnnotations);
  const selectedId = useAnnotationStore((state) => state.selectedId);
  const setSelectedId = useAnnotationStore((state) => state.setSelectedId);
  const initializePersistedImage = useAnnotationStore((state) => state.initializePersistedImage);
  const upsertSafeAnnotation = useAnnotationStore((state) => state.upsertSafeAnnotation);
  const removeSafeAnnotation = useAnnotationStore((state) => state.removeSafeAnnotation);
  const scheduleAutosave = useAnnotationStore((state) => state.scheduleAutosave);
  const setConflictDraft = useAnnotationStore((state) => state.setConflictDraft);
  const clearConflictDraft = useAnnotationStore((state) => state.clearConflictDraft);
  const [activeLabelId, setActiveLabelId] = useState<string | null>(labels[0]?.id ?? null);
  const [draft, setDraft] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [drawingStart, setDrawingStart] = useState<{ x: number; y: number } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "pending" | "saving" | "saved" | "failed" | "conflict">("idle");
  const [conflictKey, setConflictKey] = useState<string | null>(null);

  const originalWidth = image?.naturalWidth || asset.width || 0;
  const originalHeight = image?.naturalHeight || asset.height || 0;

  const fitImage = useCallback(() => {
    const stage = stageRef.current;
    const loaded = imageRef.current;
    if (!stage || !loaded || !viewport.width || !viewport.height) return;
    const scale = Math.min(Math.max(1, viewport.width - FIT_PADDING * 2) / loaded.naturalWidth, Math.max(1, viewport.height - FIT_PADDING * 2) / loaded.naturalHeight, 1);
    stage.scale({ x: scale, y: scale });
    stage.position({ x: (viewport.width - loaded.naturalWidth * scale) / 2, y: (viewport.height - loaded.naturalHeight * scale) / 2 });
    stage.batchDraw();
    setZoomPercent(Math.round(scale * 100));
  }, [viewport]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setViewport({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) }); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const requestViewUrl = useCallback(async () => {
    setLoadState("loading");
    try {
      const viewUrl = await getViewUrl(asset.id);
      const next = new window.Image();
      next.decoding = "async";
      next.onload = () => { imageRef.current = next; setImage(next); setLoadState("ready"); };
      next.onerror = () => setLoadState("expired");
      next.src = viewUrl;
    } catch { setLoadState("error"); }
  }, [asset.id]);

  useEffect(() => {
    // This effect synchronizes a short-lived external view capability for the
    // current Asset. It is not derived React state and never persists data.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void requestViewUrl();
  }, [requestViewUrl]);
  useEffect(() => { if (image && viewport.width && viewport.height) fitImage(); }, [fitImage, image, viewport]);
  useEffect(() => { transformerRef.current?.nodes(selectedNodeRef.current ? [selectedNodeRef.current] : []); transformerRef.current?.getLayer()?.batchDraw(); }, [selectedId]);
  useEffect(() => { initializePersistedImage(asset.id, initialAnnotations); }, [asset.id, initialAnnotations, initializePersistedImage]);

  const zoomAtCenter = useCallback((multiplier: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const oldScale = stage.scaleX();
    const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * multiplier));
    const center = { x: viewport.width / 2, y: viewport.height / 2 };
    const point = { x: (center.x - stage.x()) / oldScale, y: (center.y - stage.y()) / oldScale };
    stage.scale({ x: nextScale, y: nextScale });
    stage.position({ x: center.x - point.x * nextScale, y: center.y - point.y * nextScale });
    stage.batchDraw(); setZoomPercent(Math.round(nextScale * 100));
  }, [viewport]);

  function pointerInImage() {
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer || !originalWidth || !originalHeight) return null;
    return viewportPointToImage(pointer, { x: stage.x(), y: stage.y(), scale: stage.scaleX() });
  }

  async function persistCreate(geometry: NormalizedBoundingBox) {
    setSaveState("saving");
    const result = await createBoundingBoxAction({ datasetId, assetId: asset.id, labelId: activeLabelId, geometry });
    if (result.ok) { upsertSafeAnnotation(result.annotation); setSelectedId(result.annotation.id); onToolChange("select"); setSaveState("saved"); return "saved" as const; }
    setSaveState(result.error === "CONFLICT" ? "conflict" : "failed"); setSaveError(result.error === "CONFLICT" ? "This image changed. Reload before continuing." : "The bounding box could not be saved.");
    return result.error === "CONFLICT" ? "conflict" as const : "failed" as const;
  }

  async function persistGeometry(annotation: SafeImageAnnotation, pixelBox: { x: number; y: number; width: number; height: number }) {
    const geometry = normalizeBoundingBox(pixelBox, originalWidth, originalHeight);
    if (!geometry) return "failed" as const;
    setSaveState("saving");
    const result = await updateBoundingBoxGeometryAction({ datasetId, assetId: asset.id, annotationId: annotation.id, version: annotation.version, geometry });
    if (result.ok) { upsertSafeAnnotation(result.annotation); setSaveState("saved"); return "saved" as const; }
    if (result.error === "CONFLICT") {
      const resourceKey = `annotation:${annotation.id}`;
      setConflictDraft(resourceKey, { geometry });
      setConflictKey(resourceKey);
      setSaveState("conflict");
      setSaveError("A newer annotation version exists. Your local change was retained locally.");
      return "conflict" as const;
    }
    setSaveState("failed"); setSaveError("The bounding box could not be updated.");
    return "failed" as const;
  }

  async function removeSelected() {
    const annotation = annotations.find((item) => item.id === selectedId);
    if (!annotation) return;
    const result = await deleteBoundingBoxAction({ datasetId, assetId: asset.id, annotationId: annotation.id, version: annotation.version });
    if (result.ok) { removeSafeAnnotation(annotation.id); setSelectedId(null); }
    else setSaveError(result.error === "CONFLICT" ? "A newer annotation version exists. Reload before deleting." : "The annotation could not be deleted.");
  }

  return <section className="flex min-h-[520px] min-w-0 flex-col bg-zinc-900 lg:min-h-0">
    <div ref={containerRef} className="canvas-grid relative min-h-0 flex-1 overflow-hidden">
      {viewport.width > 0 && viewport.height > 0 && image && <Stage ref={stageRef} width={viewport.width} height={viewport.height} draggable={tool === "pan"} onMouseDown={() => { if (tool !== "box") { setSelectedId(null); return; } const point = pointerInImage(); if (!point) return; setDrawingStart(point); setDraft({ x: point.x, y: point.y, width: 0, height: 0 }); }} onMouseMove={() => { if (!drawingStart) return; const point = pointerInImage(); if (!point) return; setDraft({ x: Math.min(drawingStart.x, point.x), y: Math.min(drawingStart.y, point.y), width: Math.abs(point.x - drawingStart.x), height: Math.abs(point.y - drawingStart.y) }); }} onMouseUp={() => { if (!draft) { setDrawingStart(null); return; } const geometry = normalizeBoundingBox(draft, originalWidth, originalHeight); setDraft(null); setDrawingStart(null); if (geometry) scheduleAutosave(`create-${pendingCreateCounterRef.current++}`, () => persistCreate(geometry)); }} onWheel={(event) => { event.evt.preventDefault(); const stage = event.target.getStage(); const pointer = stage?.getPointerPosition(); if (!stage || !pointer) return; const oldScale = stage.scaleX(); const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * (event.evt.deltaY > 0 ? 1 / 1.08 : 1.08))); const point = { x: (pointer.x - stage.x()) / oldScale, y: (pointer.y - stage.y()) / oldScale }; stage.scale({ x: nextScale, y: nextScale }); stage.position({ x: pointer.x - point.x * nextScale, y: pointer.y - point.y * nextScale }); stage.batchDraw(); setZoomPercent(Math.round(nextScale * 100)); }}>
        <Layer><KonvaImage image={image} x={0} y={0} />
          {annotations.map((annotation) => { const box = annotation.geometry; const selected = annotation.id === selectedId; return <Rect key={annotation.id} ref={(node) => { if (selected) selectedNodeRef.current = node; }} x={box.x * originalWidth} y={box.y * originalHeight} width={box.width * originalWidth} height={box.height * originalHeight} stroke={colorFor(annotation, labels)} strokeWidth={selected ? 3 : 2} fill={`${colorFor(annotation, labels)}22`} draggable={tool === "select" && selected} onClick={(event) => { event.cancelBubble = true; setSelectedId(annotation.id); }} onTap={(event) => { event.cancelBubble = true; setSelectedId(annotation.id); }} onDragEnd={(event) => { const next = { x: event.target.x(), y: event.target.y(), width: event.target.width(), height: event.target.height() }; const geometry = normalizeBoundingBox(next, originalWidth, originalHeight); if (!geometry) return; upsertSafeAnnotation({ ...annotation, geometry }); setSaveState("pending"); scheduleAutosave(`annotation:${annotation.id}`, () => persistGeometry(annotation, next)); }} onTransformEnd={(event) => { const node = event.target; const scaleX = node.scaleX(); const scaleY = node.scaleY(); node.scale({ x: 1, y: 1 }); const next = { x: node.x(), y: node.y(), width: Math.max(1, node.width() * scaleX), height: Math.max(1, node.height() * scaleY) }; const geometry = normalizeBoundingBox(next, originalWidth, originalHeight); if (!geometry) return; upsertSafeAnnotation({ ...annotation, geometry }); setSaveState("pending"); scheduleAutosave(`annotation:${annotation.id}`, () => persistGeometry(annotation, next)); }} />; })}
          {draft && <Rect x={draft.x} y={draft.y} width={draft.width} height={draft.height} stroke="#7dd3fc" dash={[6, 4]} strokeWidth={2} />}
          <Transformer ref={transformerRef} rotateEnabled={false} enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right"]} boundBoxFunc={(_, next) => next.width < 2 || next.height < 2 ? _ : next} />
        </Layer>
      </Stage>}
      {loadState !== "ready" && <div className="absolute inset-0 grid place-items-center px-6 text-center"><div><p className="text-sm font-medium text-zinc-300">{loadState === "loading" ? `Loading ${asset.filename}` : "The source image is unavailable."}</p>{loadState === "expired" && <button type="button" className="mt-3 rounded-lg bg-sky-600 px-3 py-2 text-xs font-semibold text-white" onClick={() => void requestViewUrl()}>Refresh image access</button>}</div></div>}
      {saveState === "pending" && <p className="absolute bottom-4 right-4 rounded-lg bg-zinc-950/90 px-3 py-2 text-xs text-zinc-200">Saving after inactivity…</p>}
      {saveState === "saving" && <p className="absolute bottom-4 right-4 rounded-lg bg-zinc-950/90 px-3 py-2 text-xs text-zinc-200">Saving…</p>}
      {saveError && <p role="alert" className="absolute bottom-4 left-4 rounded-lg bg-rose-950/90 px-3 py-2 text-xs text-rose-100">{saveError}</p>}
      {conflictKey && <div className="absolute bottom-12 left-4 max-w-sm"><SaveConflictPanel message="The canvas kept your local geometry. Reload the durable version, discard the local draft, or keep it visible while you reconcile it manually." onReload={() => window.location.reload()} onDiscard={() => { clearConflictDraft(conflictKey); window.location.reload(); }} onReconcile={() => setConflictKey(null)} /></div>}
    </div>
    <Toolbar zoomPercent={zoomPercent} onFit={fitImage} onZoomIn={() => zoomAtCenter(1.2)} onZoomOut={() => zoomAtCenter(1 / 1.2)} tool={tool} onToolChange={onToolChange} onDelete={removeSelected} canDelete={Boolean(selectedId)} labels={labels} activeLabelId={activeLabelId} onActiveLabelChange={setActiveLabelId} />
  </section>;
}
