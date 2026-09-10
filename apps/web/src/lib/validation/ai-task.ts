import { z } from "zod";

import { datasetIdSchema } from "@/lib/validation/dataset";

export const createAiTaskSchema = z.object({
  datasetId: datasetIdSchema,
  classes: z.array(z.string().min(1).max(256)).min(1).max(10000).refine((items) => new Set(items).size === items.length).optional(),
  confidence_threshold: z.number().min(0).max(1).default(0.5),
  iou_threshold: z.number().min(0).max(1).default(0.5),
  modelId: z.string().min(1),
  assetIds: z.array(z.string().min(1)).min(1),
});

export type CreateAiTaskInput = z.infer<typeof createAiTaskSchema>;
