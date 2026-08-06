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
 * keyframe at the playhead, save, and delete. Mirrors the image workspace's
 * `toolbar.tsx` structure/styling. All mutations remain owned by
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
    <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 bg-zinc-900 px-3 py-1.5 text-[11px]" aria-label="Video track controls">
      <button
        type="button"
        aria-label="Create track"
        onClick={onCreateTrack}
        className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-white"
      >
        <PlusCircle aria-hidden="true" size={16} /> Create track
      </button>
      <label className="inline-flex items-center gap-1 text-zinc-400">
        <VideoCamera aria-hidden="true" size={15} />
        <span className="sr-only">Select track</span>
        <select
          value={selectedTrackId ?? ""}
          onChange={(event) => onSelectTrack(event.target.value)}
          className="ml-1 h-8 max-w-40 rounded-lg border border-zinc-700 bg-zinc-800 px-2 text-zinc-200 outline-none"
        >
          <option value="">Select track</option>
          {tracks.map((track) => (
            <option key={track.id} value={track.id}>{track.label?.name ?? track.name ?? track.id.slice(0, 8)}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        aria-label="Add keyframe at current time"
        disabled={!canAddKeyframe}
        onClick={onAddKeyframeHere}
        className="rounded-lg border border-violet-700 px-2 py-1.5 font-semibold text-violet-200 enabled:hover:bg-violet-900/40 disabled:opacity-40"
      >
        Add keyframe here
      </button>
      <button
        type="button"
        aria-label="Save track"
        disabled={!canSaveTrack}
        onClick={onSaveTrack}
        className="inline-flex items-center gap-1 rounded-lg border border-emerald-700 px-2 py-1.5 font-semibold text-emerald-200 enabled:hover:bg-emerald-900/40 disabled:opacity-40"
      >
        <FloppyDisk aria-hidden="true" size={15} /> Save track
      </button>
      <button
        type="button"
        aria-label="Delete track"
        disabled={!canDeleteTrack}
        onClick={onDeleteTrack}
        className="inline-flex items-center gap-1 rounded-lg border border-rose-900 px-2 py-1.5 font-semibold text-rose-300 enabled:hover:bg-rose-950/40 disabled:opacity-40"
      >
        <TrashSimple aria-hidden="true" size={15} /> Delete track
      </button>
      {actionError ? <span role="alert" className="text-rose-300">{actionError}</span> : null}
    </div>
  );
}
