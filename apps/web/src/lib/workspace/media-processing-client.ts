"use client";

import type { SafeMediaReadiness } from "@/types/media-processing";

/**
 * Browser client for the Phase 018 per-Asset media-processing boundary. A VIDEO/AUDIO Asset has no probed metadata (fps, duration, waveform) until its
 * processing request exists, so the workspace engines request it once when an Asset opens and then wait for the durable Job to finish. This file is
 * HTTP plumbing only: the server owns authorization, idempotency (one request per Asset and source revision) and the safe projection.
 */
export type MediaProcessingKind = "VIDEO" | "AUDIO";
export const MEDIA_PROCESSING_JOB_TYPE = { VIDEO: "EXTRACT_VIDEO_METADATA", AUDIO: "GENERATE_AUDIO_WAVEFORM" } as const;
const TERMINAL: ReadonlySet<SafeMediaReadiness["state"]> = new Set(["COMPLETED", "FAILED", "CANCELED"]);

/** Only an Asset that has never been requested needs a new request; a queued/running one is already in flight. */
export function shouldRequestMediaProcessing(state: SafeMediaReadiness["state"]) { return state === "NOT_REQUESTED"; }
/** Any non-terminal state is worth waiting on so the engine can pick up the probed metadata. */
export function shouldAwaitMediaProcessing(state: SafeMediaReadiness["state"]) { return !TERMINAL.has(state); }

export async function requestMediaProcessing(assetId: string, kind: MediaProcessingKind, signal?: AbortSignal): Promise<boolean> {
  const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/media-processing`, {
    method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ type: MEDIA_PROCESSING_JOB_TYPE[kind] }),
  });
  return response.ok; // 403/422 (no upload permission, ineligible source) simply leaves the Asset unprocessed, exactly as before
}

export async function readMediaProcessingState(assetId: string, signal?: AbortSignal): Promise<SafeMediaReadiness["state"] | null> {
  const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/media-processing/status`, { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as { data?: { state?: SafeMediaReadiness["state"] } } | null;
  return body?.data?.state ?? null;
}

/** Polls until a terminal state, the attempt budget is spent, or the caller aborts. Returns the last observed state. */
export async function waitForMediaProcessing(assetId: string, signal: AbortSignal, intervalMs = 1500, attempts = 80): Promise<SafeMediaReadiness["state"] | null> {
  let last: SafeMediaReadiness["state"] | null = null;
  for (let index = 0; index < attempts && !signal.aborted; index += 1) {
    await new Promise<void>((resolve) => { const timer = setTimeout(resolve, intervalMs); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
    if (signal.aborted) break;
    try { last = await readMediaProcessingState(assetId, signal) ?? last; } catch { /* transient: keep waiting */ }
    if (last && TERMINAL.has(last)) return last;
  }
  return last;
}
