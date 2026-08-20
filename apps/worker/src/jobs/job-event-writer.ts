import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

export const jobEventKinds = [
  "QUEUE_ENQUEUED", "QUEUE_DELIVERY_PENDING", "QUEUE_RECEIVED", "QUEUE_SKIPPED",
  "JOB_CLAIMED", "JOB_HEARTBEAT", "JOB_PROGRESS", "IMPORT_BATCH_COMPLETED",
  "JOB_COMPLETED", "JOB_FAILED", "JOB_CANCELED",
  // 021-production-hardening-garbage-collection: recovery/staleness/dead-letter
  // (worker-internal vocabulary — see apps/web/src/lib/jobs/safe-job-event.ts
  // for the browser-safe subset).
  "JOB_RECOVERED", "JOB_STALE_TIMEOUT", "JOB_DEAD_LETTERED",
  // MinIO garbage collection and JobEvent retention. These are not tied to
  // one Job's lifecycle in the usual sense (a GC pass spans many objects
  // across many Jobs/Assets), so they are written without a `jobId` scope
  // where noted in each caller — see minio-orphan-scanner.ts.
  "MINIO_ORPHAN_DETECTED", "MINIO_ORPHAN_DELETED",
  "ASSET_STORAGE_CLEANED", "DATASET_STORAGE_CLEANED", "TEMP_UPLOAD_CLEANED",
] as const;
export type JobEventKind = (typeof jobEventKinds)[number];
export type JobEventReason =
  | "MALFORMED_PAYLOAD" | "UNKNOWN_JOB" | "NOT_QUEUED" | "CANCELED" | "INACTIVE_DATASET" | "UNSUPPORTED_TYPE" | "TRANSPORT_CONFLICT"
  | "LEASE_EXPIRED" | "MAX_RUNTIME_EXCEEDED" | "RECOVERY_EXHAUSTED" | "RETENTION_SWEPT"
  // Already recognized on the browser-safe read side
  // (apps/web/src/lib/jobs/safe-job-event.ts) via apps/web's own enqueue
  // path; added here so the worker-side recovery redelivery path
  // (queue/redeliver-job.ts) can emit the same, already-safe reason.
  | "QUEUE_UNAVAILABLE";

export async function writeSafeJobEvent(db: PrismaClient, input: { jobId: string; kind: JobEventKind; queueName?: string; queueJobId?: string; reason?: JobEventReason; aggregate?: { imported: number; skipped: number; failed: number } }) {
  const data = {
    ...(input.queueName ? { queueName: input.queueName } : {}),
    ...(input.queueJobId ? { queueJobId: input.queueJobId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.aggregate ? { imported: input.aggregate.imported, skipped: input.aggregate.skipped, failed: input.aggregate.failed } : {}),
  };
  return db.jobEvent.create({ data: { jobId: input.jobId, level: input.kind === "QUEUE_DELIVERY_PENDING" ? "WARN" : "INFO", message: input.kind, data } });
}
