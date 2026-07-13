"use client";

import type Konva from "konva";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image as KonvaImage, Layer, Stage } from "react-konva";

import { Toolbar } from "@/components/workspace/toolbar";
import type { AnnotationTool } from "@/types/annotation";

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
const FIT_PADDING = 48;

interface CanvasStageProps {
  imageId: string;
  filename: string;
  knownWidth: number | null;
  knownHeight: number | null;
  tool: AnnotationTool;
  onToolChange: (tool: AnnotationTool) => void;
}

export default function CanvasStage({
  imageId,
  filename,
  knownWidth,
  knownHeight,
  tool,
  onToolChange,
}: CanvasStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [zoomPercent, setZoomPercent] = useState(100);

  const publishZoom = useCallback((scale: number) => {
    if (zoomFrameRef.current !== null) {
      cancelAnimationFrame(zoomFrameRef.current);
    }
    zoomFrameRef.current = requestAnimationFrame(() => {
      setZoomPercent(Math.round(scale * 100));
      zoomFrameRef.current = null;
    });
  }, []);

  const fitImage = useCallback(() => {
    const stage = stageRef.current;
    const loadedImage = imageRef.current;
    if (!stage || !loadedImage || viewport.width === 0 || viewport.height === 0) {
      return;
    }

    const availableWidth = Math.max(1, viewport.width - FIT_PADDING * 2);
    const availableHeight = Math.max(1, viewport.height - FIT_PADDING * 2);
    const scale = Math.min(
      availableWidth / loadedImage.naturalWidth,
      availableHeight / loadedImage.naturalHeight,
      1,
    );

    stage.scale({ x: scale, y: scale });
    stage.position({
      x: (viewport.width - loadedImage.naturalWidth * scale) / 2,
      y: (viewport.height - loadedImage.naturalHeight * scale) / 2,
    });
    stage.batchDraw();
    publishZoom(scale);
  }, [publishZoom, viewport.height, viewport.width]);

  const zoomAtCenter = useCallback(
    (multiplier: number) => {
      const stage = stageRef.current;
      if (!stage) return;

      const oldScale = stage.scaleX();
      const newScale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, oldScale * multiplier),
      );
      const center = {
        x: viewport.width / 2,
        y: viewport.height / 2,
      };
      const point = {
        x: (center.x - stage.x()) / oldScale,
        y: (center.y - stage.y()) / oldScale,
      };

      stage.scale({ x: newScale, y: newScale });
      stage.position({
        x: center.x - point.x * newScale,
        y: center.y - point.y * newScale,
      });
      stage.batchDraw();
      publishZoom(newScale);
    },
    [publishZoom, viewport.height, viewport.width],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setViewport({
        width: Math.floor(entry.contentRect.width),
        height: Math.floor(entry.contentRect.height),
      });
    });
    observer.observe(container);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const nextImage = new window.Image();
    nextImage.decoding = "async";
    nextImage.onload = () => {
      if (cancelled) return;
      imageRef.current = nextImage;
      setImage(nextImage);
      setLoadState("ready");

      if (
        nextImage.naturalWidth !== knownWidth ||
        nextImage.naturalHeight !== knownHeight
      ) {
        void fetch(`/api/images/${imageId}/dimensions`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            width: nextImage.naturalWidth,
            height: nextImage.naturalHeight,
          }),
        });
      }
    };
    nextImage.onerror = () => {
      if (!cancelled) setLoadState("error");
    };
    imageRef.current = null;
    nextImage.src = `/api/images/${imageId}/content`;

    return () => {
      cancelled = true;
      nextImage.onload = null;
      nextImage.onerror = null;
    };
  }, [imageId, knownHeight, knownWidth]);

  useEffect(() => {
    if (image && viewport.width > 0 && viewport.height > 0) {
      fitImage();
    }
  }, [fitImage, image, viewport.height, viewport.width]);

  useEffect(
    () => () => {
      if (zoomFrameRef.current !== null) {
        cancelAnimationFrame(zoomFrameRef.current);
      }
    },
    [],
  );

  return (
    <section className="flex min-h-[520px] min-w-0 flex-col bg-zinc-900 lg:min-h-0">
      <Toolbar
        zoomPercent={zoomPercent}
        onFit={fitImage}
        onZoomIn={() => zoomAtCenter(1.2)}
        onZoomOut={() => zoomAtCenter(1 / 1.2)}
        tool={tool}
        onToolChange={onToolChange}
      />
      <div
        ref={containerRef}
        className="canvas-grid relative min-h-0 flex-1 overflow-hidden"
      >
        {viewport.width > 0 && viewport.height > 0 && image && (
          <Stage
            ref={stageRef}
            width={viewport.width}
            height={viewport.height}
            draggable
            onWheel={(event) => {
              event.evt.preventDefault();
              const stage = event.target.getStage();
              const pointer = stage?.getPointerPosition();
              if (!stage || !pointer) return;

              const oldScale = stage.scaleX();
              const direction = event.evt.deltaY > 0 ? 1 / 1.08 : 1.08;
              const newScale = Math.min(
                MAX_SCALE,
                Math.max(MIN_SCALE, oldScale * direction),
              );
              const point = {
                x: (pointer.x - stage.x()) / oldScale,
                y: (pointer.y - stage.y()) / oldScale,
              };

              stage.scale({ x: newScale, y: newScale });
              stage.position({
                x: pointer.x - point.x * newScale,
                y: pointer.y - point.y * newScale,
              });
              stage.batchDraw();
              publishZoom(newScale);
            }}
          >
            <Layer>
              <KonvaImage image={image} x={0} y={0} />
            </Layer>
          </Stage>
        )}

        {loadState !== "ready" && (
          <div className="absolute inset-0 grid place-items-center px-6 text-center">
            <div>
              <div className="mx-auto h-2 w-40 overflow-hidden rounded-full bg-zinc-800">
                {loadState === "loading" && (
                  <div className="h-full w-1/2 animate-pulse rounded-full bg-sky-500" />
                )}
              </div>
              <p className="mt-4 text-sm font-medium text-zinc-300">
                {loadState === "loading"
                  ? `Loading ${filename}`
                  : "The source image could not be loaded."}
              </p>
              {loadState === "error" && (
                <p className="mt-1 text-xs text-zinc-500">
                  Check the Gitea connection and repository permissions.
                </p>
              )}
            </div>
          </div>
        )}

        {loadState === "ready" && (
          <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg border border-white/10 bg-zinc-950/75 px-3 py-2 text-[11px] text-zinc-300 backdrop-blur">
            Drag to pan · Wheel to zoom · Fit restores the full image
          </div>
        )}
      </div>
    </section>
  );
}
