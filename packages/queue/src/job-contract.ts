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
export const supportedQueueJobTypes = ["EXPORT_DATASET", "IMPORT_DATASET"] as const;
export type SupportedQueueJobType = (typeof supportedQueueJobTypes)[number];

export function queueNameForJobType(type: string): string | null {
  return (supportedQueueJobTypes as readonly string[]).includes(type) ? fieldframeQueueName : null;
}

export function createQueueTransport(input: {
  host: string;
  port: number;
  password: string;
  prefix: string;
  db?: number;
  /** Opt-in bounded failure behavior for controlled outage tests and one-shot probes. */
  failFast?: boolean;
}) {
  return new Queue(fieldframeQueueName, {
    connection: {
      host: input.host,
      port: input.port,
      password: input.password,
      db: input.db ?? 0,
      maxRetriesPerRequest: input.failFast ? 1 : null,
      ...(input.failFast
        ? { connectTimeout: 500, enableOfflineQueue: false, retryStrategy: () => null }
        : {}),
    },
    prefix: input.prefix,
  });
}

export function getPrefixedQueueName(prefix: string) {
  return `${prefix}:${fieldframeQueueName}`;
}

const safeLocalQueueTestConfigSchema = z.object({
  QUEUE_INTEGRATION_TESTS: z.literal("1"),
  REDIS_HOST: z.literal("127.0.0.1"),
  REDIS_PORT: z.coerce.number().int().min(1).max(65_535),
  REDIS_PASSWORD: z.string().min(16),
  REDIS_TEST_DB: z.coerce.number().int().min(1).max(15),
  REDIS_DB: z.coerce.number().int().min(1).max(15),
  REDIS_TEST_PREFIX: z.string().min(8).max(120),
  BULLMQ_PREFIX: z.string().min(8).max(120),
}).superRefine((value, context) => {
  if (value.REDIS_DB !== value.REDIS_TEST_DB) context.addIssue({ code: "custom", path: ["REDIS_DB"], message: "REDIS_DB must equal REDIS_TEST_DB for queue integration tests." });
  if (value.BULLMQ_PREFIX !== value.REDIS_TEST_PREFIX) context.addIssue({ code: "custom", path: ["BULLMQ_PREFIX"], message: "BULLMQ_PREFIX must equal REDIS_TEST_PREFIX for queue integration tests." });
});

export type SafeLocalQueueTestConfig = z.infer<typeof safeLocalQueueTestConfigSchema>;

/**
 * Full queue tests are intentionally opt-in. They only use a passworded Redis
 * listener bound to 127.0.0.1 and require a dedicated non-zero DB plus prefix.
 */
export function readSafeLocalQueueTestConfig(environment: NodeJS.ProcessEnv = process.env): SafeLocalQueueTestConfig {
  return safeLocalQueueTestConfigSchema.parse(environment);
}
