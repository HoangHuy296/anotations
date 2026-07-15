import { JobType } from "@internal/db";
import { z } from "zod";

export const foundationJobInputSchema = z.object({
  datasetId: z.string().cuid(),
  type: z.nativeEnum(JobType),
  input: z.record(z.string(), z.json()).default({}),
}).strict();

const safeSummarySchema = z.object({
  message: z.string().trim().min(1).max(280).optional(),
  outcome: z.enum(["completed", "failed", "canceled"]).optional(),
  completedAt: z.string().datetime().optional(),
  resultCount: z.number().int().nonnegative().optional(),
}).strict();

export const safeJobSummarySchema = safeSummarySchema.nullable();
export type JobSafeSummary = z.infer<typeof safeSummarySchema>;
