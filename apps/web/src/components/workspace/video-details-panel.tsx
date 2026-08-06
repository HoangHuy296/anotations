"use client";

import type { SafeVideoAnnotations } from "@/types/video-annotation";

export function VideoDetailsPanel({ annotations }: { annotations: SafeVideoAnnotations }) {
  return <aside className="rounded-lg border border-zinc-800 bg-zinc-900/80 p-3 text-xs text-zinc-300" aria-label="Video annotation details">
    <h2 className="font-semibold text-zinc-100">Video details</h2>
    <dl className="mt-2 grid grid-cols-2 gap-2 text-zinc-400">
      <dt>Tracks</dt><dd className="text-right text-zinc-200">{annotations.tracks.length}</dd>
      <dt>Keyframes</dt><dd className="text-right text-zinc-200">{annotations.keyframes.length}</dd>
      <dt>Temporal labels</dt><dd className="text-right text-zinc-200">{annotations.temporalLabels.length}</dd>
    </dl>
  </aside>;
}
