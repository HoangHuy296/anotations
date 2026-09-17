import "server-only";

import { JobStatus, JobType, Modality, Prisma } from "@internal/db";
import { TEXT_SOURCE_PREPARE_PROCESSOR_VERSION, type TextSourcePrepareExpectedSource } from "@annotationplatform/domain/text-source-prepare-job";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { enqueueExistingJob } from "@/lib/queue/enqueue-job";
import { resolveQueueName } from "@/lib/queue/queue-names";

/**
 * The reviewed authorization decision (research.md "Implementation-readiness
 * review amendment"): `dataset.read` authorizes TEXT derivative preparation
 * and subsequent source reads, independent of `annotation.create` and any
 * review-freeze workflow state. A reviewer inspecting a NEEDS_REVIEW/
 * REVIEWED/REJECTED asset can still trigger preparation of an unprepared
 * source. This deliberately does not grant `job.cancel`/`job.retry` — those
 * remain the existing generic Job-authorization boundary
 * (`apps/web/src/lib/jobs/authorization.ts`).
 */

function jobIdempotencyKey(assetId: string, source: TextSourcePrepareExpectedSource): string {
  return `text-source-prepare:${assetId}:${source.checksum ?? "no-checksum"}:${source.sizeBytes ?? "0"}:${TEXT_SOURCE_PREPARE_PROCESSOR_VERSION}`;
}

export type TextSourcePrepareRequestOutcome =
  | { ok: true; job: { id: string; status: JobStatus }; created: boolean }
  | { ok: false; reason: "NOT_FOUND" | "SOURCE_UNAVAILABLE" };

/**
 * Idempotently creates or reuses one common Job per asset/source/profile:
 * a duplicate request for the same still-current source identity reuses the
 * existing Job (whatever its status) rather than queuing a second attempt;
 * only the durable `jobId` ever crosses into the queue transport.
 */
export async function requestTextSourcePreparation(actor: RequestActor, assetId: string): Promise<TextSourcePrepareRequestOutcome> {
  const asset = await db.asset.findFirst({
    where: { id: assetId, deletedAt: null, archivedAt: null, modality: Modality.TEXT },
    select: { id: true, datasetId: true, storageBucket: true, storageKey: true, checksum: true, sizeBytes: true },
  });
  if (!asset) return { ok: false, reason: "NOT_FOUND" };

  const access = await requireDatasetPermission(actor, asset.datasetId, "dataset.read");
  if (!access || access.forbidden) return { ok: false, reason: "NOT_FOUND" };

  if (!asset.storageBucket || !asset.storageKey) return { ok: false, reason: "SOURCE_UNAVAILABLE" };

  const expectedSource: TextSourcePrepareExpectedSource = {
    storageBucket: asset.storageBucket,
    storageKey: asset.storageKey,
    checksum: asset.checksum,
    sizeBytes: asset.sizeBytes !== null ? asset.sizeBytes.toString() : null,
  };
  const idempotencyKey = jobIdempotencyKey(asset.id, expectedSource);
  const jobSelect = { id: true, status: true } as const;

  let created = true;
  let job: { id: string; status: JobStatus };
  try {
    job = await db.job.create({
      data: {
        datasetId: asset.datasetId,
        createdById: actor.id,
        type: JobType.TEXT_SOURCE_PREPARE,
        modality: Modality.TEXT,
        status: JobStatus.QUEUED,
        idempotencyKey,
        input: { actorId: actor.id, datasetId: asset.datasetId, assetId: asset.id, mode: "OBJECT_SOURCE", expectedSource },
      },
      select: jobSelect,
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const existing = await db.job.findFirst({ where: { datasetId: asset.datasetId, idempotencyKey, type: JobType.TEXT_SOURCE_PREPARE }, select: jobSelect });
    if (!existing) throw error;
    created = false;
    job = existing;
  }

  if (job.status !== JobStatus.QUEUED) return { ok: true, job, created };

  const queueName = resolveQueueName(JobType.TEXT_SOURCE_PREPARE);
  if (!queueName) return { ok: true, job, created };
  const delivery = await enqueueExistingJob(job.id, queueName);
  return { ok: true, job: delivery.ok ? { id: job.id, status: delivery.job?.status ?? job.status } : job, created };
}
