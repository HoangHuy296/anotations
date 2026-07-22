import { z } from "zod";

import { datasetIdSchema } from "@/lib/validation/dataset";

/** Phase 012 intentionally has one bounded, metadata-only export format. */
export const exportRequestSchema = z.object({
  datasetId: datasetIdSchema,
  format: z.literal("JSON").default("JSON"),
  manifestSchemaVersion: z.literal("1").default("1"),
}).strict();

export const exportJobInputSchema = exportRequestSchema.omit({ datasetId: true });

export type ExportRequest = z.infer<typeof exportRequestSchema>;
