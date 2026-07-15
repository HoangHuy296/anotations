import { z } from "zod";
import { Queue } from "bullmq";

export const jobQueuePayloadSchema = z.object({
  jobId: z.string().min(1),
}).strict();

export type JobQueuePayload = z.infer<typeof jobQueuePayloadSchema>;

/** Deterministic delivery identity; the durable PostgreSQL Job is authoritative. */
export function getQueueDeliveryId(jobId: string) {
  return jobQueuePayloadSchema.parse({ jobId }).jobId;
}

export const fieldframeQueueName = "fieldframe-jobs";

/** Only foundation-safe existing Job types may be delivered before workflow processors exist. */
export const supportedQueueJobTypes = ["EXPORT_DATASET"] as const;
export type SupportedQueueJobType = (typeof supportedQueueJobTypes)[number];

export function queueNameForJobType(type: string): string | null {
  return (supportedQueueJobTypes as readonly string[]).includes(type) ? fieldframeQueueName : null;
}

export function createQueueTransport(input: { host: string; port: number; password: string; prefix: string }) {
  return new Queue(fieldframeQueueName, {
    connection: { host: input.host, port: input.port, password: input.password, maxRetriesPerRequest: null },
    prefix: input.prefix,
  });
}

export function getPrefixedQueueName(prefix: string) {
  return `${prefix}:${fieldframeQueueName}`;
}
