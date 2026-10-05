import { z } from "zod";

import { datasetIdSchema } from "@/lib/validation/dataset";
import { bulkSelectionSchema } from "@/lib/validation/asset-bulk";

/**
 * The browser states an intent only. `target` reuses the Phase 022 selection
 * schema exactly; legacy `assetIds` callers stay supported and are normalized
 * to an explicit selection by the server. The two forms are mutually exclusive.
 */
export const aiDetectionTargetSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("CURRENT_ASSET"), assetId: z.string().min(1) }).strict(),
  z.object({ mode: z.literal("BULK_SELECTION"), selection: bulkSelectionSchema }).strict(),
]);

export const createAiTaskSchema = z.object({
  datasetId: datasetIdSchema,
  classes: z.array(z.string().min(1).max(256)).min(1).max(10000).refine((items) => new Set(items).size === items.length).optional(),
  confidence_threshold: z.number().min(0).max(1).default(0.5),
  iou_threshold: z.number().min(0).max(1).default(0.5),
  modelId: z.string().min(1),
  assetIds: z.array(z.string().min(1)).min(1).optional(),
  target: aiDetectionTargetSchema.optional(),
  previewFingerprint: z.string().min(1).max(256).optional(),
}).refine((value) => (value.assetIds === undefined) !== (value.target === undefined), { message: "Provide exactly one of assetIds or target." });

export type CreateAiTaskInput = z.infer<typeof createAiTaskSchema>;

/** Read-only target preview: the same target contract as creation, plus the model the user is considering. */
export const previewAiTargetSchema = z.object({
  datasetId: datasetIdSchema,
  target: aiDetectionTargetSchema,
  modelId: z.string().min(1).optional(),
});
