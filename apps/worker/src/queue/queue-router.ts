import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { jobQueuePayloadSchema, queueNameForJobType } from "@fieldframe/queue";

import { writeSafeJobEvent, type JobEventReason } from "../jobs/job-event-writer.js";
import { claimJob } from "../jobs/job-claim-lock.js";

export type QueueRouteResult =
  | { kind: "received"; jobId: string }
  | { kind: "claimed"; jobId: string }
  | { kind: "skipped"; reason: JobEventReason | "MALFORMED_PAYLOAD" };

/**
 * Resolves an at-least-once delivery against PostgreSQL. A successful Phase
 * 008 claim establishes ownership and deliberately stops before a future
 * workflow-specific business handler could run.
 */
export async function routeQueueDelivery(input: { db: PrismaClient; payload: unknown; workerId?: string }): Promise<QueueRouteResult> {
  const payload = jobQueuePayloadSchema.safeParse(input.payload);
  if (!payload.success) return { kind: "skipped", reason: "MALFORMED_PAYLOAD" };

  const job = await input.db.job.findUnique({
    where: { id: payload.data.jobId },
    select: {
      id: true,
      type: true,
      status: true,
      cancelRequestedAt: true,
      dataset: { select: { archivedAt: true, deletedAt: true } },
    },
  });
  if (!job) return { kind: "skipped", reason: "UNKNOWN_JOB" };

  const reason: JobEventReason | null =
    job.cancelRequestedAt ? "CANCELED"
      : !["QUEUED", "RETRYING"].includes(job.status) ? "NOT_QUEUED"
        : job.dataset.archivedAt || job.dataset.deletedAt ? "INACTIVE_DATASET"
          : !queueNameForJobType(job.type) ? "UNSUPPORTED_TYPE"
            : null;
  if (reason) {
    await writeSafeJobEvent(input.db, { jobId: job.id, kind: "QUEUE_SKIPPED", reason });
    return { kind: "skipped", reason };
  }

  const queueName = queueNameForJobType(job.type);
  if (!queueName) return { kind: "skipped", reason: "UNSUPPORTED_TYPE" };
  const claim = await claimJob(input.db, { jobId: job.id, workerId: input.workerId ?? "direct-worker" });
  if (claim.kind === "refused") return { kind: "skipped", reason: "NOT_QUEUED" };
  await writeSafeJobEvent(input.db, { jobId: job.id, kind: "QUEUE_RECEIVED", queueName, queueJobId: job.id });
  await writeSafeJobEvent(input.db, { jobId: job.id, kind: "JOB_CLAIMED" });
  return { kind: "claimed", jobId: job.id };
}
