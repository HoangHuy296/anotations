"use client";

import type { SafeVideoAnnotations } from "@/types/video-annotation";
import { resolveVideoKeyframeDisplayState } from "@/lib/workspace/video-keyframe-state";

type VideoTimelineProps = {
  annotations: SafeVideoAnnotations;
  durationMs: number | null;
  currentTimeMs: number;
  selectedKeyframeId?: string | null;
  mutationState?: "idle" | "saving" | "saved" | "conflict" | "error";
  onSelectKeyframe?: (id: string) => void;
  onSelectDerived?: (item: { trackId: string; timestampMs: number }) => void;
  onSeek?: (timestampMs: number) => void;
};

export function VideoTimeline({ annotations, durationMs, currentTimeMs, selectedKeyframeId = null, mutationState = "idle", onSelectKeyframe, onSelectDerived, onSeek }: VideoTimelineProps) {
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
