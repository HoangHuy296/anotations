"use client";

import type { AiModelDto, AiTaskStatusDto } from "@/types/ai";

/**
 * Thin `fetch` wrappers around the AI routes (`contracts/ai-api.md`) -- same
 * shape as `lib/annotations/annotation-api-client.ts`. No route, payload, or
 * status shape here is invented: every field matches the contract's
 * documented request/response bodies. `cancelAiTaskClient` calls
 * `POST /api/ai/tasks/{taskId}/cancel`, a `taskId`-scoped entry point onto
 * the same underlying `Job` cancellation `POST /api/jobs/{jobId}/cancel`
 * already performs -- not a second cancellation mechanism.
 */

export type AiApiFailure = { ok: false; code: string; status: number };

export type ListAiModelsResult = { ok: true; models: AiModelDto[] } | AiApiFailure;

/**
 * Concurrent-call coalescing, keyed by request identity. React 18 Strict
 * Mode (development only, intentionally left on) mounts every effect twice
 * -- `AiDetectDialog`'s mount effect calls `listActiveAiModelsClient()` on
 * both passes, back-to-back, before either `fetch` resolves. Without this,
 * that's two real network requests every time AI Detect opens. A caller
 * mid-flight reuses the same pending promise instead of starting a new
 * `fetch`; once it settles (success or failure) the entry is cleared, so a
 * later, non-concurrent call (e.g. `retry()`) still gets a fresh request.
 */
const inFlightRequests = new Map<string, Promise<unknown>>();

function dedupeInFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlightRequests.get(key);
  if (existing) return existing as Promise<T>;
  const promise = run().finally(() => { inFlightRequests.delete(key); });
  inFlightRequests.set(key, promise);
  return promise;
}

export async function listActiveAiModelsClient(): Promise<ListAiModelsResult> {
  return dedupeInFlight("GET /api/ai/models", async () => {
    const response = await fetch("/api/ai/models", { credentials: "same-origin", cache: "no-store" });
    const payload = await response.json().catch(() => null) as { data?: { models?: AiModelDto[] }; error?: { code?: string } } | null;
    if (!response.ok || !payload?.data?.models) return { ok: false, code: payload?.error?.code ?? "INVALID_REQUEST", status: response.status };
    return { ok: true, models: payload.data.models };
  });
}

export type CreateAiTaskInput = { datasetId: string; modelId: string; assetIds: string[] };
export type CreateAiTaskResult = { ok: true; taskId: string; jobId: string } | AiApiFailure;

export async function createAiTaskClient(input: CreateAiTaskInput): Promise<CreateAiTaskResult> {
  const response = await fetch("/api/ai/tasks", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => null) as { data?: { taskId?: string; jobId?: string }; error?: { code?: string } } | null;
  if (!response.ok || !payload?.data?.taskId || !payload.data.jobId) return { ok: false, code: payload?.error?.code ?? "INVALID_REQUEST", status: response.status };
  return { ok: true, taskId: payload.data.taskId, jobId: payload.data.jobId };
}

export type ReadAiTaskResult = { ok: true; task: AiTaskStatusDto } | AiApiFailure;

export async function readAiTaskClient(taskId: string): Promise<ReadAiTaskResult> {
  const response = await fetch(`/api/ai/tasks/${taskId}`, { credentials: "same-origin", cache: "no-store" });
  const payload = await response.json().catch(() => null) as { data?: AiTaskStatusDto; error?: { code?: string } } | null;
  if (!response.ok || !payload?.data) return { ok: false, code: payload?.error?.code ?? "AI_TASK_NOT_FOUND", status: response.status };
  return { ok: true, task: payload.data };
}

export type CancelAiTaskResult = { ok: true } | AiApiFailure;

/** Cancels an AI task by its own id (`POST /api/ai/tasks/{taskId}/cancel`) -- still cancels the underlying Job, but the caller only ever needs `taskId`, never `jobId`. */
export async function cancelAiTaskClient(taskId: string): Promise<CancelAiTaskResult> {
  const response = await fetch(`/api/ai/tasks/${taskId}/cancel`, { method: "POST", credentials: "same-origin" });
  const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null;
  if (!response.ok) return { ok: false, code: payload?.error?.code ?? "JOB_CONFLICT", status: response.status };
  return { ok: true };
}
