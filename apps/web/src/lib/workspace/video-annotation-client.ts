"use client";

import type { DerivedVideoInterpolation, SafeVideoAnnotations, SafeVideoKeyframe, SafeVideoTemporalLabel, SafeVideoTrack, VideoBoundingBox } from "@/types/video-annotation";
import { VIDEO_ANNOTATION_LIMITS } from "@/lib/annotations/video-limits";

type MutationResponse<T> = { data: T } | { error: { code: string; message: string } };

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "same-origin", headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = await response.json() as MutationResponse<T>;
  if (!response.ok || !("data" in body)) throw Object.assign(new Error("Video annotation mutation failed."), { code: "error" in body ? body.error.code : "REQUEST_FAILED", status: response.status });
  return body.data;
}

export function createVideoKeyframe(trackId: string, input: { expectedTrackRevision: number; timestampMs: number; geometry: VideoBoundingBox; properties?: Record<string, unknown> }) {
  return request<{ keyframe: SafeVideoKeyframe; track: SafeVideoTrack }>(`/api/video-object-tracks/${encodeURIComponent(trackId)}/keyframes`, { method: "POST", body: JSON.stringify(input) });
}

export function createVideoTrack(assetId: string, input: { labelId?: string | null; name?: string; interpolationMode?: "LINEAR" | "NONE"; properties?: Record<string, unknown> }) {
  return request<{ track: SafeVideoTrack }>(`/api/assets/${encodeURIComponent(assetId)}/video-object-tracks`, { method: "POST", body: JSON.stringify(input) });
}

