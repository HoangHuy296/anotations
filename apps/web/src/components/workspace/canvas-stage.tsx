"use client";

import type Konva from "konva";
import { useCallback, useEffect, useRef, useState } from "react";
import { Circle, Group, Image as KonvaImage, Layer, Line, Rect, Stage, Transformer } from "react-konva";

import { Toolbar } from "@/components/workspace/toolbar";
import { SaveConflictPanel } from "@/components/workspace/save-conflict-panel";
import { putAssetAnnotations } from "@/lib/annotations/annotation-api-client";
import { randomUUIDAuto } from "@/lib/browser-random-uuid";
import { normalizeBoundingBox, viewportPointToImage } from "@/lib/workspace/geometry";
import { replacePathVertex, resizeNormalizedCircle, translateImageGeometry } from "@/lib/workspace/annotation-geometry";
import { useAnnotationStore } from "@/stores/image-annotation-store";
import type { AnnotationTool } from "@/types/annotation";
import type { ImageAnnotationGeometry, NormalizedBoundingBox, NormalizedPoint, SafeImageAnnotation, SafeImageWorkspaceAsset, SafeReadOnlyImageAnnotation, SafeWorkspaceLabel } from "@/types/image-workspace";

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
const FIT_PADDING = 48;
const VIEW_URL_CACHE_MS = 4 * 60 * 1000;
const cachedViewUrls = new Map<string, { url: string; expiresAt: number }>();
const inFlightViewUrls = new Map<string, Promise<string>>();

type CanvasStageProps = {
  image: SafeImageWorkspaceAsset;
  annotations: SafeImageAnnotation[];
  unsupportedAnnotations: SafeReadOnlyImageAnnotation[];
  labels: SafeWorkspaceLabel[];
  tool: AnnotationTool;
  onToolChange: (tool: AnnotationTool) => void;
};

function colorFor(annotation: SafeImageAnnotation, labels: SafeWorkspaceLabel[]) {
  return labels.find((label) => label.id === annotation.labelId)?.color ?? "#38bdf8";
}

function isBox(annotation: SafeImageAnnotation): annotation is SafeImageAnnotation & { geometry: NormalizedBoundingBox } {
  const geometry = annotation.geometry as Partial<NormalizedBoundingBox>;
  return annotation.type === "BOUNDING_BOX" && typeof geometry.x === "number" && typeof geometry.y === "number" && typeof geometry.width === "number" && typeof geometry.height === "number";
}

function normalizedPoints(value: unknown): [number, number][] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { points?: unknown }).points)) return [];
  return (value as { points: unknown[] }).points.flatMap((point) => Array.isArray(point) && point.length === 2 && point.every((item) => typeof item === "number") ? [[point[0], point[1]] as [number, number]] : []);
}

