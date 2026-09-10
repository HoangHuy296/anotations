import "server-only";

import { z } from "zod";
import { db } from "@/lib/db";
import type { AiModelDto } from "@/types/ai";

export type { AiModelDto } from "@/types/ai";

const catalogSchema = z.object({
  success: z.literal(true),
  data: z.array(z.object({
    model_id: z.string().uuid(),
    model_name: z.string().trim().min(1),
    type: z.string().trim().transform((value) => value.toUpperCase()),
  })),
});

export function parseModelCatalog(input: unknown) {
  return catalogSchema.parse(input).data;
}

let inFlightQuery: Promise<AiModelDto[]> | null = null;

async function loadModels(): Promise<AiModelDto[]> {
  const baseUrl = process.env.AIOZ_ANNOTATION_SERVICES_BASE_URL ?? "http://10.0.0.186:7000";
  const response = await fetch(new URL("/api/v1/models/list", baseUrl), {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("AI_MODEL_CATALOG_UNAVAILABLE");
  const catalog = parseModelCatalog(await response.json());
  const configured = await db.aiModel.findMany({
    where: { provider: "aioz-company", key: { in: catalog.map((model) => model.model_id) } },
    select: { id: true, key: true, modality: true, taskType: true, isActive: true },
  });
  return catalog.flatMap((model): AiModelDto[] => {
    const modality = z.enum(["IMAGE", "VIDEO", "AUDIO", "TEXT"]).safeParse(model.type);
    if (!modality.success) return [];
    const local = configured.find((entry) => entry.key === model.model_id);
    if (local && !local.isActive) return [];
    const availableForTasks = !!local && (local.modality === null || local.modality === modality.data);
    return [{
      id: local?.id ?? model.model_id, key: model.model_id, displayName: model.model_name,
      modality: modality.data, taskType: local?.taskType ?? "", availableForTasks,
    }];
  });
}

/** Share concurrent catalog reads only; subsequent loads always refresh upstream. */
export async function listActiveAiModels(modality?: string): Promise<AiModelDto[]> {
  if (!inFlightQuery) inFlightQuery = loadModels().finally(() => { inFlightQuery = null; });
  const models = await inFlightQuery;
  return modality ? models.filter((model) => model.modality === modality) : models;
}

const labelsSchema = z.object({
  success: z.literal(true),
  data: z.object({ model_id: z.string().uuid(), classes: z.array(z.string().min(1).max(256)).max(10000) }),
});

export function parseModelLabels(input: unknown, modelKey: string): string[] {
  const { data } = labelsSchema.parse(input);
  if (data.model_id !== modelKey) throw new Error("AI_MODEL_LABELS_UNAVAILABLE");
  return [...new Set(data.classes)];
}

/** Provider access remains server-side; only validated class names leave this boundary. */
export async function loadModelClasses(modelKey: string): Promise<string[]> {
  z.string().uuid().parse(modelKey);
  const baseUrl = process.env.AIOZ_ANNOTATION_SERVICES_BASE_URL ?? "http://10.0.0.186:7000";
  const response = await fetch(new URL(`/api/v1/models/labels/${encodeURIComponent(modelKey)}`, baseUrl), {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("AI_MODEL_LABELS_UNAVAILABLE");
  return parseModelLabels(await response.json(), modelKey);
}
