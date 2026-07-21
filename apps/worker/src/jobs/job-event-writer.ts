import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { z } from "zod";

export const jobEventKinds = ["QUEUE_ENQUEUED", "QUEUE_DELIVERY_PENDING", "QUEUE_RECEIVED", "QUEUE_SKIPPED", "JOB_CLAIMED", "JOB_HEARTBEAT", "JOB_PROGRESS", "JOB_COMPLETED", "JOB_FAILED", "JOB_CANCELED"] as const;
export type JobEventKind = (typeof jobEventKinds)[number];
export type JobEventReason = "MALFORMED_PAYLOAD" | "UNKNOWN_JOB" | "NOT_QUEUED" | "CANCELED" | "INACTIVE_DATASET" | "UNSUPPORTED_TYPE" | "TRANSPORT_CONFLICT";

export async function writeSafeJobEvent(db: PrismaClient, input: { jobId: string; kind: JobEventKind; queueName?: string; queueJobId?: string; reason?: JobEventReason }) {
  const data = {
    ...(input.queueName ? { queueName: input.queueName } : {}),
    ...(input.queueJobId ? { queueJobId: input.queueJobId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
  return db.jobEvent.create({ data: { jobId: input.jobId, level: input.kind === "QUEUE_DELIVERY_PENDING" ? "WARN" : "INFO", message: input.kind, data } });
}
