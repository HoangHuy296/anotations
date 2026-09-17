import "server-only";

import { z } from "zod";
import { readAiProviderBaseUrl } from "@annotationplatform/domain/provider-config";
import { db } from "@/lib/db";
import type { AiModelDto, AiToolTaskName } from "@/types/ai";

export type { AiModelDto } from "@/types/ai";

const catalogSchema = z.object({
  success: z.literal(true),
  data: z.array(z.object({
    model_id: z.string().uuid(),
    model_name: z.string().trim().min(1).max(256),
    type: z.string().trim().transform((value) => value.toUpperCase()),
    task_name: z.string().trim().min(1),
  })),
});

export function parseModelCatalog(input: unknown) {
  return catalogSchema.parse(input).data;
}

const inFlightQueries = new Map<string, Promise<AiModelDto[]>>();

function platformTaskType(taskName: string): string {
  return taskName.toUpperCase();
}

function localTaskTypeMatches(modality: "IMAGE" | "VIDEO" | "AUDIO" | "TEXT", localTaskType: string, providerTaskType: string): boolean {
  if (localTaskType === providerTaskType) return true;
  return localTaskType === "DETECT_OBJECTS" && (
    (modality === "IMAGE" && providerTaskType === "DETECTION") ||
    (modality === "VIDEO" && providerTaskType === "TRACKING")
  );
}

async function loadModels(modality?: string, taskName?: AiToolTaskName): Promise<AiModelDto[]> {
  const url = new URL("/api/v1/models/list", readAiProviderBaseUrl());
  if (modality) url.searchParams.set("type", modality.toLowerCase());
  if (taskName) url.searchParams.set("task_name", taskName);
  const response = await fetch(url, {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("AI_MODEL_CATALOG_UNAVAILABLE");
  // Check the response too: never trust a provider to have applied filters.
  const catalog = parseModelCatalog(await response.json()).filter((model) =>
    (!modality || model.type === modality) && (!taskName || model.task_name === taskName));
  const select = { id: true, key: true, provider: true, modality: true, taskType: true, isActive: true } as const;
  const configured = await db.aiModel.findMany({
    where: { key: { in: catalog.map((model) => model.model_id) } }, select,
  });
  const models: AiModelDto[] = [];
  for (const model of catalog) {
    const modality = z.enum(["IMAGE", "VIDEO", "AUDIO", "TEXT"]).safeParse(model.type);
    if (!modality.success) continue;
    const taskType = platformTaskType(model.task_name);
    const supported = (modality.data === "IMAGE" && taskType === "DETECTION") || (modality.data === "VIDEO" && taskType === "TRACKING");
    // Discovery is read-only: registration or enum upgrades must not prevent
    // the provider catalog from being displayed in the toolbox.
    const local = configured.find((entry) => entry.key === model.model_id);
    if (local && (!local.isActive || local.provider !== "aioz-company")) continue;
    const availableForTasks = supported && !!local && local.modality === modality.data && localTaskTypeMatches(modality.data, local.taskType, taskType);
    models.push({
      id: local?.id ?? model.model_id, key: model.model_id, displayName: model.model_name,
      modality: modality.data, taskType, availableForTasks,
    });
  }
  return models;
}

/** Share concurrent reads of the same filters only; reopening refreshes upstream. */
export async function listActiveAiModels(modality?: string, taskName?: AiToolTaskName): Promise<AiModelDto[]> {
  const key = JSON.stringify([modality, taskName]);
  let pending = inFlightQueries.get(key);
  if (!pending) {
    pending = loadModels(modality, taskName).finally(() => { inFlightQueries.delete(key); });
    inFlightQueries.set(key, pending);
  }
  return pending;
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
  const baseUrl = readAiProviderBaseUrl();
  const response = await fetch(new URL(`/api/v1/models/labels/${encodeURIComponent(modelKey)}`, baseUrl), {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("AI_MODEL_LABELS_UNAVAILABLE");
  return parseModelLabels(await response.json(), modelKey);
}
