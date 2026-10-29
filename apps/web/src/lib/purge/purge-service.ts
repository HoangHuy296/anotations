import "server-only";

import { createHash } from "node:crypto";

import { JobStatus, JobType, Prisma } from "@internal/db";
import { logJobEvent } from "@annotationplatform/domain";
import { PURGE_ASSETS_MAX } from "@annotationplatform/domain/purge-job";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { enqueueExistingJob } from "@/lib/queue/enqueue-job";
import { resolveQueueName } from "@/lib/queue/queue-names";

export type PurgeRequestResult =
  | { ok: true; jobId: string; deliveryPending: boolean }
  | { ok: false; code: "NOT_FOUND" | "FORBIDDEN" | "NAME_MISMATCH" | "ACTIVE_JOBS" | "TOO_MANY" | "EMPTY" };

const ACTIVE_STATUSES = [JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.RETRYING, JobStatus.CANCELING];
const PURGE_TYPES = [JobType.PURGE_DATASET, JobType.PURGE_ASSETS];
const jobSelect = { id: true, datasetId: true, status: true, queueName: true, queueJobId: true, enqueuedAt: true } as const;

/** A purge never races other work on the same dataset: imports, exports, AI and media verification must finish (or be cancelled) first. */
async function hasActiveNonPurgeJobs(datasetId: string) {
  return (await db.job.count({ where: { datasetId, status: { in: ACTIVE_STATUSES }, type: { notIn: PURGE_TYPES } } })) > 0;
}

async function createAndEnqueue(actorId: string, datasetId: string, type: "PURGE_DATASET" | "PURGE_ASSETS", idempotencyKey: string, input: Prisma.InputJsonValue, hide: Prisma.PrismaPromise<unknown>[]) {
  let job;
  try {
    const [created] = await db.$transaction([
      db.job.create({ data: { datasetId, createdById: actorId, type, status: JobStatus.QUEUED, idempotencyKey, input }, select: jobSelect }),
      ...hide,
    ]);
    job = created;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const existing = await db.job.findFirst({ where: { datasetId, idempotencyKey, type }, select: jobSelect });
    if (!existing) throw error;
    job = existing;
  }
  logJobEvent("JOB_CREATED", { jobId: job.id, type, status: job.status });
  if (job.status !== JobStatus.QUEUED) return { ok: true as const, jobId: job.id, deliveryPending: false };
  const delivered = await enqueueExistingJob(job.id, resolveQueueName(type) ?? undefined, job);
  return { ok: true as const, jobId: job.id, deliveryPending: "deliveryPending" in delivered ? Boolean(delivered.deliveryPending) : false };
}

/**
 * Owner-only permanent delete of a whole dataset. The caller must type the exact dataset name. The dataset is hidden at once
 * (`deletedAt`) and a PURGE_DATASET Job removes the MinIO objects first, then the PostgreSQL rows.
 */
export async function requestDatasetPurge(actor: RequestActor, datasetId: string, confirmName: string): Promise<PurgeRequestResult> {
  const access = await requireDatasetPermission(actor, datasetId, "dataset.delete");
  if (!access) return { ok: false, code: "NOT_FOUND" };
  if (access.forbidden) return { ok: false, code: "FORBIDDEN" };
  const named = await db.dataset.findUnique({ where: { id: datasetId }, select: { name: true } });
  if (!named || confirmName.trim() !== named.name) return { ok: false, code: "NAME_MISMATCH" };
  if (await hasActiveNonPurgeJobs(datasetId)) return { ok: false, code: "ACTIVE_JOBS" };
  return createAndEnqueue(actor.id, datasetId, "PURGE_DATASET", `purge:dataset:${datasetId}`, {}, [
    db.dataset.updateMany({ where: { id: datasetId, deletedAt: null }, data: { deletedAt: new Date() } }),
  ]);
}

/** Owner-only permanent delete of explicit assets (hidden at once, purged by a PURGE_ASSETS Job). */
export async function requestAssetsPurge(actor: RequestActor, datasetId: string, assetIds: string[]): Promise<PurgeRequestResult> {
  const access = await requireDatasetPermission(actor, datasetId, "dataset.delete");
  if (!access) return { ok: false, code: "NOT_FOUND" };
  if (access.forbidden) return { ok: false, code: "FORBIDDEN" };
  const ids = [...new Set(assetIds)];
  if (!ids.length) return { ok: false, code: "EMPTY" };
  if (ids.length > PURGE_ASSETS_MAX) return { ok: false, code: "TOO_MANY" };
  const existing = await db.asset.findMany({ where: { id: { in: ids }, datasetId }, select: { id: true } });
  if (!existing.length) return { ok: false, code: "NOT_FOUND" };
  if (await hasActiveNonPurgeJobs(datasetId)) return { ok: false, code: "ACTIVE_JOBS" };
  const sorted = existing.map((row) => row.id).sort();
  const key = `purge:assets:${createHash("sha256").update(sorted.join(",")).digest("hex")}`;
  return createAndEnqueue(actor.id, datasetId, "PURGE_ASSETS", key, { assetIds: sorted }, [
    db.asset.updateMany({ where: { id: { in: sorted }, datasetId, deletedAt: null }, data: { deletedAt: new Date() } }),
  ]);
}
