import "server-only";

import { JobStatus, Prisma, type JobType } from "@internal/db";
import { getQueueDeliveryId, jobQueuePayloadSchema } from "@fieldframe/queue";

import type { RequestActor } from "@/lib/auth";
import { authorizeFoundationJobSubmission } from "@/lib/jobs/authorization";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { createWebQueue } from "@/lib/queue/bullmq-client";
import { resolveQueueName } from "@/lib/queue/queue-names";
import { validateSourceImportLimits } from "@/lib/source-access-policy";

type QueueEvent = "QUEUE_ENQUEUED" | "QUEUE_DELIVERY_PENDING";
type QueueEventReason = "QUEUE_UNAVAILABLE";
async function writeQueueEvent(jobId: string, message: QueueEvent, data: { queueName?: string; queueJobId?: string; reason?: QueueEventReason }) {
  await db.jobEvent.create({ data: { jobId, message, data } }).catch(() => undefined);
}

export async function createAndEnqueueFoundationJob(actor: RequestActor, input: unknown) {
  const authorized = await authorizeFoundationJobSubmission(actor, input);
  if (!authorized.ok) return authorized;

  const job = await db.job.create({ data: {
    datasetId: authorized.input.datasetId, createdById: actor.id, type: authorized.input.type,
    status: JobStatus.QUEUED, input: authorized.input.input,
  }, select: { id: true, datasetId: true, status: true, queueName: true, queueJobId: true, enqueuedAt: true } });

  return enqueueExistingJob(job.id, authorized.queueName, job);
}

export type SafeSourceJobInput = {
  datasetId: string;
  sourceConnectionId: string | null;
  repository: { provider: "GITEA"; owner: string; repo: string; branch: string; normalizedRootPath: string; visibility: "PUBLIC" | "PRIVATE" };
  manifest?: { itemCount: number; declaredBytes: number; durationMs?: number };
  retryOfJobId?: string;
};

const SOURCE_JOB_TRANSACTION_ATTEMPTS = 3;

/**
 * Creates a durable source Job only after re-reading source ownership/state in
 * PostgreSQL. The input deliberately has no token, URL, or provider response.
 */
export async function createAndEnqueueSourceImportJob(actor: RequestActor, input: SafeSourceJobInput) {
  const access = await requireDatasetPermission(actor, input.datasetId, "repository.sync");
  if (!access || access.forbidden) return { ok: false as const, status: access?.forbidden ? 403 as const : 404 as const };
  // Anonymous delivery is allowed only for an explicitly public repository.
  // A private repository must re-resolve an active owned connection below.
  if (!input.sourceConnectionId && input.repository.visibility !== "PUBLIC") return { ok: false as const, status: 409 as const };
  const limits = validateSourceImportLimits(input.manifest ?? { itemCount: 0, declaredBytes: 0 });
  if (!limits.ok) return { ok: false as const, status: 422 as const };
  let created: { id: string; datasetId: string; status: JobStatus; queueName: string | null; queueJobId: string | null; enqueuedAt: Date | null } | null = null;
  for (let attempt = 0; attempt < SOURCE_JOB_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      created = await db.$transaction(async (tx) => {
    if (input.sourceConnectionId) {
      const connection = await tx.sourceConnection.findFirst({
        where: { id: input.sourceConnectionId, userId: actor.id, provider: "GITEA", status: "ACTIVE", revokedAt: null, OR: [{ tokenExpiresAt: null }, { tokenExpiresAt: { gt: new Date() } }] },
        select: { id: true },
      });
      if (!connection) return null;
    }
    if (input.retryOfJobId) {
      const predecessor = await tx.job.findFirst({ where: { id: input.retryOfJobId, datasetId: input.datasetId, createdById: actor.id, status: { in: ["FAILED", "CANCELED"] } }, select: { id: true } });
      if (!predecessor) return null;
    }
        return tx.job.create({ data: {
      datasetId: input.datasetId, createdById: actor.id, type: "IMPORT_DATASET", status: JobStatus.QUEUED,
      sourceConnectionId: input.sourceConnectionId,
      retryOfJobId: input.retryOfJobId,
      input: { source: { repository: input.repository, manifest: input.manifest ?? { itemCount: 0, declaredBytes: 0 } } },
        }, select: { id: true, datasetId: true, status: true, queueName: true, queueJobId: true, enqueuedAt: true } });
      }, { isolationLevel: "Serializable" });
      break;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && input.retryOfJobId) {
        created = await db.job.findUnique({ where: { retryOfJobId: input.retryOfJobId }, select: { id: true, datasetId: true, status: true, queueName: true, queueJobId: true, enqueuedAt: true } });
        break;
      }
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034" || attempt === SOURCE_JOB_TRANSACTION_ATTEMPTS - 1) throw error;
    }
  }
  if (!created) return { ok: false as const, status: 409 as const };
  const queueName = resolveQueueName("IMPORT_DATASET");
  if (!queueName) return { ok: false as const, status: 400 as const };
  // $transaction resolves only after commit; transport is strictly post-commit.
  return enqueueExistingJob(created.id, queueName, created);
}

