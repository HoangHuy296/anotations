import type { Queue } from "bullmq";

import { getQueueDeliveryId, queueNameForJobType } from "@annotationplatform/queue";

import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { writeSafeJobEvent } from "../jobs/job-event-writer.js";
import { cleanupVerificationObjects, terminalizeVerification, type TerminalSpec } from "../verification/terminalize.js";
import type { StepContext, VerifierDeps } from "../verification/types.js";

const LIMIT = 50;
const NON_TERMINAL = ["PENDING", "SEALED", "VERIFIED"] as const;
export const MEDIA_VERIFICATION_RETENTION_DAYS = 30;

/**
 * In-place retry delivery for `VERIFY_UPLOADED_MEDIA`. Both the verifier's own operational retry and the lease-expiry recovery (`stale-job-detector.ts`) leave the Job
 * RETRYING with its transport fields cleared; the generic recovery scanner only redelivers QUEUED Jobs, and BullMQ ignores a second `add` of a delivery id it already
 * holds (completed or failed). Each attempt therefore gets its own delivery id (`<jobId>-r<attempts>`): idempotent per attempt, never a second concurrent delivery
 * (the claim is atomic), and independent of the original delivery's fate. PostgreSQL stays authoritative; this only (re)delivers `{ jobId }`.
 */
export async function redeliverRetryingVerificationJobs(input: { db: PrismaClient; queue: Pick<Queue, "add">; now?: Date }) {
  const now = input.now ?? new Date();
  const candidates = await input.db.job.findMany({
    where: {
      type: "VERIFY_UPLOADED_MEDIA", status: "RETRYING", enqueuedAt: null, cancelRequestedAt: null,
      OR: [{ runAfter: null }, { runAfter: { lte: now } }], AND: [{ OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] }],
      dataset: { archivedAt: null, deletedAt: null },
    },
    select: { id: true, attempts: true, type: true },
    orderBy: { updatedAt: "asc" }, take: LIMIT,
  });
  let delivered = 0;
  for (const candidate of candidates) {
    const queueName = queueNameForJobType(candidate.type);
    if (!queueName) continue;
    const deliveryId = `${getQueueDeliveryId(candidate.id)}-r${candidate.attempts}`;
    try {
      await input.queue.add("durable-job", { jobId: candidate.id }, { jobId: deliveryId });
      const stamp = await input.db.job.updateMany({ where: { id: candidate.id, status: "RETRYING", enqueuedAt: null }, data: { queueName, queueJobId: deliveryId, enqueuedAt: now } });
      if (stamp.count) { await writeSafeJobEvent(input.db, { jobId: candidate.id, kind: "QUEUE_ENQUEUED", queueName, queueJobId: deliveryId }); delivered += 1; }
    } catch {
      await writeSafeJobEvent(input.db, { jobId: candidate.id, kind: "QUEUE_DELIVERY_PENDING", queueName, reason: "QUEUE_UNAVAILABLE" }).catch(() => undefined);
    }
  }
  return { examined: candidates.length, delivered };
}

type Reconcilable = Awaited<ReturnType<typeof findReconcilable>>[number];

function findReconcilable(db: PrismaClient, now: Date, graceMs: number) {
  return db.mediaVerification.findMany({
    where: {
      status: { in: [...NON_TERMINAL] },
      OR: [
        { verificationDeadlineAt: { lt: new Date(now.getTime() - graceMs) } },
        { currentJob: { status: "CANCELED" } },
        { currentJob: { cancelRequestedAt: { not: null }, status: { not: "RUNNING" } } },
        { dataset: { OR: [{ archivedAt: { not: null } }, { deletedAt: { not: null } }] } },
        { preparedImportItem: { preparedImport: { OR: [{ status: "EXPIRED" }, { job: { status: { in: ["FAILED", "CANCELED"] } } }] } } },
      ],
    },
    include: { currentJob: { select: { id: true, status: true, lockedUntil: true, cancelRequestedAt: true } }, dataset: { select: { archivedAt: true, deletedAt: true } }, preparedImportItem: { select: { preparedImport: { select: { status: true, job: { select: { status: true } } } } } } },
    orderBy: { createdAt: "asc" }, take: LIMIT,
  });
}

