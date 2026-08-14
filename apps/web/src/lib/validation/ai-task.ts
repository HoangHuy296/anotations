import { z } from "zod";

import { datasetIdSchema } from "@/lib/validation/dataset";

export const createAiTaskSchema = z.object({
  datasetId: datasetIdSchema,
  modelId: z.string().min(1),
  assetIds: z.array(z.string().min(1)).min(1),
});

export type CreateAiTaskInput = z.infer<typeof createAiTaskSchema>;
