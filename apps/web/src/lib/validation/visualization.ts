import { z } from "zod";

import { datasetDestination } from "@/lib/datasets/dataset-destination";
import { datasetIdSchema } from "@/lib/validation/dataset";
import { visualizationTabs, type VisualizationTab } from "@/types/visualization";

// Repeated, missing and unrecognized tab parameters all fall back to Data.
export const visualizationQuerySchema = z.object({
  tab: z.enum(visualizationTabs).catch("data"),
});

export function visualizationTabHref(datasetId: string, tab: VisualizationTab): string {
  const id = datasetIdSchema.parse(datasetId);
  const query = new URLSearchParams(visualizationQuerySchema.parse({ tab }));
  return `${datasetDestination(id, "COMPLETED")}?${query}`;
}

export const visualizationIdsSchema = z.object({ datasetId: datasetIdSchema, assetId: datasetIdSchema.optional() });
export const visualizationPageSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(18),
}).strict();
export const visualizationAssetsQuerySchema = visualizationPageSchema.extend({
  sort: z.enum(["filename", "createdAt"]).default("filename"),
  order: z.enum(["asc", "desc"]).default("asc"),
  q: z.string().trim().max(100).default(""),
  modality: z.enum(["ALL", "IMAGE", "VIDEO", "AUDIO", "TEXT"]).default("ALL"),
  labelId: datasetIdSchema.optional(),
}).strict();
export type VisualizationAssetsQuery = z.infer<typeof visualizationAssetsQuerySchema>;
