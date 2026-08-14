"use client";

import { FolderOpen } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import { useState } from "react";

import { useAnnotationStore } from "@/stores/image-annotation-store";
import { flushVideoAutosaves, hasVideoAutosaveConflict } from "@/lib/workspace/video-autosave";
import { workspaceEngineRegistry } from "@/lib/workspace/workspace-engine-registry";
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
  /** The active selection's engine, or `null` when no asset is selected (defaults to the IMAGE toolbox). */
  engine: Modality | null;
};

const engineLabel: Record<Modality, string> = { IMAGE: "Image", VIDEO: "Video", AUDIO: "Audio", TEXT: "Text" };

/**
 * Toolbox only. Asset discovery, filtering, and pagination live in the right
 * sidebar. The toolbox region itself is sourced from `workspaceEngineRegistry`
 * (spec FR-035, FR-041–FR-044) — this component does not branch on modality
 * beyond that one lookup.
 */
export function DatasetSidebar({ datasetId, datasetName, selectedAssetId, search, statuses, previous, next, engine }: DatasetSidebarProps) {
  const router = useRouter();
  const flushAllAutosaves = useAnnotationStore((store) => store.flushAllAutosaves);
  const [appendOpen, setAppendOpen] = useState(false);
  const activeEngine = engine ?? "IMAGE";
  const { Toolbox } = workspaceEngineRegistry[activeEngine];
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

  return <aside className="min-h-0 border-r border-zinc-200 bg-white p-3" aria-label={`${engineLabel[activeEngine]} annotation tools`}>
    <div className="flex items-center justify-between"><p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-400">Toolbox</p><span className="text-[10px] font-semibold text-sky-700">{engineLabel[activeEngine]}</span></div>
    <Toolbox />
    <button type="button" onClick={() => setAppendOpen(true)} className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"><FolderOpen size={15} />Open directory</button>
    <div className="mt-2 grid grid-cols-2 gap-1.5"><AssetNavigation href={previous ? hrefFor(previous) : null} label="Previous" onNavigate={guardNavigation} /><AssetNavigation href={next ? hrefFor(next) : null} label="Next" onNavigate={guardNavigation} /></div>
    {appendOpen && <WorkspaceAppendFolderDialog datasetId={datasetId} datasetName={datasetName} onClose={() => setAppendOpen(false)} />}
  </aside>;
}

function AssetNavigation({ href, label, onNavigate }: { href: string | null; label: string; onNavigate: (event: MouseEvent<HTMLAnchorElement>, href: string) => void | Promise<void> }) {
  return href ? <Link href={href} onClick={(event) => { void onNavigate(event, href); }} className="rounded-lg border border-zinc-200 px-2 py-1.5 text-center text-[10px] font-semibold text-zinc-700 hover:bg-zinc-50">{label}</Link> : <span className="rounded-lg border border-zinc-100 px-2 py-1.5 text-center text-[10px] font-semibold text-zinc-300">{label}</span>;
}
