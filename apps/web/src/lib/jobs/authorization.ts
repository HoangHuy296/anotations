import "server-only";

import { JobStatus, JobType } from "@internal/db";
import { jobQueuePayloadSchema } from "@fieldframe/queue";
import { z } from "zod";
import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { resolveQueueName } from "@/lib/queue/queue-names";
import { foundationJobInputSchema } from "@/lib/validation/job";

export { jobQueuePayloadSchema } from "@fieldframe/queue";

/**
 * Minimal durable lookup used only to establish the Dataset authorization
 * boundary. It deliberately excludes Job input, state, result, summary,
 * errors, events, and queue transport internals.
 */
const jobAuthorizationSelect = {
  id: true,
  datasetId: true,
  status: true,
  createdById: true,
} as const;

/**
 * Guard to call before creating/cancelling a durable Job. It deliberately does
 * not enqueue or process work: PostgreSQL creation and the queue transport are
 * separate later-phase responsibilities.
 */
export async function requireJobPermission(actor: RequestActor, datasetId: string, permission: "job.createExport" | "job.cancel" | "dataset.read") {
  return requireDatasetPermission(actor, datasetId, permission);
}

export function cleanJobPayload(jobId: string) { return jobQueuePayloadSchema.parse({ jobId }); }

/**
 * Validates a foundation submission at the server boundary. This function
 * neither creates a Job nor talks to Redis; callers keep those durable and
 * transport steps explicit and ordered.
 */
export async function authorizeFoundationJobSubmission(actor: RequestActor, input: unknown) {
  const parsed = foundationJobInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, status: 400 as const };
  const queueName = resolveQueueName(parsed.data.type);
  if (!queueName) return { ok: false as const, status: 400 as const };
  const access = await requireJobPermission(actor, parsed.data.datasetId, "job.createExport");
  if (!access) return { ok: false as const, status: 404 as const };
  if (access.forbidden) return { ok: false as const, status: 403 as const };
  return { ok: true as const, input: parsed.data, queueName };
}

const exportInputSchema = z.object({ datasetId: z.string().cuid(), input: z.record(z.string(), z.json()).default({}) });

/** Creates PostgreSQL Job authority only; enqueue remains an explicit later-phase step. */
export async function createAuthorizedExportJob(actor: RequestActor, input: unknown) {
  const parsed = exportInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, status: 400 as const };
  const access = await requireJobPermission(actor, parsed.data.datasetId, "job.createExport");
  if (!access) return { ok: false as const, status: 404 as const };
  if (access.forbidden) return { ok: false as const, status: 403 as const };
  const job = await db.job.create({
    data: {
      datasetId: parsed.data.datasetId,
      createdById: actor.id,
      type: JobType.EXPORT_DATASET,
      status: JobStatus.QUEUED,
      input: parsed.data.input,
    },
    select: { id: true, datasetId: true, createdById: true, status: true },
  });
  return { ok: true as const, status: 201 as const, job };
}

export async function readAuthorizedJob(actor: RequestActor, jobId: string) {
  const job = await db.job.findFirst({ where: { id: jobId }, select: jobAuthorizationSelect });
  if (!job) return { ok: false as const, status: 404 as const };
  const access = await requireJobPermission(actor, job.datasetId, "dataset.read");
  if (!access) return { ok: false as const, status: 404 as const };
  if (access.forbidden) return { ok: false as const, status: 403 as const };
  return { ok: true as const, status: 200 as const, job };
}

export async function cancelAuthorizedJob(actor: RequestActor, jobId: string) {
  const job = await db.job.findFirst({ where: { id: jobId }, select: { id: true, datasetId: true } });
  if (!job) return { ok: false as const, status: 404 as const };
  const access = await requireJobPermission(actor, job.datasetId, "job.cancel");
  if (!access) return { ok: false as const, status: 404 as const };
  if (access.forbidden) return { ok: false as const, status: 403 as const };
  await db.job.updateMany({ where: { id: job.id, status: { in: [JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.RETRYING] } }, data: { status: JobStatus.CANCELING, cancelRequestedAt: new Date(), canceledById: actor.id } });
  return { ok: true as const, status: 200 as const };
}
