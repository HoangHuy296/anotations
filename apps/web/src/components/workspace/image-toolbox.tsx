"use client";

import { BoundingBox, Circle, Cursor, Hand, LineSegment, MapPin, Pentagon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { useAnnotationStore } from "@/stores/image-annotation-store";

/**
 * IMAGE's `DatasetSidebar` toolbox content. This is the pre-registry
 * `DatasetSidebar` tool-button markup, unchanged in behavior, moved here so
 * `workspace-engine-registry.ts` can reference it as the IMAGE entry's
 * `Toolbox`. Dataset/asset navigation and "Open directory" stay in the
 * shared `DatasetSidebar` shell — they are engine-independent (FR-035).
 */
export function ImageToolbox() {
  const tool = useAnnotationStore((store) => store.tool);
  const setTool = useAnnotationStore((store) => store.setTool);
  return <>
    <div className="mt-3 grid grid-cols-3 gap-1.5">
      <ToolButton active={tool === "select"} label="Select" onClick={() => setTool("select")}><Cursor size={17} weight="bold" /></ToolButton>
      <ToolButton active={tool === "box"} label="Bounding box" onClick={() => setTool("box")}><BoundingBox size={17} /></ToolButton>
      <ToolButton active={tool === "pan"} label="Pan" onClick={() => setTool("pan")}><Hand size={17} /></ToolButton>
    </div>
    <div className="mt-2 grid grid-cols-2 gap-1.5">
      <ToolButton active={tool === "polygon"} label="Polygon" onClick={() => setTool("polygon")}><Pentagon size={15} /></ToolButton>
      <ToolButton active={tool === "circle"} label="Circle" onClick={() => setTool("circle")}><Circle size={15} /></ToolButton>
      <ToolButton active={tool === "point"} label="Point" onClick={() => setTool("point")}><MapPin size={15} /></ToolButton>
      <ToolButton active={tool === "polyline"} label="Polyline" onClick={() => setTool("polyline")}><LineSegment size={15} /></ToolButton>
      <button type="button" disabled title="Segmentation masks are read-only in this phase" className="rounded-lg border border-zinc-100 px-2 py-1.5 text-[10px] font-medium text-zinc-300">Mask (read-only)</button>
    </div>
  </>;
}

function ToolButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-label={label} aria-pressed={active} onClick={onClick} className={`grid min-h-12 place-items-center rounded-lg border transition-colors ${active ? "border-sky-500 bg-sky-50 text-sky-700" : "border-zinc-200 text-zinc-500 hover:bg-zinc-50"}`}>{children}<span className="sr-only">{label}</span></button>;
}
