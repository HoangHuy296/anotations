import { z } from "zod";

export const jobQueuePayloadSchema = z.object({
  jobId: z.string().min(1),
}).strict();

export type JobQueuePayload = z.infer<typeof jobQueuePayloadSchema>;

export const fieldframeQueueName = "fieldframe-jobs";

export function getPrefixedQueueName(prefix: string) {
  return `${prefix}:${fieldframeQueueName}`;
}
