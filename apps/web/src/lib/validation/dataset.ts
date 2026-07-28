import { z } from "zod";

const metadataSchema = z.record(z.string(), z.json()).default({});
const optionalText = z.string().trim().max(2_000).optional();
// Keep browser-importable validation independent from Prisma's server runtime.
const datasetTypes = ["IMAGE_LABELING", "VIDEO_LABELING", "TEXT_LABELING", "AUDIO_LABELING", "MULTI_MODAL"] as const;
const modalities = ["IMAGE", "VIDEO", "TEXT", "AUDIO"] as const;
export const datasetWorkflowStatuses = ["IN_PROGRESS", "COMPLETED", "REVIEWED"] as const;

/** Legacy records use CUIDs; local-folder imports use UUIDs generated before persistence. */
export const datasetIdSchema = z.union([z.string().cuid(), z.string().uuid()]);
export const createDatasetSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: optionalText,
  type: z.enum(datasetTypes).default("MULTI_MODAL"),
  primaryModality: z.enum(modalities).nullable().optional().default(null),
  metadata: metadataSchema,
});
export const updateDatasetSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: optionalText,
  type: z.enum(datasetTypes).optional(),
  primaryModality: z.enum(modalities).nullable().optional(),
  metadata: metadataSchema.optional(),
  workflowStatus: z.enum(datasetWorkflowStatuses).optional(),
}).refine((value) => Object.keys(value).length > 0, "Provide at least one dataset field.");