type QueueClient = {
  queue: { add: (name: string, payload: unknown, options?: { jobId?: string }) => Promise<unknown> };
  close: () => Promise<void>;
};
type EnqueueOptions = { createQueue?: () => QueueClient };

export async function enqueueExistingJob(
  jobId: string,
  expectedQueueName?: string,
  existing?: { id: string; datasetId: string; status: JobStatus; queueName: string | null; queueJobId: string | null; enqueuedAt: Date | null },
  options: EnqueueOptions = {},
) {
  const job = existing ?? await db.job.findUnique({ where: { id: jobId }, select: { id: true, datasetId: true, type: true, status: true, cancelRequestedAt: true, queueName: true, queueJobId: true, enqueuedAt: true } });
  if (!job || job.status !== JobStatus.QUEUED || ("cancelRequestedAt" in job && job.cancelRequestedAt)) return { ok: false as const, status: 409 as const };
  const queueName = expectedQueueName ?? resolveQueueName(("type" in job ? job.type : "") as JobType);
  if (!queueName) return { ok: false as const, status: 400 as const };
  const deliveryId = getQueueDeliveryId(job.id);
  if (job.enqueuedAt) {
    return job.queueName === queueName && job.queueJobId === deliveryId
      ? { ok: true as const, status: 200 as const, job, deliveryPending: false }
      : { ok: false as const, status: 409 as const };
  }
  const client = options.createQueue?.() ?? createWebQueue();
  try {
    await client.queue.add("durable-job", jobQueuePayloadSchema.parse({ jobId: job.id }), { jobId: deliveryId });
    const stamp = await db.job.updateMany({
      // A private worker may claim or even finish this Job immediately after
      // queue.add(). Transport stamping records that delivery fact and must not
      // lose the race solely because the authoritative lifecycle advanced.
      where: { id: job.id, enqueuedAt: null, queueName: null, queueJobId: null },
      data: { queueName, queueJobId: deliveryId, enqueuedAt: new Date() },
    });
    if (!stamp.count) {
      const reconciled = await db.job.findUnique({ where: { id: job.id }, select: { id: true, datasetId: true, status: true, queueName: true, queueJobId: true, enqueuedAt: true } });
      if (reconciled?.queueName === queueName && reconciled.queueJobId === deliveryId && reconciled.enqueuedAt) return { ok: true as const, status: 200 as const, job: reconciled, deliveryPending: false };
      return { ok: false as const, status: 409 as const };
    }
    const stamped = await db.job.findUniqueOrThrow({ where: { id: job.id }, select: { id: true, datasetId: true, status: true, queueName: true, queueJobId: true, enqueuedAt: true } });
    await writeQueueEvent(job.id, "QUEUE_ENQUEUED", { queueName, queueJobId: deliveryId });
    return { ok: true as const, status: 201 as const, job: stamped, deliveryPending: false };
  } catch {
    await writeQueueEvent(job.id, "QUEUE_DELIVERY_PENDING", { queueName, reason: "QUEUE_UNAVAILABLE" });
    return { ok: true as const, status: 202 as const, job, deliveryPending: true };
  } finally { await client.close(); }
}
