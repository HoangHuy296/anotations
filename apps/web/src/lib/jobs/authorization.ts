import "server-only";

import { JobStatus, JobType } from "@internal/db";
import { jobQueuePayloadSchema } from "@fieldframe/queue";
import { z } from "zod";
import { datasetIdSchema } from "@/lib/validation/dataset";
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
export type JobPermission = "job.createExport" | "job.cancel" | "job.retry" | "dataset.read";

export async function requireJobPermission(actor: RequestActor, datasetId: string, permission: JobPermission) {
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

const exportInputSchema = z.object({ datasetId: datasetIdSchema, input: z.record(z.string(), z.json()).default({}) });

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

/**
 * Resolves the durable Job and applies a Dataset-scoped action permission.
 * This intentionally conceals a Job from non-members, even when its id is
 * known. Callers must not perform a second unscoped lookup after this guard.
 */
export async function readAuthorizedJobForAction(actor: RequestActor, jobId: string, permission: JobPermission) {
  const job = await db.job.findFirst({ where: { id: jobId }, select: jobAuthorizationSelect });
  if (!job) return { ok: false as const, status: 404 as const };
  const access = await requireJobPermission(actor, job.datasetId, permission);
  if (!access) return { ok: false as const, status: 404 as const };
  if (access.forbidden) return { ok: false as const, status: 403 as const };
  return { ok: true as const, status: 200 as const, job };
}

export async function cancelAuthorizedJob(actor: RequestActor, jobId: string) {
  const authorized = await readAuthorizedJobForAction(actor, jobId, "job.cancel");
  if (!authorized.ok) return authorized;

  const now = new Date();
  const terminalCancel = {
    status: JobStatus.CANCELED,
    cancelRequestedAt: now,
    canceledById: actor.id,
    canceledAt: now,
    finishedAt: now,
    lockedBy: null,
    lockToken: null,
    lockedAt: null,
    lockedUntil: null,
    heartbeatAt: null,
  } as const;

  // The status predicate is repeated in the mutation: a status observed by
  // the authorization lookup is never treated as permission to overwrite a
  // concurrent worker transition.
  const outcome = await db.$transaction(async (tx) => {
    let updated;
    let mode: "CANCELED" | "CANCELING";
    if (authorized.job.status === JobStatus.QUEUED) {
      mode = "CANCELED";
      updated = await tx.job.updateMany({ where: { id: jobId, status: JobStatus.QUEUED }, data: terminalCancel });
    } else if (authorized.job.status === JobStatus.RETRYING) {
      mode = "CANCELED";
      updated = await tx.job.updateMany({
        where: { id: jobId, status: JobStatus.RETRYING, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
        data: terminalCancel,
      });
    } else if (authorized.job.status === JobStatus.RUNNING) {
      mode = "CANCELING";
      updated = await tx.job.updateMany({
        where: { id: jobId, status: JobStatus.RUNNING },
        data: { status: JobStatus.CANCELING, cancelRequestedAt: now, canceledById: actor.id },
      });
    } else {
      return null;
    }
    if (updated.count !== 1) return null;

    await tx.jobEvent.create({
      data: {
        jobId,
        level: "INFO",
        message: mode === "CANCELED" ? "JOB_CANCELED" : "CANCEL_REQUESTED",
        // Fixed, allowlisted event metadata only. Never copy Job input/state
        // or worker/queue fields into an application event.
        data: { action: mode === "CANCELED" ? "canceled" : "cancel_requested" },
      },
    });
    return mode;
  });

  if (!outcome) return { ok: false as const, status: 409 as const };
  return { ok: true as const, status: 200 as const, cancellationStatus: outcome };
}
