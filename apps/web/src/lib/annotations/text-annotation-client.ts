"use client";

import type { SafeTextAnnotation } from "@annotationplatform/domain/text-annotation-contract";

/**
 * Browser client for `POST /api/assets/{assetId}/text/annotations`
 * (`submitTextAnnotationCommand`, text-span-service.ts). One thin wrapper
 * shared by every command kind (createSpan/updateSpan/deleteAnnotation/
 * createRelation) -- the envelope shape is identical across all of them,
 * only `command` differs, so callers just pass the whole envelope through.
 */

export type TextAnnotationCommandEnvelope = {
  operationId: string;
  sourceIdentity: string;
  expectedPolicyRevision: number;
  command: Record<string, unknown>;
};

export type TextAnnotationCommandOutcome<T> =
  | { ok: true; replayed: boolean; result: T }
  | { ok: false; status: number; code?: string; reason?: string };

const CREATE_COMMAND_KINDS = new Set(["createSpan", "createRelation"]);

async function requestTextAnnotationCommand<T = SafeTextAnnotation | { deletedId: string }>(assetId: string, envelope: TextAnnotationCommandEnvelope): Promise<TextAnnotationCommandOutcome<T>> {
  const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/text/annotations`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  const payload = await response.json().catch(() => null) as { data?: Record<string, unknown> } | { error?: { code?: string; reason?: unknown } } | null;
  if (!response.ok || !payload || !("data" in payload) || !payload.data) {
    const errorPayload = payload && "error" in payload ? payload.error : undefined;
    return { ok: false, status: response.status, code: errorPayload?.code, reason: typeof errorPayload?.reason === "string" ? errorPayload.reason : undefined };
  }
  // The route's response body is the bare result (annotation or
  // `{deletedId}`) -- `replayed` only ever affects the HTTP status (201 vs
  // 200), it is never a JSON field. For a create-kind command, 200 means
  // "an earlier identical operationId already committed this" (replay);
  // update/delete always answer 200 either way, so `replayed` is
  // meaningless for them and reported `false`.
  const replayed = CREATE_COMMAND_KINDS.has(String(envelope.command.kind)) && response.status !== 201;
  return { ok: true, replayed, result: payload.data as T };
}

// In-flight requests are a navigation/workflow barrier, never annotation authority.
const pending = new Map<string, Set<Promise<TextAnnotationCommandOutcome<unknown>>>>();
export async function submitTextAnnotationCommand<T = SafeTextAnnotation | { deletedId: string }>(assetId: string, envelope: TextAnnotationCommandEnvelope): Promise<TextAnnotationCommandOutcome<T>> {
  const request = requestTextAnnotationCommand<T>(assetId, envelope).catch((): TextAnnotationCommandOutcome<T> => ({ ok: false, status: 0, reason: "Connection failed. Reload to check whether the annotation was saved before retrying." }));
  const requests = pending.get(assetId) ?? new Set();
  requests.add(request);
  pending.set(assetId, requests);
  try { return await request; }
  finally { requests.delete(request); if (!requests.size) pending.delete(assetId); }
}

export async function flushTextAnnotationCommands(assetId: string): Promise<boolean> {
  let ok = true;
  while (pending.get(assetId)?.size) {
    const results = await Promise.all([...pending.get(assetId)!]);
    ok = results.every((result) => result.ok) && ok;
  }
  return ok;
}

/** Synchronous in-flight check for a `beforeunload` handler, which cannot await `flushTextAnnotationCommands`. */
export function hasPendingTextAnnotationCommands(assetId: string): boolean {
  return (pending.get(assetId)?.size ?? 0) > 0;
}
