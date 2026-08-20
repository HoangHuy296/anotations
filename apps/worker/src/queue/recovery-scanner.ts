import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { queueNameForJobType } from "@annotationplatform/queue";

import { writeSafeJobEvent } from "../jobs/job-event-writer.js";

const DEFAULT_RECOVERY_LIMIT = 50;

export type ExistingJobRedelivery = (jobId: string) => Promise<{ ok: boolean; status: number; deliveryPending?: boolean }>;

export type RecoveryScanResult = {
  examined: number;
  delivered: number;
  pending: number;
  skipped: number;
};

/**
 * Runs exactly one bounded, explicitly invoked recovery pass. The caller must
 * supply the established durable enqueue service; this scanner never creates
 * a Job or serializes anything except that service's existing `{ jobId }`.
 */
export async function runPendingJobRecovery(input: {
  db: PrismaClient;
  redeliverExistingJob: ExistingJobRedelivery;
  limit?: number;
}): Promise<RecoveryScanResult> {
  const take = Math.min(Math.max(input.limit ?? DEFAULT_RECOVERY_LIMIT, 1), DEFAULT_RECOVERY_LIMIT);
  const candidates = await input.db.job.findMany({
    where: { status: "QUEUED", enqueuedAt: null },
    orderBy: { createdAt: "asc" },
    take,
    select: {
      id: true,
      type: true,
      cancelRequestedAt: true,
      queueName: true,
      queueJobId: true,
      dataset: { select: { archivedAt: true, deletedAt: true } },
    },
  });

  const result: RecoveryScanResult = { examined: candidates.length, delivered: 0, pending: 0, skipped: 0 };
  for (const candidate of candidates) {
    if (candidate.cancelRequestedAt || candidate.dataset.archivedAt || candidate.dataset.deletedAt) {
      result.skipped += 1;
      await writeSafeJobEvent(input.db, { jobId: candidate.id, kind: "QUEUE_SKIPPED", reason: candidate.cancelRequestedAt ? "CANCELED" : "INACTIVE_DATASET" });
      continue;
    }
    if (!queueNameForJobType(candidate.type)) {
      result.skipped += 1;
      await writeSafeJobEvent(input.db, { jobId: candidate.id, kind: "QUEUE_SKIPPED", reason: "UNSUPPORTED_TYPE" });
      continue;
    }
    if (candidate.queueName !== null || candidate.queueJobId !== null) {
      result.skipped += 1;
      await writeSafeJobEvent(input.db, { jobId: candidate.id, kind: "QUEUE_SKIPPED", reason: "TRANSPORT_CONFLICT" });
      continue;
    }

    const delivery = await input.redeliverExistingJob(candidate.id);
    if (delivery.ok && !delivery.deliveryPending) result.delivered += 1;
    else if (delivery.ok && delivery.deliveryPending) result.pending += 1;
    else result.skipped += 1;
  }
  return result;
}
