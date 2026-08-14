import "server-only";

import { createHash } from "node:crypto";

import { JobStatus, JobType, Prisma, type Prisma as PrismaTypes } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { toSafeJobStatus } from "@/lib/jobs/safe-job-status";
import { enqueueExistingJob } from "@/lib/queue/enqueue-job";
import { exportRequestSchema } from "@/lib/validation/export";
import type { SafeExportJob } from "@/lib/exports/types";

const exportJobSelect = {
  id: true, datasetId: true, type: true, status: true, stage: true, progress: true,
  totalItems: true, processedItems: true, successItems: true, failedItems: true,
  skippedItems: true, summary: true, errorCode: true, createdAt: true, startedAt: true, finishedAt: true, updatedAt: true,
} as const;

type ExportJobProjection = PrismaTypes.JobGetPayload<{ select: typeof exportJobSelect }>;

/** COMPLETED/FAILED/CANCELED never re-run; a new create request supersedes them instead of reusing their result forever. */
const terminalJobStatuses = new Set<typeof JobStatus[keyof typeof JobStatus]>([JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELED]);

function exportIdempotencyKey(datasetId: string) {
  return createHash("sha256").update(`fieldframe:export:v1:${datasetId}:JSON:1`).digest("hex");
}

function toSafeExportJob(job: ExportJobProjection): SafeExportJob {
  if (job.type !== JobType.EXPORT_DATASET) throw new Error("Export Job projection received a non-export Job.");
  return { ...toSafeJobStatus(job), type: "EXPORT_DATASET" };
}

export type CreateExportResult =
  | { ok: false; status: 400 | 403 | 404 | 409 }
  | { ok: true; status: 200 | 201 | 202; job: SafeExportJob; deliveryPending: boolean };

/**
 * Creates (or safely reuses) the PostgreSQL authority before asking BullMQ to
 * deliver the one permitted transport payload. No browser input controls Job
 * ownership, status, queue fields, or storage location.
 */
export async function createAuthorizedExportJob(actor: RequestActor, input: unknown): Promise<CreateExportResult> {
  const parsed = exportRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400 };

  const access = await requireDatasetPermission(actor, parsed.data.datasetId, "job.createExport");
  if (!access) return { ok: false, status: 404 };
  if (access.forbidden) return { ok: false, status: 403 };

  const idempotencyKey = exportIdempotencyKey(parsed.data.datasetId);
  let created = false;
  let job: ExportJobProjection | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    created = false;
    try {
      job = await db.$transaction(async (tx) => {
        const existing = await tx.job.findFirst({
          where: { datasetId: parsed.data.datasetId, idempotencyKey, type: JobType.EXPORT_DATASET },
          select: exportJobSelect,
        });
        // A pending/running export is reused outright -- this is the
        // duplicate-start protection the canonical key exists for.
        if (existing && !terminalJobStatuses.has(existing.status)) return existing;
        if (existing) {
          // The canonical key belongs to a finished export. Free it by
          // demoting the finished predecessor to a unique historical key
          // (its row/artifact is untouched and still independently
          // readable via GET /api/export/[jobId]) so a fresh Job -- one
          // that will reflect the dataset's current content -- can claim
          // the canonical key below. Users can otherwise never export a
          // dataset a second time once its first export finishes.
          await tx.job.update({ where: { id: existing.id }, data: { idempotencyKey: `${idempotencyKey}:superseded:${existing.id}` } });
        }
        created = true;
        return tx.job.create({
          data: {
            datasetId: parsed.data.datasetId,
            createdById: actor.id,
            type: JobType.EXPORT_DATASET,
            status: JobStatus.QUEUED,
            idempotencyKey,
            input: { format: parsed.data.format, manifestSchemaVersion: parsed.data.manifestSchemaVersion },
          },
          select: exportJobSelect,
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      break;
    } catch (error) {
      // A serializable transaction may be retried after having reached the
      // create branch. Its rolled-back local decision must not affect the
      // response for the request that subsequently observes the winner.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && attempt < 2) continue;
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      created = false;
      job = await db.job.findFirst({
        where: { datasetId: parsed.data.datasetId, idempotencyKey, type: JobType.EXPORT_DATASET },
        select: exportJobSelect,
      });
      if (!job) throw error;
      break;
    }
  }
  if (!job) throw new Error("Export Job was not resolved.");

  if (job.status !== JobStatus.QUEUED) {
    return { ok: true, status: 200, job: toSafeExportJob(job), deliveryPending: false };
  }
  const delivery = await enqueueExistingJob(job.id);
  if (!delivery.ok) return { ok: false, status: delivery.status === 400 ? 409 : delivery.status };
  const current = await db.job.findUnique({ where: { id: job.id }, select: exportJobSelect });
  if (!current || current.type !== JobType.EXPORT_DATASET) return { ok: false, status: 409 };
  return {
    ok: true,
    status: delivery.deliveryPending ? 202 : created ? 201 : 200,
    job: toSafeExportJob(current),
    deliveryPending: delivery.deliveryPending,
  };
}

export async function readSafeExportJob(jobId: string) {
  const job = await db.job.findFirst({ where: { id: jobId, type: JobType.EXPORT_DATASET }, select: exportJobSelect });
  return job ? toSafeExportJob(job) : null;
}
