"use client";

import { Pause, Play, PlusCircle, FloppyDisk, TrashSimple, VideoCamera } from "@phosphor-icons/react";
import type { SafeVideoAnnotations, SafeVideoTrack } from "@/types/video-annotation";
import { resolveVideoKeyframeDisplayState } from "@/lib/workspace/video-keyframe-state";

export type VideoToolbarProps = {
  // Transport (spec FR-047/US9). Every value/action here is a prop --
  // `video-engine.tsx` owns the playback controller, the video element ref,
  // and the `currentTime` state, and hands down only the data and callbacks
  // this component needs to render/trigger them. This component never
  // reaches into the video element, calls the playback controller, or
  // touches `useVideoAnnotationStore` itself.
  playbackState: "paused" | "playing";
  playbackDisabled: boolean;
  onTogglePlayback: () => void;
  onPreviousFrame: () => void;
  onNextFrame: () => void;
  currentTimeMs: number;
  durationMs: number | null;
  onSeek: (timestampMs: number) => void;
  hasTrackKeyframes: boolean;
  onPreviousKeyframe: () => void;
  onNextKeyframe: () => void;

  // Timeline visualization -- persisted keyframes, derived interpolation,
  // temporal labels, and the playhead, all positioned against `durationMs`.
  annotations: SafeVideoAnnotations;
  selectedKeyframeId: string | null;
  mutationState: "idle" | "saving" | "saved" | "conflict" | "error";
  onSelectKeyframe: (id: string) => void;
  onSelectDerived: (item: { trackId: string; timestampMs: number }) => void;

  // Track lifecycle: create, select, add a keyframe at the playhead, save,
  // delete. All mutations remain owned by `video-engine.tsx`'s autosave
  // coordinator; this component only surfaces intent through callbacks.
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
 * The VIDEO workspace's transport/timeline zone: play/pause, frame/keyframe
 * stepping, the scrub bar, the annotation-tick timeline (persisted
 * keyframes, derived interpolation, temporal labels, playhead), and track
 * lifecycle actions. This is the single file for that zone -- it used to be
 * split three ways (the transport row as inline JSX in `video-engine.tsx`,
 * the annotation-tick visualization in a standalone `video-timeline.tsx`,
 * and track lifecycle here) and is now one component, matching the
 * workspace's zone boundaries: `VideoEngine` = renderer + annotation
 * engine, `VideoToolbar` = transport/timeline, `PropertiesPanel` =
 * metadata/annotation properties, the workspace status surface = workspace
 * status.
 *
 * Owns no state and no business logic. Every value it renders and every
 * action it can trigger comes through props -- the playback controller, the
 * autosave coordinators, and every mutation stay owned by
 * `video-engine.tsx`, exactly as before the merge.
 */
export function VideoToolbar({
  playbackState,
  playbackDisabled,
  onTogglePlayback,
  onPreviousFrame,
  onNextFrame,
  currentTimeMs,
  durationMs,
  onSeek,
  hasTrackKeyframes,
  onPreviousKeyframe,
  onNextKeyframe,
  annotations,
  selectedKeyframeId,
  mutationState,
  onSelectKeyframe,
  onSelectDerived,
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
  const currentTimeSeconds = currentTimeMs / 1000;
  const durationSeconds = durationMs !== null ? durationMs / 1000 : null;
  return (
    <div className="mt-2 flex-none rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs text-zinc-300">
      <div className="flex items-center gap-2">
        <button type="button" title="Previous frame" aria-label="Previous frame" onClick={onPreviousFrame} className="rounded border border-zinc-700 px-1.5 py-1 text-[11px] hover:bg-zinc-800">⏮</button>
        <button type="button" title={playbackState === "playing" ? "Pause" : "Play"} aria-label={playbackState === "playing" ? "Pause" : "Play"} disabled={playbackDisabled} onClick={onTogglePlayback} className="rounded border border-zinc-700 px-1.5 py-1 text-[11px] hover:bg-zinc-800 disabled:opacity-40">
          {playbackState === "playing" ? <Pause size={12} weight="fill" /> : <Play size={12} weight="fill" />}
        </button>
        <button type="button" title="Next frame" aria-label="Next frame" onClick={onNextFrame} className="rounded border border-zinc-700 px-1.5 py-1 text-[11px] hover:bg-zinc-800">⏭</button>
        <span className="inline-flex items-center gap-1"><Play size={12} /> {currentTimeSeconds.toFixed(2)}s{durationSeconds !== null ? ` / ${durationSeconds.toFixed(2)}s` : ""}</span>
        <input aria-label="Video timeline" type="range" min={0} max={durationSeconds ?? 0} step={0.01} value={Math.min(currentTimeSeconds, durationSeconds ?? currentTimeSeconds)} disabled={!durationSeconds} onChange={(event) => onSeek(Number(event.target.value) * 1000)} className="ml-1 min-w-0 flex-1 accent-sky-500" />
        <button type="button" title="Previous keyframe" aria-label="Previous keyframe" disabled={!hasTrackKeyframes} onClick={onPreviousKeyframe} className="rounded border border-zinc-700 px-1.5 py-1 text-[11px] disabled:opacity-50">◀KF</button>
        <button type="button" title="Next keyframe" aria-label="Next keyframe" disabled={!hasTrackKeyframes} onClick={onNextKeyframe} className="rounded border border-zinc-700 px-1.5 py-1 text-[11px] disabled:opacity-50">KF▶</button>
      </div>
      <TimelineTrack annotations={annotations} durationMs={durationMs} currentTimeMs={currentTimeMs} selectedKeyframeId={selectedKeyframeId} mutationState={mutationState} onSelectKeyframe={onSelectKeyframe} onSelectDerived={onSelectDerived} onSeek={onSeek} />
      <div className="-mx-3 -mb-2 mt-2 flex flex-wrap items-center gap-1.5 border-t border-zinc-800 bg-zinc-900 px-3 py-1.5 text-[11px]" aria-label="Video track controls">
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

type TimelineTrackProps = {
  annotations: SafeVideoAnnotations;
  durationMs: number | null;
  currentTimeMs: number;
  selectedKeyframeId?: string | null;
  mutationState?: "idle" | "saving" | "saved" | "conflict" | "error";
  onSelectKeyframe?: (id: string) => void;
  onSelectDerived?: (item: { trackId: string; timestampMs: number }) => void;
  onSeek?: (timestampMs: number) => void;
};

/**
 * The annotation-tick/playhead visualization -- what `video-timeline.tsx`
 * used to export standalone, now internal to `VideoToolbar` and not
 * exported on its own. Its prop contract stays playback/selection only
 * (`onSelectKeyframe`/`onSelectDerived`/`onSeek`) -- it never exposes a
 * create, delete, or update annotation-mutation callback, so a timeline
 * click can never create, move, or delete an annotation.
 */
function TimelineTrack({ annotations, durationMs, currentTimeMs, selectedKeyframeId = null, mutationState = "idle", onSelectKeyframe, onSelectDerived, onSeek }: TimelineTrackProps) {
  const duration = durationMs && durationMs > 0 ? durationMs : null;
  const percentOf = (ms: number) => Math.min(100, Math.max(0, (ms / (duration ?? 1)) * 100));
  return <div className="mt-2" aria-label="Video annotation timeline">
    <div
      className="relative h-5 rounded bg-zinc-800"
      onClick={(event) => {
        if (!duration || !onSeek) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0;
        onSeek(Math.round(ratio * duration));
      }}
    >
      {duration ? annotations.keyframes.map((keyframe) => {
        const active = keyframe.id === selectedKeyframeId;
        const state = resolveVideoKeyframeDisplayState({ hasPersistedKeyframe: true, hasDerivedInterpolation: false, hasUnsavedDraft: false, mutationState: active ? mutationState : "idle" });
        return <button
          type="button"
          key={keyframe.id}
          title={`Persisted keyframe ${keyframe.timestampMs}ms`}
          aria-label={`Persisted keyframe at ${keyframe.timestampMs} milliseconds`}
          aria-pressed={active}
          onClick={(event) => { event.stopPropagation(); onSelectKeyframe?.(keyframe.id); }}
          className={`absolute top-1 h-3 w-1 rounded hover:bg-white ${state === "conflict" ? "bg-amber-400 ring-2 ring-amber-300" : active ? "bg-white" : "bg-sky-400"}`}
          style={{ left: `${percentOf(keyframe.timestampMs)}%` }}
        />;
      }) : null}
      {duration ? annotations.interpolation.map((item) => <button
        type="button"
        key={`derived-${item.trackId}-${item.timestampMs}`}
        title={`Derived interpolation ${item.timestampMs}ms -- select to seek exactly here`}
        aria-label={`Derived interpolation at ${item.timestampMs} milliseconds`}
        onClick={(event) => { event.stopPropagation(); onSelectDerived?.({ trackId: item.trackId, timestampMs: item.timestampMs }); }}
        className="absolute top-1 h-3 w-1 rounded border border-dashed border-violet-300 bg-violet-500/50 hover:bg-violet-400"
        style={{ left: `${percentOf(item.timestampMs)}%` }}
      />) : null}
      {duration ? annotations.temporalLabels.map((label) => <span key={label.id} title={label.type} aria-hidden="true" className="absolute bottom-0 h-1 rounded bg-amber-400/80" style={{ left: `${percentOf(label.startMs)}%`, width: `${Math.min(100, Math.max(0, (label.endMs - label.startMs) / (duration ?? 1) * 100))}%` }} />) : null}
      {duration ? <span aria-hidden="true" className="absolute top-0 h-5 w-0.5 bg-amber-300" style={{ left: `${percentOf(currentTimeMs)}%` }} /> : null}
    </div>
  </div>;
}
