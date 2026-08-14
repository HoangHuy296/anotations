"use client";

import { MusicNotes, SpinnerGap } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import type { SafeMediaReadiness } from "@/types/media-processing";

type AudioEngineProps = { audio: { id: string; filename: string; description: string | null }; readiness: SafeMediaReadiness };

/**
 * Same shape as `canvas-stage.tsx`'s and `video-engine.tsx`'s private
 * `getViewUrl` for `GET /api/assets/{assetId}/view-url` -- a short-lived,
 * object-scoped MinIO presigned URL. Two guards, for two different problems:
 * - `cachedViewUrls` (TTL): re-visiting the same asset shortly after
 *   shouldn't re-request a presigned URL that's still valid.
 * - `inFlightViewUrls`: React 18 Strict Mode (development, intentionally
 *   left on) double-invokes every mount effect -- switching to an audio
 *   asset (e.g. `?audio={assetId}`) mounts a fresh `AudioEngine`, and
 *   without this its mount effect below fired this fetch twice, back-to-back,
 *   before either resolved. A caller that arrives mid-flight reuses that same
 *   pending request instead of starting a second one.
 */
const VIEW_URL_CACHE_MS = 4 * 60 * 1000;
const cachedViewUrls = new Map<string, { url: string; expiresAt: number }>();
const inFlightViewUrls = new Map<string, Promise<string>>();

async function getViewUrl(assetId: string): Promise<string> {
  const cached = cachedViewUrls.get(assetId);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const inFlight = inFlightViewUrls.get(assetId);
  if (inFlight) return inFlight;
  const request = (async () => {
    const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/view-url`, { credentials: "same-origin" });
    const payload = await response.json().catch(() => null) as { data?: { viewUrl?: unknown } } | null;
    if (!response.ok || typeof payload?.data?.viewUrl !== "string") throw new Error("unavailable");
    cachedViewUrls.set(assetId, { url: payload.data.viewUrl, expiresAt: Date.now() + VIEW_URL_CACHE_MS });
    return payload.data.viewUrl;
  })();
  inFlightViewUrls.set(assetId, request);
  try { return await request; } finally { inFlightViewUrls.delete(assetId); }
}

/** Safe read-only AUDIO workspace; waveform bytes/keys never reach the browser DTO. */
export function AudioEngine({ audio, readiness }: AudioEngineProps) {
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void getViewUrl(audio.id)
      .then((url) => { if (active) { setViewUrl(url); setLoading(false); } })
      .catch(() => { if (active) { setViewUrl(null); setLoading(false); } });
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
