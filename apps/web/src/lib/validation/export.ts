import { z } from "zod";

import { datasetIdSchema } from "@/lib/validation/dataset";

/**
 * Two export formats: JSON (the lossless, complete platform manifest -- the
 * original Phase 012 format) and COCO (the interoperable image-annotation
 * export; specs/027-coco-dataset-export). COCO always means "every
 * export-eligible annotation in the Dataset" -- there is no source/scope
 * filter (§2 of the spec dropped that as unnecessary for the MVP).
 */
export const exportRequestSchema = z.object({
  datasetId: datasetIdSchema,
  format: z.enum(["JSON", "COCO"]).default("JSON"),
  manifestSchemaVersion: z.literal("1").default("1"),
}).strict();

export const exportJobInputSchema = exportRequestSchema.omit({ datasetId: true });

export type ExportRequest = z.infer<typeof exportRequestSchema>;

export const exportListQuerySchema = z.object({
  cursor: z.string().cuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
}).strict();
