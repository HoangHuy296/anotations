import "server-only";

import { db } from "@/lib/db";

/**
 * Safe DTO shape from contracts/ai-api.md's GET /api/ai/models. `provider`
 * is never selected here — it is an internal resolution detail
 * (AiTask.modelId -> AiModel.provider), not something a browser client
 * selects.
 */
export type AiModelDto = {
  id: string;
  key: string;
  displayName: string;
  modality: string | null;
  taskType: string;
};

/**
 * In-flight coalescing around the `AiModel` read only. `GET /api/ai/models`
 * still calls `getRequestActor()` on every request -- authentication is
 * never cached here, only this DB query, and it's the same result for every
 * caller (no actor-specific filtering exists). This intentionally has no
 * time-based cache beyond the query's own lifetime: a TTL would let a
 * request that lands just after an admin activates/deactivates a model
 * serve a stale list, and `ai-models-route.test.ts` asserts a freshly
 * created model is visible on the very next request. Overlapping callers
 * within the same brief window (React Strict Mode's double effect
 * invocation in development, multiple browser tabs, near-simultaneous
 * users) share one query instead of each issuing their own; once it
 * resolves, the next call always re-queries.
 */
let inFlightQuery: Promise<AiModelDto[]> | null = null;

/**
 * Lists AI models currently available for pre-annotation requests. Only
 * `isActive: true` rows are returned. `modality: null` on a row that
 * supports more than one modality is surfaced as-is — callers must not
 * assume every model is single-modality.
 */
export async function listActiveAiModels(): Promise<AiModelDto[]> {
  if (inFlightQuery) return inFlightQuery;

  inFlightQuery = db.aiModel.findMany({
    where: { isActive: true },
    select: { id: true, key: true, displayName: true, modality: true, taskType: true },
    orderBy: { displayName: "asc" },
  }).finally(() => { inFlightQuery = null; });
  return inFlightQuery;
}