function decide(row: Reconcilable, now: Date, graceMs: number): TerminalSpec | null {
  const job = row.currentJob;
  // An in-flight step observes its own boundary first: a valid lease means the processor owns the decision.
  if (job?.status === "RUNNING" && job.lockedUntil && job.lockedUntil > now) return null;
  if (job?.status === "CANCELED" || (job?.cancelRequestedAt && job.status !== "RUNNING")) return { status: "CANCELED", resultCode: "UPLOAD_VERIFICATION_CANCELED", resultReason: "REQUESTED" };
  if (row.dataset.archivedAt || row.dataset.deletedAt) return { status: "CANCELED", resultCode: "UPLOAD_VERIFICATION_CANCELED", resultReason: "DATASET_INACTIVE" };
  const imported = row.preparedImportItem?.preparedImport;
  if (imported && (imported.status === "EXPIRED" || imported.job.status === "FAILED" || imported.job.status === "CANCELED")) return { status: "CANCELED", resultCode: "UPLOAD_VERIFICATION_CANCELED", resultReason: "IMPORT_ENDED" };
  if (row.verificationDeadlineAt.getTime() + graceMs < now.getTime()) return { status: "EXPIRED", resultCode: "UPLOAD_VERIFICATION_EXPIRED", resultReason: "ALLOWANCE_ELAPSED", jobErrorCode: "UPLOAD_VERIFICATION_EXPIRED", jobErrorKind: "ALLOWANCE_EXPIRED" };
  return null;
}

/**
 * `expireStaleMediaVerifications` (contract section 7/11): terminalizes non-terminal verifications whose allowance elapsed (past the lease grace and with no valid Job
 * lease), whose Job was canceled, whose Dataset became inactive or whose folder import ended, then removes their objects and settles the Job. Repeat-safe: every
 * transition is a compare-and-swap. Never produces REJECTED (R5): none of these causes is a verdict about the bytes.
 */
export async function reconcileMediaVerifications(input: { db: PrismaClient; deps: VerifierDeps; graceMs: number }) {
  const now = input.deps.now();
  const rows = await findReconcilable(input.db, now, input.graceMs);
  let terminalized = 0;
  for (const row of rows) {
    const spec = decide(row, now, input.graceMs);
    if (!spec) continue;
    const ctx: StepContext = { db: input.db, deps: input.deps, job: { id: row.currentJob?.id ?? "scanner", datasetId: row.datasetId, createdById: row.requestedById, attempts: 0, maxAttempts: 1 }, lockToken: "scanner" };
    // The scanner holds no Job lease: the Job is settled below without the lease-guarded helpers.
    if (!(await terminalizeVerification(ctx, row, spec, { endJob: false }))) continue;
    terminalized += 1;
    if (row.currentJobId && row.currentJob?.status !== "COMPLETED") {
      const canceled = spec.status === "CANCELED";
      await input.db.job.updateMany({
        where: { id: row.currentJobId, status: { in: ["QUEUED", "RETRYING", "FAILED", "CANCELING"] } },
        data: canceled
          ? { status: "CANCELED", canceledAt: now, finishedAt: now, lockedBy: null, lockToken: null, lockedAt: null, lockedUntil: null }
          : { status: "FAILED", errorCode: spec.jobErrorCode ?? spec.resultCode, errorDetails: { kind: spec.jobErrorKind ?? "ALLOWANCE_EXPIRED", reason: spec.resultReason }, finishedAt: row.currentJob?.status === "FAILED" ? undefined : now, lockedBy: null, lockToken: null, lockedAt: null, lockedUntil: null },
      });
    }
  }
  return { examined: rows.length, terminalized };
}

/**
 * Retention (R2): a terminal non-PUBLISHED row is eligible 30 days after `finishedAt` and ONLY if both objects are positively established absent. The purger first
 * re-checks (and removes leftovers), sets `objectsClearedAt`, and deletes the row; a row whose cleanup cannot be established is kept. PUBLISHED rows are never purged.
 */
export async function purgeTerminalMediaVerifications(input: { db: PrismaClient; deps: VerifierDeps; retentionDays?: number }) {
  const now = input.deps.now();
  const cutoff = new Date(now.getTime() - (input.retentionDays ?? MEDIA_VERIFICATION_RETENTION_DAYS) * 86_400_000);
  const rows = await input.db.mediaVerification.findMany({
    where: { status: { in: ["REJECTED", "STALE", "CANCELED", "EXPIRED"] }, finishedAt: { lt: cutoff } },
    select: { id: true, stagedBucket: true, stagedKey: true, sealedKey: true, objectsClearedAt: true }, orderBy: { finishedAt: "asc" }, take: LIMIT,
  });
  let purged = 0, kept = 0;
  for (const row of rows) {
    const cleared = row.objectsClearedAt !== null ? true : await cleanupVerificationObjects({ db: input.db, deps: input.deps }, row);
    if (!cleared) { kept += 1; continue; }
    const removed = await input.db.mediaVerification.deleteMany({ where: { id: row.id, status: { in: ["REJECTED", "STALE", "CANCELED", "EXPIRED"] }, objectsClearedAt: { not: null } } });
    purged += removed.count;
  }
  return { examined: rows.length, purged, kept };
}
