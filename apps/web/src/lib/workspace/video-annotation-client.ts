"use client";

import type { DerivedVideoInterpolation, SafeVideoKeyframe, SafeVideoTemporalLabel, SafeVideoTrack, VideoBoundingBox } from "@/types/video-annotation";

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

export function createVideoTrack(assetId: string, input: { labelId?: string | null; name?: string; interpolationMode?: "LINEAR" | "NONE" }) {
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

export function updateVideoKeyframe(annotationId: string, input: { expectedTrackRevision: number; timestampMs?: number; geometry?: VideoBoundingBox; properties?: Record<string, unknown> }) {
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
