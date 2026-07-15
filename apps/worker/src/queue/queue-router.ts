import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { jobQueuePayloadSchema, queueNameForJobType } from "@fieldframe/queue";

import { writeSafeJobEvent, type JobEventReason } from "../jobs/job-event-writer.js";

export type QueueRouteResult =
  | { kind: "received"; jobId: string }
  | { kind: "skipped"; reason: JobEventReason | "MALFORMED_PAYLOAD" };

/**
 * Resolves an at-least-once delivery against PostgreSQL. This is deliberately
 * the final action in Phase 007: it never changes status to RUNNING and never
 * invokes workflow-specific business handlers.
 */
export async function routeQueueDelivery(input: { db: PrismaClient; payload: unknown }): Promise<QueueRouteResult> {
  const payload = jobQueuePayloadSchema.safeParse(input.payload);
  if (!payload.success) return { kind: "skipped", reason: "MALFORMED_PAYLOAD" };

  const job = await input.db.job.findUnique({
    where: { id: payload.data.jobId },
    select: {
      id: true,
      type: true,
      status: true,
      cancelRequestedAt: true,
      dequeuedAt: true,
      dataset: { select: { archivedAt: true, deletedAt: true } },
    },
  });
  if (!job) return { kind: "skipped", reason: "UNKNOWN_JOB" };

  const reason: JobEventReason | null =
    job.cancelRequestedAt ? "CANCELED"
      : job.status !== "QUEUED" ? "NOT_QUEUED"
        : job.dataset.archivedAt || job.dataset.deletedAt ? "INACTIVE_DATASET"
          : !queueNameForJobType(job.type) ? "UNSUPPORTED_TYPE"
            : job.dequeuedAt ? "NOT_QUEUED"
              : null;
  if (reason) {
    await writeSafeJobEvent(input.db, { jobId: job.id, kind: "QUEUE_SKIPPED", reason });
    return { kind: "skipped", reason };
  }

  const receipt = await input.db.job.updateMany({
    where: { id: job.id, status: "QUEUED", cancelRequestedAt: null, dequeuedAt: null },
    data: { dequeuedAt: new Date() },
  });
  if (receipt.count !== 1) return { kind: "skipped", reason: "NOT_QUEUED" };

  const queueName = queueNameForJobType(job.type);
  if (!queueName) return { kind: "skipped", reason: "UNSUPPORTED_TYPE" };
  await writeSafeJobEvent(input.db, { jobId: job.id, kind: "QUEUE_RECEIVED", queueName, queueJobId: job.id });
  return { kind: "received", jobId: job.id };
}
