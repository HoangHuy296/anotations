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
  skippedItems: true, summary: true, createdAt: true, updatedAt: true,
} as const;

type ExportJobProjection = PrismaTypes.JobGetPayload<{ select: typeof exportJobSelect }>;

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
  let job = await db.job.findFirst({
    where: { datasetId: parsed.data.datasetId, idempotencyKey, type: JobType.EXPORT_DATASET },
    select: exportJobSelect,
  });
  if (!job) {
    try {
      job = await db.job.create({
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
      created = true;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      job = await db.job.findFirst({
        where: { datasetId: parsed.data.datasetId, idempotencyKey, type: JobType.EXPORT_DATASET },
        select: exportJobSelect,
      });
      if (!job) throw error;
    }
  }

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
