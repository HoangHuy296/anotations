import { DatasetType, Modality } from "@internal/db";
import { z } from "zod";

const metadataSchema = z.record(z.string(), z.json()).default({});
const optionalText = z.string().trim().max(2_000).optional();

export const datasetIdSchema = z.string().cuid();
export const createDatasetSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: optionalText,
  type: z.nativeEnum(DatasetType).default(DatasetType.MULTI_MODAL),
  primaryModality: z.nativeEnum(Modality).nullable().optional().default(null),
  metadata: metadataSchema,
});
export const updateDatasetSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: optionalText,
  type: z.nativeEnum(DatasetType).optional(),
  primaryModality: z.nativeEnum(Modality).nullable().optional(),
  metadata: metadataSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, "Provide at least one dataset field.");
