import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { jobQueuePayloadSchema, queueNameForJobType } from "@fieldframe/queue";

import { writeSafeJobEvent, type JobEventReason } from "../jobs/job-event-writer.js";
import { claimJob } from "../jobs/job-claim-lock.js";
import { processImportDataset } from "../jobs/import-dataset.js";
import { failJob } from "../jobs/job-claim-lock.js";
import { cancelJob } from "../jobs/job-claim-lock.js";
import { resolveSourceAccessForJob } from "../source/source-access.js";
import { processExportDataset } from "../jobs/export-dataset.js";

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
      sourceConnectionId: true,
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
  const cancellation = await input.db.job.findFirst({ where: { id: job.id, lockToken: claim.lockToken }, select: { cancelRequestedAt: true, status: true } });
  if (cancellation?.cancelRequestedAt || cancellation?.status === "CANCELING") {
    await cancelJob(input.db, { jobId: job.id, lockToken: claim.lockToken });
    return { kind: "claimed", jobId: job.id };
  }
  // A durable connection is always revalidated before a worker may proceed.
  // Local-folder jobs have no SourceConnection and retain their existing path.
  if (job.type === "IMPORT_DATASET" && job.sourceConnectionId) {
    const sourceAccess = await resolveSourceAccessForJob(input.db, job.id);
    if (sourceAccess.kind === "refused") {
      await input.db.job.updateMany({ where: { id: job.id, lockToken: claim.lockToken, status: "RUNNING" }, data: { errorCode: sourceAccess.errorCode } });
      await failJob(input.db, { jobId: job.id, lockToken: claim.lockToken });
      return { kind: "claimed", jobId: job.id };
    }
  }
  if (job.type === "IMPORT_DATASET") await processImportDataset(input.db, job.id, claim.lockToken);
  if (job.type === "EXPORT_DATASET") await processExportDataset(input.db, job.id, claim.lockToken);
  return { kind: "claimed", jobId: job.id };
}
