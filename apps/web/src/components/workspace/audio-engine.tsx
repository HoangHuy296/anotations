"use client";

import { MusicNotes, SpinnerGap } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import type { SafeMediaReadiness } from "@/types/media-processing";

type AudioEngineProps = { audio: { id: string; filename: string; description: string | null }; readiness: SafeMediaReadiness };

/** Safe read-only AUDIO workspace; waveform bytes/keys never reach the browser DTO. */
export function AudioEngine({ audio, readiness }: AudioEngineProps) {
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void fetch(`/api/assets/${encodeURIComponent(audio.id)}/view-url`, { credentials: "same-origin" })
      .then(async (response) => response.ok ? response.json() : null)
      .then((payload: { data?: { viewUrl?: unknown } } | null) => {
        if (!active) return;
        setViewUrl(typeof payload?.data?.viewUrl === "string" ? payload.data.viewUrl : null);
        setLoading(false);
      })
      .catch(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [audio.id]);
  return <section className="canvas-grid flex min-h-[520px] min-w-0 flex-col items-center justify-center bg-zinc-950 px-6 text-center text-zinc-100 lg:min-h-0">
    <MusicNotes className="text-violet-300" size={34} weight="duotone" />
    <h2 className="mt-3 text-sm font-semibold">Audio workspace</h2>
    <p className="mt-1 text-xs text-zinc-400">{audio.filename} · {readiness.state.replaceAll("_", " ")}</p>
    {loading ? <SpinnerGap className="mt-5 animate-spin text-sky-400" size={20} /> : viewUrl ? <audio className="mt-5 w-full max-w-lg" controls src={viewUrl} /> : <p className="mt-5 text-xs text-zinc-500">Audio preview is unavailable.</p>}
    <p className="mt-5 max-w-md text-xs leading-5 text-zinc-500">Waveform readiness: {readiness.audio?.waveformReady ? "ready" : "processing or not requested"}. Audio annotation editing is intentionally unavailable in this phase.</p>
  </section>;
}
