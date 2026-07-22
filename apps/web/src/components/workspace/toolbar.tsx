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
import type { SafeWorkspaceLabel } from "@/types/image-workspace";

type ToolbarProps = {
  zoomPercent: number;
  onFit: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  tool: AnnotationTool;
  onToolChange: (tool: AnnotationTool) => void;
  onDelete: () => void;
  canDelete: boolean;
  labels: SafeWorkspaceLabel[];
  activeLabelId: string | null;
  onActiveLabelChange: (labelId: string | null) => void;
};

export function Toolbar({
  zoomPercent,
  onFit,
  onZoomIn,
  onZoomOut,
  tool,
  onToolChange,
  onDelete,
  canDelete,
  labels,
  activeLabelId,
  onActiveLabelChange,
}: ToolbarProps) {
  return (
    <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-900 px-3 py-1.5">
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
        <button type="button" aria-label="Delete selected annotation" disabled={!canDelete} onClick={onDelete} className="h-9 rounded-lg px-2 text-xs font-semibold text-rose-300 hover:bg-rose-950/40 disabled:opacity-35">Delete</button>
        <button type="button" disabled title="Undo will be enabled with durable history" className="h-9 rounded-lg px-2 text-xs font-semibold text-zinc-500 disabled:opacity-50">Undo</button>
        <button type="button" disabled title="Redo will be enabled with durable history" className="h-9 rounded-lg px-2 text-xs font-semibold text-zinc-500 disabled:opacity-50">Redo</button>
        <label className="sr-only" htmlFor="active-label">Active label</label>
        <select id="active-label" value={activeLabelId ?? ""} onChange={(event) => onActiveLabelChange(event.target.value || null)} className="h-9 max-w-32 rounded-lg border border-zinc-700 bg-zinc-800 px-2 text-xs text-zinc-100 outline-none">
          <option value="">No label</option>
          {labels.map((label) => <option value={label.id} key={label.id}>{label.name}</option>)}
        </select>
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
