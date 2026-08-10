"use client";

import { BoundingBox, LinkIcon, Cursor, Hand, TextboxIcon, NotePencilIcon, HighlighterIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { useAnnotationStore } from "@/stores/image-annotation-store";

/**
 * Text's `DatasetSidebar` toolbox content. This is the pre-registry
 * `DatasetSidebar` tool-button markup, unchanged in behavior, moved here so
 * `workspace-engine-registry.ts` can reference it as the Text entry's
 * `Toolbox`. Dataset/asset navigation and "Open directory" stay in the
 * shared `DatasetSidebar` shell — they are engine-independent (FR-035).
 */
export function TextToolbox() {
  const tool = useAnnotationStore((store) => store.tool);
  const setTool = useAnnotationStore((store) => store.setTool);
  return <>
    <div className="mt-3 grid grid-cols-3 gap-1.5">
      <ToolButton active={tool === "select"} label="Select" onClick={() => setTool("select")}><Cursor size={17} weight="bold" /></ToolButton>
      <ToolButton active={tool === "box"} label="Bounding box" onClick={() => setTool("box")}><BoundingBox size={17} /></ToolButton>
      <ToolButton active={tool === "pan"} label="Pan" onClick={() => setTool("pan")}><Hand size={17} /></ToolButton>
    </div>
    <div className="mt-2 grid grid-cols-2 gap-1.5">
      <ToolButton active={tool === "highlightspan"} label="Highlight" onClick={() => setTool("highlightspan")}><HighlighterIcon size={15} /></ToolButton>
      <ToolButton active={tool === "relationtext"} label="Relation" onClick={() => setTool("relationtext")}><LinkIcon size={15} /></ToolButton>
      <ToolButton active={tool === "notetext"} label="Note" onClick={() => setTool("notetext")}><NotePencilIcon size={15} /></ToolButton>
      <ToolButton active={tool === "classificationtext"} label="Classification" onClick={() => setTool("classificationtext")}><TextboxIcon size={15} /></ToolButton>
    </div>
  </>;
}

function ToolButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-label={label} aria-pressed={active} onClick={onClick} className={`grid min-h-12 place-items-center rounded-lg border transition-colors ${active ? "border-sky-500 bg-sky-50 text-sky-700" : "border-zinc-200 text-zinc-500 hover:bg-zinc-50"}`}>{children}<span className="sr-only">{label}</span></button>;
}