export function updateVideoTrack(trackId: string, input: { expectedTrackRevision: number; labelId?: string | null; name?: string; interpolationMode?: "LINEAR" | "NONE"; properties?: Record<string, unknown> }) {
  return request<{ track: SafeVideoTrack }>(`/api/video-object-tracks/${encodeURIComponent(trackId)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteVideoTrack(trackId: string, expectedTrackRevision: number) {
  return request<{ deleted: boolean }>(`/api/video-object-tracks/${encodeURIComponent(trackId)}`, { method: "DELETE", body: JSON.stringify({ expectedTrackRevision }) });
}

export function addKeyframeHere(trackId: string, draft: DerivedVideoInterpolation, expectedTrackRevision: number) {
  return createVideoKeyframe(trackId, { expectedTrackRevision, timestampMs: draft.timestampMs, geometry: { kind: "BOUNDING_BOX", x: draft.x, y: draft.y, width: draft.width, height: draft.height } });
}

export function updateVideoKeyframe(annotationId: string, input: { expectedTrackRevision: number; timestampMs?: number; geometry?: VideoBoundingBox; properties?: Record<string, unknown>; labelId?: string | null }) {
  return request<{ keyframe: SafeVideoKeyframe; track: SafeVideoTrack }>(`/api/video-keyframes/${encodeURIComponent(annotationId)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteVideoKeyframe(annotationId: string, expectedTrackRevision: number) {
  return request<{ track: SafeVideoTrack }>(`/api/video-keyframes/${encodeURIComponent(annotationId)}`, { method: "DELETE", body: JSON.stringify({ expectedTrackRevision }) });
}

export function createVideoTemporalLabel(assetId: string, input: { type: "EVENT" | "SCENE" | "SHOT_BOUNDARY"; labelId?: string | null; startMs: number; endMs: number; properties?: Record<string, unknown> }) {
  return request<{ temporalLabel: SafeVideoTemporalLabel }>(`/api/assets/${encodeURIComponent(assetId)}/temporal-labels`, { method: "POST", body: JSON.stringify(input) });
}

export function updateVideoTemporalLabel(annotationId: string, input: { expectedRevision: number; labelId?: string | null; startMs?: number; endMs?: number; properties?: Record<string, unknown> }) {
  return request<{ temporalLabel: SafeVideoTemporalLabel }>(`/api/temporal-labels/${encodeURIComponent(annotationId)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteVideoTemporalLabel(annotationId: string, expectedRevision: number) {
  return request<null>(`/api/temporal-labels/${encodeURIComponent(annotationId)}`, { method: "DELETE", body: JSON.stringify({ expectedRevision }) });
}

/** One raw HTTP page -- `hasMore`/`nextCursor` are the server's own, unmassaged. Most callers want `readVideoAnnotationsClient` below instead, which follows every page for them. */
export function readVideoAnnotationsPageClient(assetId: string, window?: { fromMs: number; toMs: number }, cursor?: string) {
  const params = new URLSearchParams();
  if (window) { params.set("fromMs", String(Math.round(window.fromMs))); params.set("toMs", String(Math.round(window.toMs))); }
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return request<SafeVideoAnnotations>(`/api/assets/${encodeURIComponent(assetId)}/video-annotations${query ? `?${query}` : ""}`, { method: "GET", cache: "no-store" });
}

// Defensive only: a real window's page count is bounded by its span and
// realistic keyframe density, nowhere near this. Exists so a server-side
// pagination bug (hasMore stuck true forever) surfaces as a thrown error
// instead of an infinite fetch loop.
const MAX_PAGES_PER_WINDOW = 500;

/**
 * Fetches every page of one `[fromMs, toMs]` window and merges them (deduped
 * by id) into a single, *complete* `SafeVideoAnnotations` -- the returned
 * Promise never resolves on a partial page; `hasMore` on the result is
 * always `false`. `interpolation` is carried from the first page only (the
 * one point-in-time sample the service computes there, see
 * `video-read-service.ts`); every other page-varying field reflects the
 * last page fetched, but `totalTracksInWindow`/`totalKeyframesInWindow`/
 * `effectiveFromMs`/`effectiveToMs` are pagination-independent so they're
 * identical on every page regardless.
 */
export async function readVideoAnnotationsClient(assetId: string, window?: { fromMs: number; toMs: number }): Promise<SafeVideoAnnotations> {
  const tracks = new Map<string, SafeVideoTrack>();
  const keyframes = new Map<string, SafeVideoKeyframe>();
  let cursor: string | undefined;
  let firstPage: SafeVideoAnnotations | null = null;
  let page: SafeVideoAnnotations;
  let pageCount = 0;
  do {
    if (pageCount >= MAX_PAGES_PER_WINDOW) throw new Error("Video annotation window exceeded the page-count safety limit -- this indicates a server-side pagination bug, not a real window size.");
    page = await readVideoAnnotationsPageClient(assetId, window, cursor);
    firstPage ??= page;
    for (const track of page.tracks) tracks.set(track.id, track);
    for (const keyframe of page.keyframes) keyframes.set(keyframe.id, keyframe);
    cursor = page.nextCursor ?? undefined;
    pageCount++;
  } while (page.hasMore);
  return { ...page, tracks: [...tracks.values()], keyframes: [...keyframes.values()], interpolation: firstPage.interpolation, nextCursor: null, hasMore: false };
}

/**
 * Pages sequentially through the whole asset in bounded `maxWindowMs` spans,
 * each span itself fully paginated via `readVideoAnnotationsClient`, and
 * merges the results, deduped by id. Used only where "somewhere in this
 * video" genuinely means the whole duration -- today just
 * `VideoEngine.applyAiResults`, since a completed AI task's tracks can land
 * anywhere on the timeline, not just the currently-loaded window, and a
 * single `maxWindowMs` chunk on a heavily-reused asset can itself hold more
 * than one page's worth of keyframes. Every individual HTTP request stays a
 * bounded, server-validated window/page; this never asks the server for an
 * unbounded read.
 */
export async function readVideoAnnotationsAcrossDurationClient(assetId: string, durationMs: number): Promise<{ tracks: SafeVideoTrack[]; keyframes: SafeVideoKeyframe[] }> {
  const span = VIDEO_ANNOTATION_LIMITS.maxWindowMs;
  const tracks = new Map<string, SafeVideoTrack>();
  const keyframes = new Map<string, SafeVideoKeyframe>();
  const bound = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : span;
  for (let fromMs = 0; fromMs < bound; fromMs += span) {
    const toMs = Math.min(fromMs + span, bound);
    const chunk = await readVideoAnnotationsClient(assetId, { fromMs, toMs: Math.max(toMs, fromMs + 1) });
    for (const track of chunk.tracks) tracks.set(track.id, track);
    for (const keyframe of chunk.keyframes) keyframes.set(keyframe.id, keyframe);
  }
  return { tracks: [...tracks.values()], keyframes: [...keyframes.values()] };
}