function isImageGeometry(value: unknown): value is ImageAnnotationGeometry {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

function toCanvasAnnotation(annotation: import("@/lib/annotations/safe-annotation").SafeAnnotation): SafeImageAnnotation | null {
  if (annotation.modality !== "IMAGE" || !["BOUNDING_BOX", "POLYGON", "CIRCLE", "POINT", "POLYLINE"].includes(annotation.type)) return null;
  return { ...annotation, modality: "IMAGE", type: annotation.type as SafeImageAnnotation["type"], geometry: annotation.geometry as SafeImageAnnotation["geometry"] };
}

export default function CanvasStage({ image: asset, annotations: initialAnnotations, unsupportedAnnotations, labels, tool, onToolChange }: CanvasStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const selectedNodeRef = useRef<Konva.Rect | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
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
  const [pathPoints, setPathPoints] = useState<NormalizedPoint[]>([]);
  // Ids of client-created annotations still awaiting server confirmation.
  // They render immediately (optimistic UI) but stay non-interactive so a
  // drag/transform can never race the create that establishes their
  // authoritative revision.
  const [pendingCreateIds, setPendingCreateIds] = useState<Set<string>>(new Set());
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
      // MinIO's view URL is a different origin from the app (a different
      // port, at minimum). Without this, the browser loads the image in
      // "no-cors" mode regardless of what CORS headers MinIO sends, which
      // taints the canvas for any pixel-level read — including Konva's own
      // internal hit-detection, silently breaking selection/drag/resize.
      next.crossOrigin = "anonymous";
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

  // Renders the new shape the instant drawing finishes, ahead of the
  // PostgreSQL round trip: low latency wins over waiting for the server to
  // confirm. `persistCreate` (scheduled separately, after the autosave
  // debounce) reconciles this placeholder with the durable row, or rolls it
  // back if the save ultimately fails.
  function beginOptimisticCreate(type: SafeImageAnnotation["type"], geometry: ImageAnnotationGeometry) {
    const id = randomUUIDAuto();
    const optimistic: SafeImageAnnotation = { id, assetId: asset.id, labelId: activeLabelId, revision: 0, type, geometry, status: "DRAFT", updatedAt: new Date().toISOString() };
    upsertSafeAnnotation(optimistic);
    setSelectedId(id);
    onToolChange("select");
    setPendingCreateIds((current) => new Set(current).add(id));
    setSaveState("pending");
    return id;
  }

  async function persistCreate(id: string, type: SafeImageAnnotation["type"], geometry: ImageAnnotationGeometry) {
    setSaveState("saving");
    const result = await putAssetAnnotations(asset.id, { creates: [{ id, type, labelId: activeLabelId, geometry }] });
    setPendingCreateIds((current) => { if (!current.has(id)) return current; const next = new Set(current); next.delete(id); return next; });
    const created = result.ok ? result.annotations.map(toCanvasAnnotation).find((item): item is SafeImageAnnotation => item?.id === id) : null;
    if (created) { upsertSafeAnnotation(created); setSaveState("saved"); return "saved" as const; }
    // The server never confirmed this id -- discard the optimistic shape
    // rather than leave a box on screen PostgreSQL doesn't know about.
    removeSafeAnnotation(id);
    setSaveState(result.ok || !result.conflict ? "failed" : "conflict"); setSaveError(result.ok || !result.conflict ? "The annotation could not be saved." : "This image changed. Reload before continuing.");
    return result.ok || !result.conflict ? "failed" as const : "conflict" as const;
  }

  async function persistGeometry(annotation: SafeImageAnnotation, geometry: ImageAnnotationGeometry) {
    setSaveState("saving");
    const result = await putAssetAnnotations(asset.id, { updates: [{ id: annotation.id, revision: annotation.revision, geometry }] });
    const updated = result.ok ? result.annotations.map(toCanvasAnnotation).find((item): item is SafeImageAnnotation => item?.id === annotation.id) : null;
    if (updated) { upsertSafeAnnotation(updated); setSaveState("saved"); return "saved" as const; }
    if (!result.ok && result.conflict) {
      const resourceKey = `annotation:${annotation.id}`;
      setConflictDraft(resourceKey, { geometry });
      setConflictKey(resourceKey);
      setSaveState("conflict");
      setSaveError("A newer annotation version exists. Your local change was retained locally.");
      return "conflict" as const;
    }
    setSaveState("failed"); setSaveError("The annotation could not be updated.");
    return "failed" as const;
  }

  async function removeSelected() {
    const annotation = annotations.find((item) => item.id === selectedId);
    if (!annotation) return;
    const result = await putAssetAnnotations(asset.id, { deletes: [{ id: annotation.id, revision: annotation.revision }] });
    if (result.ok) { removeSafeAnnotation(annotation.id); setSelectedId(null); }
    else setSaveError(result.conflict ? "A newer annotation version exists. Reload before deleting." : "The annotation could not be deleted.");
  }

  function finishPath() {
    const minimum = tool === "polygon" ? 3 : 2;
    if ((tool !== "polygon" && tool !== "polyline") || pathPoints.length < minimum) return;
    const type = tool === "polygon" ? "POLYGON" : "POLYLINE";
    const geometry = { points: pathPoints } as ImageAnnotationGeometry;
    setPathPoints([]);
    const id = beginOptimisticCreate(type, geometry);
    // Path finish is already the commit boundary -- there's no next
    // keystroke to coalesce with, so save immediately instead of waiting out
    // the debounce that exists for continuous drag/transform edits.
    scheduleAutosave(`create-${id}`, () => persistCreate(id, type, geometry), 0);
  }

  function startCanvasInteraction(event: Konva.KonvaEventObject<MouseEvent>) {
    const point = pointerInImage();
    if (!point) return;
    if (tool === "box" || tool === "circle") {
      setDrawingStart(point);
      setDraft({ x: point.x, y: point.y, width: 0, height: 0 });
      return;
    }
    if (tool === "point") {
      const geometry: ImageAnnotationGeometry = { px: point.x / originalWidth, py: point.y / originalHeight };
      const id = beginOptimisticCreate("POINT", geometry);
      scheduleAutosave(`create-${id}`, () => persistCreate(id, "POINT", geometry), 0);
      return;
    }
    if (tool === "polygon" || tool === "polyline") {
      setPathPoints((current) => [...current, [point.x / originalWidth, point.y / originalHeight]]);
      return;
    }
    // This mousedown handler is on the Stage, so it also fires for a
    // mousedown that lands on an existing shape (mousedown bubbles up
    // independently of the shape's own click handler's cancelBubble). Only
    // clear selection when the empty stage background itself was hit —
    // otherwise this clears `selected` (and therefore `draggable`) the
    // instant the user presses down on a shape, aborting the drag before
    // Konva can ever start it.
    if (event.target === event.target.getStage()) setSelectedId(null);
  }

  function updateCanvasDraft() {
    if (!drawingStart || (tool !== "box" && tool !== "circle")) return;
    const point = pointerInImage();
    if (!point) return;
    setDraft({ x: Math.min(drawingStart.x, point.x), y: Math.min(drawingStart.y, point.y), width: Math.abs(point.x - drawingStart.x), height: Math.abs(point.y - drawingStart.y) });
  }

  function finishCanvasInteraction() {
    if (!draft || !drawingStart) { setDrawingStart(null); return; }
    if (tool === "box") {
      const geometry = normalizeBoundingBox(draft, originalWidth, originalHeight);
      if (geometry) { const id = beginOptimisticCreate("BOUNDING_BOX", geometry); scheduleAutosave(`create-${id}`, () => persistCreate(id, "BOUNDING_BOX", geometry), 0); }
    } else if (tool === "circle") {
      const cx = drawingStart.x / originalWidth;
      const cy = drawingStart.y / originalHeight;
      const r = Math.hypot(draft.width, draft.height) / originalWidth;
      if (r > 0 && cx - r >= 0 && cx + r <= 1 && cy - r >= 0 && cy + r <= 1) {
        const geometry: ImageAnnotationGeometry = { cx, cy, r };
        const id = beginOptimisticCreate("CIRCLE", geometry);
        scheduleAutosave(`create-${id}`, () => persistCreate(id, "CIRCLE", geometry), 0);
      }
    }
    setDraft(null);
    setDrawingStart(null);
  }

  return <section className="flex min-h-[520px] min-w-0 flex-col bg-zinc-900 lg:min-h-0">
    <div ref={containerRef} className="canvas-grid relative min-h-0 flex-1 overflow-hidden">
      {viewport.width > 0 && viewport.height > 0 && image && <Stage ref={stageRef} width={viewport.width} height={viewport.height} draggable={tool === "pan"} onMouseDown={startCanvasInteraction} onMouseMove={updateCanvasDraft} onMouseUp={finishCanvasInteraction} onWheel={(event) => { event.evt.preventDefault(); const stage = event.target.getStage(); const pointer = stage?.getPointerPosition(); if (!stage || !pointer) return; const oldScale = stage.scaleX(); const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * (event.evt.deltaY > 0 ? 1 / 1.08 : 1.08))); const point = { x: (pointer.x - stage.x()) / oldScale, y: (pointer.y - stage.y()) / oldScale }; stage.scale({ x: nextScale, y: nextScale }); stage.position({ x: pointer.x - point.x * nextScale, y: pointer.y - point.y * nextScale }); stage.batchDraw(); setZoomPercent(Math.round(nextScale * 100)); }}>
        <Layer><KonvaImage image={image} x={0} y={0} />
          {annotations.map((annotation) => {
            const selected = annotation.id === selectedId;
            // A create still in flight renders (optimistic UI) but stays
            // non-interactive: dragging/resizing it before the server
            // confirms the id would race the create for its own revision.
            const interactive = selected && !pendingCreateIds.has(annotation.id);
            const common = { stroke: colorFor(annotation, labels), strokeWidth: selected ? 3 : 2, onClick: (event: { cancelBubble: boolean }) => { event.cancelBubble = true; setSelectedId(annotation.id); }, onTap: (event: { cancelBubble: boolean }) => { event.cancelBubble = true; setSelectedId(annotation.id); } };
            if (isBox(annotation)) { const box = annotation.geometry; return <Rect key={annotation.id} ref={(node) => { if (interactive) selectedNodeRef.current = node; }} x={box.x * originalWidth} y={box.y * originalHeight} width={box.width * originalWidth} height={box.height * originalHeight} fill={`${colorFor(annotation, labels)}22`} draggable={tool === "select" && interactive} {...common} onDragEnd={(event) => { const next = { x: event.target.x(), y: event.target.y(), width: event.target.width(), height: event.target.height() }; const geometry = normalizeBoundingBox(next, originalWidth, originalHeight); if (!geometry) return; upsertSafeAnnotation({ ...annotation, geometry }); setSaveState("pending"); scheduleAutosave(`annotation:${annotation.id}`, () => persistGeometry(annotation, geometry)); }} onTransformEnd={(event) => { const node = event.target; const scaleX = node.scaleX(); const scaleY = node.scaleY(); node.scale({ x: 1, y: 1 }); const next = { x: node.x(), y: node.y(), width: Math.max(1, node.width() * scaleX), height: Math.max(1, node.height() * scaleY) }; const geometry = normalizeBoundingBox(next, originalWidth, originalHeight); if (!geometry) return; upsertSafeAnnotation({ ...annotation, geometry }); setSaveState("pending"); scheduleAutosave(`annotation:${annotation.id}`, () => persistGeometry(annotation, geometry)); }} />; }
            const geometry = annotation.geometry as Record<string, unknown>;
            const persistTranslation = (event: Konva.KonvaEventObject<DragEvent>) => {
              if (!isImageGeometry(annotation.geometry)) return;
              const next = translateImageGeometry(annotation.geometry, event.target.x() / originalWidth, event.target.y() / originalHeight);
              event.target.position({ x: 0, y: 0 });
              if (!next) return;
              upsertSafeAnnotation({ ...annotation, geometry: next });
              setSaveState("pending");
              scheduleAutosave(`annotation:${annotation.id}`, () => persistGeometry(annotation, next));
            };
            if ((annotation.type === "POLYGON" || annotation.type === "POLYLINE")) {
              const normalized = normalizedPoints(geometry);
              const points = normalized.flatMap(([x, y]) => [x * originalWidth, y * originalHeight]);
              return <Group key={annotation.id}>
                <Line points={points} closed={annotation.type === "POLYGON"} draggable={tool === "select" && interactive} {...common} onDragEnd={persistTranslation} />
                {interactive && tool === "select" && normalized.map(([x, y], index) => <Circle key={`${annotation.id}-vertex-${index}`} x={x * originalWidth} y={y * originalHeight} radius={5} fill="#ffffff" stroke={colorFor(annotation, labels)} strokeWidth={2} draggable onDragEnd={(event) => {
                  if (!("points" in annotation.geometry)) return;
                  const next = replacePathVertex(annotation.geometry, index, [event.target.x() / originalWidth, event.target.y() / originalHeight]);
                  if (!next) { event.target.position({ x: x * originalWidth, y: y * originalHeight }); return; }
                  upsertSafeAnnotation({ ...annotation, geometry: next });
                  setSaveState("pending");
                  scheduleAutosave(`annotation:${annotation.id}`, () => persistGeometry(annotation, next));
                }} />)}
              </Group>;
            }
            if (annotation.type === "CIRCLE" && typeof geometry.cx === "number" && typeof geometry.cy === "number" && typeof geometry.r === "number") {
              const circle = geometry as { cx: number; cy: number; r: number };
              return <Group key={annotation.id}>
                <Circle x={circle.cx * originalWidth} y={circle.cy * originalHeight} radius={circle.r * originalWidth} draggable={tool === "select" && interactive} {...common} onDragEnd={persistTranslation} />
                {interactive && tool === "select" && <Circle x={(circle.cx + circle.r) * originalWidth} y={circle.cy * originalHeight} radius={5} fill="#ffffff" stroke={colorFor(annotation, labels)} strokeWidth={2} draggable onDragEnd={(event) => {
                  const next = resizeNormalizedCircle(circle, [event.target.x() / originalWidth, event.target.y() / originalHeight]);
                  if (!next) { event.target.position({ x: (circle.cx + circle.r) * originalWidth, y: circle.cy * originalHeight }); return; }
                  upsertSafeAnnotation({ ...annotation, geometry: next });
                  setSaveState("pending");
                  scheduleAutosave(`annotation:${annotation.id}`, () => persistGeometry(annotation, next));
                }} />}
              </Group>;
            }
            if (annotation.type === "POINT" && typeof geometry.px === "number" && typeof geometry.py === "number") return <Circle key={annotation.id} x={geometry.px * originalWidth} y={geometry.py * originalHeight} radius={5} fill={colorFor(annotation, labels)} draggable={tool === "select" && interactive} {...common} onDragEnd={persistTranslation} />;
            return null;
          })}
          {draft && tool === "box" && <Rect x={draft.x} y={draft.y} width={draft.width} height={draft.height} stroke="#7dd3fc" dash={[6, 4]} strokeWidth={2} />}
          {draft && tool === "circle" && drawingStart && <Circle x={drawingStart.x} y={drawingStart.y} radius={Math.hypot(draft.width, draft.height)} stroke="#7dd3fc" dash={[6, 4]} strokeWidth={2} />}
          {pathPoints.length > 0 && (tool === "polygon" || tool === "polyline") && <Line points={pathPoints.flatMap(([x, y]) => [x * originalWidth, y * originalHeight])} closed={tool === "polygon" && pathPoints.length > 2} stroke="#7dd3fc" dash={[6, 4]} strokeWidth={2} />}
          <Transformer ref={transformerRef} rotateEnabled={false} enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right"]} boundBoxFunc={(_, next) => next.width < 2 || next.height < 2 ? _ : next} />
        </Layer>
      </Stage>}
      {loadState !== "ready" && <div className="absolute inset-0 grid place-items-center px-6 text-center"><div><p className="text-sm font-medium text-zinc-300">{loadState === "loading" ? `Loading ${asset.filename}` : "The source image is unavailable."}</p>{loadState === "expired" && <button type="button" className="mt-3 rounded-lg bg-sky-600 px-3 py-2 text-xs font-semibold text-white" onClick={() => void requestViewUrl()}>Refresh image access</button>}</div></div>}
      {saveState === "pending" && <p className="absolute bottom-4 right-4 rounded-lg bg-zinc-950/90 px-3 py-2 text-xs text-zinc-200">Saving after inactivity…</p>}
      {saveState === "saving" && <p className="absolute bottom-4 right-4 rounded-lg bg-zinc-950/90 px-3 py-2 text-xs text-zinc-200">Saving…</p>}
      {saveError && <p role="alert" className="absolute bottom-4 left-4 rounded-lg bg-rose-950/90 px-3 py-2 text-xs text-rose-100">{saveError}</p>}
      {unsupportedAnnotations.length > 0 && <p className="absolute left-4 top-4 max-w-sm rounded-lg bg-zinc-950/90 px-3 py-2 text-xs text-zinc-200">{unsupportedAnnotations.length} unsupported annotation{unsupportedAnnotations.length === 1 ? "" : "s"} retained as read-only: {unsupportedAnnotations.map((annotation) => annotation.type.replaceAll("_", " ")).join(", ")}.</p>}
      {conflictKey && <div className="absolute bottom-12 left-4 max-w-sm"><SaveConflictPanel message="The canvas kept your local geometry. Reload the durable version, discard the local draft, or keep it visible while you reconcile it manually." onReload={() => window.location.reload()} onDiscard={() => { clearConflictDraft(conflictKey); window.location.reload(); }} onReconcile={() => setConflictKey(null)} /></div>}
    </div>
    <Toolbar zoomPercent={zoomPercent} onFit={fitImage} onZoomIn={() => zoomAtCenter(1.2)} onZoomOut={() => zoomAtCenter(1 / 1.2)} tool={tool} onToolChange={onToolChange} onDelete={removeSelected} canDelete={Boolean(selectedId)} labels={labels} activeLabelId={activeLabelId} onActiveLabelChange={setActiveLabelId} onFinishPath={finishPath} canFinishPath={pathPoints.length >= (tool === "polygon" ? 3 : 2)} />
  </section>;
}
