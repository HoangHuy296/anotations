"use client";

import { FileAudioIcon, SpeakerHigh, StampIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { audioToolGate } from "@/lib/workspace/audio-tool-capabilities";
import type { AudioAnnotationTool } from "@/types/annotation";

/**
 * Audio's `DatasetSidebar` toolbox content. This is the pre-registry
 * `DatasetSidebar` tool-button markup, unchanged in behavior, moved here so
 * `workspace-engine-registry.ts` can reference it as the Audio entry's
 * `Toolbox`. Dataset/asset navigation and "Open directory" stay in the
 * shared `DatasetSidebar` shell — they are engine-independent (FR-035).
 */
export function AudioToolbox() {
  return <>
    <p role="note" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] leading-4 text-amber-900">Playback and properties only. AUDIO annotation tools are not available in this phase.</p>
    <div className="mt-3 grid grid-cols-3 gap-1.5">
      <GatedTool tool="timesegmentaudio" label="Time Segment"><FileAudioIcon size={17} /></GatedTool>
      <GatedTool tool="timestampaudio" label="Timestamp Label"><StampIcon size={15} /></GatedTool>
      <GatedTool tool="speakerlabel" label="Speaker"><SpeakerHigh size={15} /></GatedTool>
    </div>
    <div className="mt-2 grid grid-cols-2 gap-1.5">
      <button type="button" disabled title="Segmentation masks are read-only in this phase" className="rounded-lg border border-zinc-100 px-2 py-1.5 text-[10px] font-medium text-zinc-300">Mask (read-only)</button>
      <button type="button" disabled title="Segmentation masks are read-only in this phase" className="rounded-lg border border-zinc-100 px-2 py-1.5 text-[10px] font-medium text-zinc-300">Mask (read-only)</button>
    </div>
  </>;
}

/** An annotation tool whose capability is gated: rendered disabled with the accurate reason, with no handler, so it can neither change tool state nor start a write. */
function GatedTool({ tool, label, children }: { tool: AudioAnnotationTool; label: string; children: ReactNode }) {
  const gate = audioToolGate(tool);
  return <button type="button" title={gate.reason ?? label} aria-label={label} aria-disabled={gate.disabled} disabled={gate.disabled} className="grid min-h-12 cursor-not-allowed place-items-center rounded-lg border border-zinc-100 text-zinc-300">{children}</button>;
}
