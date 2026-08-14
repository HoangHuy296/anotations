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
 * Lists AI models currently available for pre-annotation requests. Only
 * `isActive: true` rows are returned. `modality: null` on a row that
 * supports more than one modality is surfaced as-is — callers must not
 * assume every model is single-modality.
 */
export async function listActiveAiModels(): Promise<AiModelDto[]> {
  return db.aiModel.findMany({
    where: { isActive: true },
    select: { id: true, key: true, displayName: true, modality: true, taskType: true },
    orderBy: { displayName: "asc" },
  });
}
