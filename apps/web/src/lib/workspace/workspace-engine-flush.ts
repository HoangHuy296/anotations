"use client";

import { flushTextAnnotationCommands } from "@/lib/annotations/text-annotation-client";
import { useAnnotationStore } from "@/stores/image-annotation-store";
import { flushVideoAutosaves, hasVideoAutosaveConflict } from "@/lib/workspace/video-autosave";

/**
 * The active-engine save barrier every navigation/workflow caller must await
 * before reading "the current asset revision" (data-model.md "Workflow and
 * client state"): dirty work finishes first, then — and only on success —
 * the caller gets the server-authoritative revision. A read failure never
 * counts as a successful flush. This fixes a real, pre-existing gap: prior
 * callers fired both flush functions and immediately reused a stale
 * page-load revision prop, so a Submit right after an autosaved edit could
 * spuriously 409 with "this asset changed" against the user's own edit.
 */
export type EngineFlushResult = { ok: true; assetRevision: number } | { ok: false; reason: string };

async function fetchCurrentAssetRevision(datasetId: string, assetId: string): Promise<number | null> {
  try {
    const response = await fetch(`/api/datasets/${datasetId}/assets/${assetId}/workflow`, { credentials: "same-origin", cache: "no-store" });
    const payload = await response.json().catch(() => null) as { data?: { asset?: { revision?: unknown } } } | null;
    const revision = payload?.data?.asset?.revision;
    return response.ok && typeof revision === "number" ? revision : null;
  } catch {
    return null;
  }
}

/** Every engine currently shares this generic property/geometry autosave registry (despite its historical "image" name). */
async function flushGenericAutosaves(): Promise<boolean> {
  const results = await useAnnotationStore.getState().flushAllAutosaves();
  return Object.values(results).every((result) => result === "saved" || result === "idle");
}

/**
 * `includeVideoTrackAutosave` is true only for the VIDEO engine, which also
 * has its own dedicated track/keyframe autosave coordinator distinct from
 * the generic property registry above.
 */
export function createEngineFlush(includeVideoTrackAutosave: boolean, includeTextCommands = false) {
  return async function flush(datasetId: string, assetId: string): Promise<EngineFlushResult> {
    const textOk = !includeTextCommands || await flushTextAnnotationCommands(assetId);
    const genericOk = await flushGenericAutosaves();
    let videoOk = true;
    if (includeVideoTrackAutosave) {
      await flushVideoAutosaves();
      videoOk = !hasVideoAutosaveConflict();
    }
    if (!textOk || !genericOk || !videoOk) return { ok: false, reason: "SAVE_FAILED" };
    const assetRevision = await fetchCurrentAssetRevision(datasetId, assetId);
    return assetRevision === null ? { ok: false, reason: "REVISION_UNAVAILABLE" } : { ok: true, assetRevision };
  };
}
