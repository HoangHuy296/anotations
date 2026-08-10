"use client";

import { PlusCircle, FloppyDisk, TrashSimple, VideoCamera } from "@phosphor-icons/react";
import type { SafeVideoTrack } from "@/types/video-annotation";

type VideoToolbarProps = {
  tracks: SafeVideoTrack[];
  selectedTrackId: string | null;
  onSelectTrack: (trackId: string) => void;
  onCreateTrack: () => void;
  onAddKeyframeHere: () => void;
  onSaveTrack: () => void;
  onDeleteTrack: () => void;
  canAddKeyframe: boolean;
  canSaveTrack: boolean;
  canDeleteTrack: boolean;
  actionError: string | null;
};

/**
 * Track-level action controls for the video workspace: create, select, add a
 * keyframe at the playhead, save, and delete. Icon-first and single-row so
 * it stays a thin strip under the frame instead of competing with it for
 * height. Same prop contract as before -- all mutations remain owned by
 * `video-engine.tsx`'s autosave coordinator; this component only surfaces
 * intent through callbacks and never writes state itself.
 */
export function VideoToolbar({
  tracks,
  selectedTrackId,
  onSelectTrack,
  onCreateTrack,
  onAddKeyframeHere,
  onSaveTrack,
  onDeleteTrack,
  canAddKeyframe,
  canSaveTrack,
  canDeleteTrack,
  actionError,
}: VideoToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-zinc-800 bg-zinc-900 px-3 py-1.5 text-[11px]" aria-label="Video track controls">
      <IconButton label="Create track" onClick={onCreateTrack} tone="neutral"><PlusCircle size={16} /></IconButton>
      <label className="inline-flex items-center gap-1 text-zinc-400">
        <VideoCamera aria-hidden="true" size={14} />
        <span className="sr-only">Select track</span>
        <select
          value={selectedTrackId ?? ""}
          onChange={(event) => onSelectTrack(event.target.value)}
          className="h-8 max-w-36 rounded-lg border border-zinc-700 bg-zinc-800 px-2 text-zinc-200 outline-none"
        >
          <option value="">No track</option>
          {tracks.map((track) => (
            <option key={track.id} value={track.id}>{track.label?.name ?? track.name ?? track.id.slice(0, 8)}</option>
          ))}
        </select>
      </label>
      <span className="mx-0.5 h-5 w-px bg-zinc-800" aria-hidden="true" />
      <IconButton label="Add keyframe at current time" onClick={onAddKeyframeHere} disabled={!canAddKeyframe} tone="violet">KF</IconButton>
      <IconButton label="Save track" onClick={onSaveTrack} disabled={!canSaveTrack} tone="emerald"><FloppyDisk size={15} /></IconButton>
      <IconButton label="Delete track" onClick={onDeleteTrack} disabled={!canDeleteTrack} tone="rose"><TrashSimple size={15} /></IconButton>
      {actionError ? <span role="alert" className="text-rose-300">{actionError}</span> : null}
    </div>
  );
}

const tones = {
  neutral: "text-zinc-300 hover:bg-zinc-800 hover:text-white",
  violet: "border border-violet-700 text-violet-200 enabled:hover:bg-violet-900/40",
  emerald: "border border-emerald-700 text-emerald-200 enabled:hover:bg-emerald-900/40",
  rose: "border border-rose-900 text-rose-300 enabled:hover:bg-rose-950/40",
} as const;

function IconButton({ label, onClick, disabled, tone, children }: { label: string; onClick: () => void; disabled?: boolean; tone: keyof typeof tones; children: React.ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className={`inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg px-2 font-semibold disabled:opacity-40 ${tones[tone]}`}>
      {children}
    </button>
  );
}
