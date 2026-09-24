"use client";

import type { TextSourceReadOutcome } from "@/lib/annotations/text-source-read-service";
import type { TextSourceReadiness } from "@/lib/annotations/text-source-readiness";

/**
 * Browser client for the TEXT source read/prepare routes (T054/T055). Fetches
 * the readiness/source/boundary projection, triggers preparation, and polls
 * Job status until a terminal readiness state — the text-engine reader
 * (T057) is the only consumer; this file contains no source-authority logic
 * of its own, only HTTP plumbing.
 */

type MutationResponse<T> = { data: T } | { error: { code: string; message: string } };

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
  });
  const body = await response.json() as MutationResponse<T>;
  if (!response.ok || !("data" in body)) {
    throw Object.assign(new Error("TEXT source request failed."), { code: "error" in body ? body.error.code : "REQUEST_FAILED", status: response.status });
  }
  return body.data;
}

export function fetchTextSource(assetId: string): Promise<TextSourceReadOutcome> {
  return request<TextSourceReadOutcome>(`/api/assets/${encodeURIComponent(assetId)}/text`);
}

export type TriggerTextSourcePreparationResult = { jobId: string; status: string; created: boolean; ready: boolean };

export function triggerTextSourcePreparation(assetId: string): Promise<TriggerTextSourcePreparationResult> {
  return request<TriggerTextSourcePreparationResult>(`/api/assets/${encodeURIComponent(assetId)}/text/prepare`, { method: "POST" });
}

/** Readiness states that will never change on their own without an explicit new prepare request. */
const TERMINAL_READINESS = new Set<TextSourceReadiness>(["READY", "UNAVAILABLE", "INVALID_ENCODING", "SOURCE_MISMATCH", "UNSUPPORTED_SIZE", "LEGACY_RECONCILIATION_REQUIRED"]);

export type PollTextSourceOptions = { maxAttempts?: number; intervalMs?: number; signal?: AbortSignal };

/**
 * If the source is not already in a terminal state, triggers (idempotent)
 * preparation and polls until it reaches one, or `maxAttempts` is exhausted.
 * Aborting `signal` stops polling immediately and returns whatever the last
 * observed outcome was — callers must never apply a result for an asset
 * they've since navigated away from; tie `signal` to the calling
 * component's asset-scoped effect cleanup.
 */
export async function ensureTextSourceReady(assetId: string, options: PollTextSourceOptions = {}): Promise<TextSourceReadOutcome> {
  const { maxAttempts = 30, intervalMs = 1_000, signal } = options;
  let current = await fetchTextSource(assetId);
  if (signal?.aborted) return current;
  if (current.ok && !TERMINAL_READINESS.has(current.readiness)) {
    await triggerTextSourcePreparation(assetId).catch(() => undefined);
  }
  let attempts = 0;
  while (current.ok && !TERMINAL_READINESS.has(current.readiness) && attempts < maxAttempts) {
    if (signal?.aborted) return current;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (signal?.aborted) return current;
    current = await fetchTextSource(assetId);
    attempts += 1;
  }
  return current;
}
