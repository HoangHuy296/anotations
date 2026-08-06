"use client";

import { BoundingBox, Circle, Cursor, FolderOpen, Hand, LineSegment, MapPin, Pentagon } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";
import { useState } from "react";

import { useAnnotationStore } from "@/stores/annotation-store";
import { flushVideoAutosaves, hasVideoAutosaveConflict } from "@/lib/workspace/video-autosave";
import { WorkspaceAppendFolderDialog } from "@/components/imports/local-folder-import-form";
import type { Modality } from "@internal/db";

type DatasetSidebarProps = {
  datasetId: string;
  datasetName?: string;
  selectedAssetId: string | null;
  search: string;
  statuses: string[];
  page: number;
  previous: { id: string; modality: Modality; page: number } | null;
  next: { id: string; modality: Modality; page: number } | null;
};

/** Toolbox only. Asset discovery, filtering, and pagination live in the right sidebar. */
export function DatasetSidebar({ datasetId, datasetName, search, statuses, previous, next }: DatasetSidebarProps) {
  const router = useRouter();
  const tool = useAnnotationStore((store) => store.tool);
  const setTool = useAnnotationStore((store) => store.setTool);
  const flushAllAutosaves = useAnnotationStore((store) => store.flushAllAutosaves);
  const [appendOpen, setAppendOpen] = useState(false);
  const hrefFor = (target: { id: string; modality: Modality; page: number }) => {
    const params = new URLSearchParams({ [target.modality.toLowerCase()]: target.id });
    if (search) params.set("q", search);
    for (const status of statuses) params.append("status", status);
    if (target.page > 1) params.set("page", String(target.page));
    return `/workspace/${datasetId}?${params.toString()}`;
  };
  const guardNavigation = async (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    event.preventDefault();
    await flushAllAutosaves();
    await flushVideoAutosaves();
    const states = Object.values(useAnnotationStore.getState().saveStates);
    const needsResolution = states.some((state) => state === "failed" || state === "conflict") || hasVideoAutosaveConflict();
    if (needsResolution && !window.confirm("An image edit could not be saved or has a conflict. Discard the local draft and leave this asset?")) return;
    router.push(href);
  };

  return <aside className="min-h-0 border-r border-zinc-200 bg-white p-3" aria-label="Image annotation tools">
    <div className="flex items-center justify-between"><p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-400">Toolbox</p><span className="text-[10px] font-semibold text-sky-700">Image</span></div>
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
    <button type="button" onClick={() => setAppendOpen(true)} className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"><FolderOpen size={15} />Open directory</button>
    <div className="mt-2 grid grid-cols-2 gap-1.5"><AssetNavigation href={previous ? hrefFor(previous) : null} label="Previous" onNavigate={guardNavigation} /><AssetNavigation href={next ? hrefFor(next) : null} label="Next" onNavigate={guardNavigation} /></div>
    {appendOpen && <WorkspaceAppendFolderDialog datasetId={datasetId} datasetName={datasetName} onClose={() => setAppendOpen(false)} />}
  </aside>;
}

function ToolButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-label={label} aria-pressed={active} onClick={onClick} className={`grid min-h-12 place-items-center rounded-lg border transition-colors ${active ? "border-sky-500 bg-sky-50 text-sky-700" : "border-zinc-200 text-zinc-500 hover:bg-zinc-50"}`}>{children}<span className="sr-only">{label}</span></button>;
}

function AssetNavigation({ href, label, onNavigate }: { href: string | null; label: string; onNavigate: (event: MouseEvent<HTMLAnchorElement>, href: string) => void | Promise<void> }) {
  return href ? <Link href={href} onClick={(event) => { void onNavigate(event, href); }} className="rounded-lg border border-zinc-200 px-2 py-1.5 text-center text-[10px] font-semibold text-zinc-700 hover:bg-zinc-50">{label}</Link> : <span className="rounded-lg border border-zinc-100 px-2 py-1.5 text-center text-[10px] font-semibold text-zinc-300">{label}</span>;
}
