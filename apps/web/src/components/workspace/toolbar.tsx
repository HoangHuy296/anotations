"use client";

import {
  ArrowsOut,
  BoundingBox,
  Cursor,
  Hand,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
} from "@phosphor-icons/react";
import type { AnnotationTool } from "@/types/annotation";

type ToolbarProps = {
  zoomPercent: number;
  onFit: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  tool: AnnotationTool;
  onToolChange: (tool: AnnotationTool) => void;
};

export function Toolbar({
  zoomPercent,
  onFit,
  onZoomIn,
  onZoomOut,
  tool,
  onToolChange,
}: ToolbarProps) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900 px-3">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Select"
          className={`grid size-9 place-items-center rounded-lg ${
            tool === "select" ? "bg-sky-500 text-white" : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
          }`}
          onClick={() => onToolChange("select")}
        >
          <Cursor aria-hidden="true" size={18} weight="bold" />
        </button>
        <button
          type="button"
          aria-label="Draw bounding box"
          className={`grid size-9 place-items-center rounded-lg ${
            tool === "box" ? "bg-sky-500 text-white" : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
          }`}
          onClick={() => onToolChange("box")}
        >
          <BoundingBox aria-hidden="true" size={18} />
        </button>
        <button
          type="button"
          aria-label="Pan by dragging the canvas"
          className={`grid size-9 place-items-center rounded-lg ${
            tool === "pan" ? "bg-sky-500 text-white" : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
          }`}
          onClick={() => onToolChange("pan")}
        >
          <Hand aria-hidden="true" size={18} />
        </button>
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          className="grid size-9 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-white"
          aria-label="Zoom out"
          onClick={onZoomOut}
        >
          <MagnifyingGlassMinus aria-hidden="true" size={18} />
        </button>
        <span className="min-w-12 text-center font-mono text-[11px] text-zinc-300">
          {zoomPercent}%
        </span>
        <button
          type="button"
          className="grid size-9 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-white"
          aria-label="Zoom in"
          onClick={onZoomIn}
        >
          <MagnifyingGlassPlus aria-hidden="true" size={18} />
        </button>
        <button
          type="button"
          className="grid size-9 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-white"
          aria-label="Fit image to viewport"
          onClick={onFit}
        >
          <ArrowsOut aria-hidden="true" size={18} />
        </button>
      </div>
    </div>
  );
}
