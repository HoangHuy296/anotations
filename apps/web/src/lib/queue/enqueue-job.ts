import "server-only";

import { DatasetSourceMode, JobStatus, Prisma, RepoProvider, type JobType } from "@internal/db";
import { getQueueDeliveryId, jobQueuePayloadSchema } from "@annotationplatform/queue";
import { logJobEvent, logRedisEvent } from "@annotationplatform/domain";

import type { RequestActor } from "@/lib/auth";
import { authorizeFoundationJobSubmission } from "@/lib/jobs/authorization";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { createWebQueue } from "@/lib/queue/bullmq-client";
import { resolveQueueName } from "@/lib/queue/queue-names";
import { validateSourceImportLimits } from "@/lib/source-access-policy";
import { encryptSourceToken } from "@/lib/source-connection-crypto";
import {
  buildSafeRepositoryImportJobInput,
  reconcileDatasetCreationIdempotency,
} from "@/lib/repository-import/types";

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
  logJobEvent("JOB_CREATED", { jobId: job.id, type: authorized.input.type, status: job.status });

  return enqueueExistingJob(job.id, authorized.queueName, job);
}

export type SafeSourceJobInput = {
  datasetId: string;
  sourceConnectionId: string | null;
  repository: { provider: "GITEA"; owner: string; repo: string; branch: string; normalizedRootPath: string; visibility: "PUBLIC" | "PRIVATE" };
  manifest?: { itemCount: number; declaredBytes: number; durationMs?: number };
  retryOfJobId?: string;
};

export type NewDatasetSourceImportInput = {
  datasetName: string;
  /** Present only for the durable Phase-015 repository-create contract. */
  creationIdempotency?: { key: string; requestHash: string };
  sourceConnection: { id: string; baseUrl: string } | null;
  createSourceConnection: { name: string; baseUrl: string; token: string } | null;
  repository: {
    provider: "GITEA" | "GITHUB";
    baseUrl: string;
    owner: string;
    repo: string;
    ref: string;
    normalizedRootPath: string;
    visibility: "PUBLIC" | "PRIVATE";
  };
  manifest: { itemCount: number; declaredBytes: number; durationMs?: number };
};

type NewDatasetImportJob = {
  id: string;
  datasetId: string;
  status: JobStatus;
  queueName: string | null;
  queueJobId: string | null;
  enqueuedAt: Date | null;
  sourceConnectionId: string | null;
};

type NewDatasetCreation =
  | { kind: "created"; job: NewDatasetImportJob; sourceConnectionId: string | null }
  | { kind: "reused"; job: NewDatasetImportJob; sourceConnectionId: string | null }
  | { kind: "conflict" }
  | null;

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
  // Logged once here (post-commit), not inside the transaction callback
  // above — that callback can retry on a serialization conflict
  // (P2034), and logging inside it would double-log a single eventual
  // success.
  logJobEvent("JOB_CREATED", { jobId: created.id, type: "IMPORT_DATASET", status: created.status });
  // $transaction resolves only after commit; transport is strictly post-commit.
  return enqueueExistingJob(created.id, queueName, created);
}

/**
 * Approved new-Dataset source-import boundary. It is intentionally separate
 * from the existing-Dataset helper above: the latter must keep its Dataset
 * permission semantics for source-job ownership/race tests.
 *
 * A one-time PAT reaches this function only in server memory. The transaction
 * encrypts it before persistence, and the durable Job payload contains no
 * credential material.
 */
export async function createAndEnqueueNewDatasetSourceImportJob(
  actor: RequestActor,
  input: NewDatasetSourceImportInput,
) {
  const limits = validateSourceImportLimits(input.manifest);
  if (!limits.ok) return { ok: false as const, status: 422 as const };
  if (input.repository.visibility === "PRIVATE" && !input.sourceConnection && !input.createSourceConnection) {
    return { ok: false as const, status: 409 as const };
  }

  const resolveIdempotentResult = async (client: typeof db): Promise<NewDatasetCreation> => {
    if (!input.creationIdempotency) return null;
    const existing = await client.dataset.findUnique({
      where: {
        ownerId_creationIdempotencyKey: {
          ownerId: actor.id,
          creationIdempotencyKey: input.creationIdempotency.key,
        },
      },
      select: {
        id: true,
        sourceConnectionId: true,
        creationRequestHash: true,
        jobs: {
          where: { type: "IMPORT_DATASET", createdById: actor.id, idempotencyKey: input.creationIdempotency.key },
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { id: true, datasetId: true, status: true, queueName: true, queueJobId: true, enqueuedAt: true, sourceConnectionId: true },
        },
      },
    });
    const reconciliation = reconcileDatasetCreationIdempotency(
      existing
        ? { creationRequestHash: existing.creationRequestHash, job: existing.jobs[0] ?? null }
        : null,
      input.creationIdempotency.requestHash,
    );
    if (reconciliation.kind === "absent") return null;
    if (reconciliation.kind === "conflict") return { kind: "conflict" };
    return {
      kind: "reused",
      job: reconciliation.job,
      sourceConnectionId: existing!.sourceConnectionId,
    };
  };

  const create = async (): Promise<NewDatasetCreation> => db.$transaction(async (tx) => {
    const existing = await resolveIdempotentResult(tx as typeof db);
    if (existing) return existing;
    let sourceConnectionId: string | null = null;

    if (input.sourceConnection) {
      const connection = await tx.sourceConnection.findFirst({
        where: {
          id: input.sourceConnection.id,
          userId: actor.id,
          provider: RepoProvider.GITEA,
          status: "ACTIVE",
          revokedAt: null,
          OR: [{ tokenExpiresAt: null }, { tokenExpiresAt: { gt: new Date() } }],
        },
        select: { id: true },
      });
      if (!connection) return null;
      sourceConnectionId = connection.id;
    } else if (input.createSourceConnection) {
      const connection = await tx.sourceConnection.create({
        data: {
          userId: actor.id,
          provider: RepoProvider.GITEA,
          name: input.createSourceConnection.name,
          baseUrl: input.createSourceConnection.baseUrl,
          tokenEncrypted: encryptSourceToken(input.createSourceConnection.token),
          status: "ACTIVE",
        },
        select: { id: true },
      });
      sourceConnectionId = connection.id;
    }

    const dataset = await tx.dataset.create({
      data: {
        ownerId: actor.id,
        name: input.datasetName,
        sourceMode: DatasetSourceMode.MIRROR_TO_MINIO,
        sourceConnectionId,
        sourceRef: input.repository.ref,
        sourceRootPath: input.repository.normalizedRootPath || null,
        ...(input.creationIdempotency
          ? {
              creationIdempotencyKey: input.creationIdempotency.key,
              creationRequestHash: input.creationIdempotency.requestHash,
            }
          : {}),
      },
      select: { id: true },
    });

    const job = await tx.job.create({
      data: {
        datasetId: dataset.id,
        createdById: actor.id,
        type: "IMPORT_DATASET",
        status: JobStatus.QUEUED,
        sourceConnectionId,
        provider: input.repository.provider,
        idempotencyKey: input.creationIdempotency?.key,
        totalItems: input.manifest.itemCount,
        // The worker re-resolves any server/provider address from its
        // configured provider adapter or SourceConnection. Durable input is
        // limited to repository identity, bounded manifest metadata, and the
        // optional credential reference; it never contains a URL or token.
        input: buildSafeRepositoryImportJobInput({
          provider: input.repository.provider,
          owner: input.repository.owner,
          repo: input.repository.repo,
          ref: input.repository.ref,
          normalizedRootPath: input.repository.normalizedRootPath || null,
          visibility: input.repository.visibility,
          sourceConnectionId,
          manifest: input.manifest,
        }),
      },
      select: { id: true, datasetId: true, status: true, queueName: true, queueJobId: true, enqueuedAt: true, sourceConnectionId: true },
    });
    return { kind: "created", job, sourceConnectionId };
  }, { isolationLevel: "Serializable" });

  let created: NewDatasetCreation = null;
  for (let attempt = 0; attempt < SOURCE_JOB_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      created = await create();
      break;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && input.creationIdempotency) {
        created = await resolveIdempotentResult(db);
        break;
      }
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034" || attempt === SOURCE_JOB_TRANSACTION_ATTEMPTS - 1) throw error;
    }
  }

  if (!created) return { ok: false as const, status: 404 as const };
  if (created.kind === "conflict") return { ok: false as const, status: 409 as const, reason: "IDEMPOTENCY_KEY_CONFLICT" as const };
  if (created.kind === "reused") {
    return {
      ok: true as const,
      status: 200 as const,
      job: created.job,
      datasetId: created.job.datasetId,
      sourceConnectionId: created.sourceConnectionId,
      // A concurrent replay can observe the committed Dataset/Job before the
      // first request has stamped queue transport fields. It is still the
      // same accepted durable request, so preserve the idempotency contract
      // (200) rather than projecting it as a second 202 acceptance. The
      // original request/recovery scanner remains solely responsible for
      // delivery; this replay never calls enqueue again.
      deliveryPending: false,
      reused: true as const,
    };
  }
  const queueName = resolveQueueName("IMPORT_DATASET");
  if (!queueName) return { ok: false as const, status: 400 as const };
  // Post-commit, and only for a genuine fresh creation — the "reused"
  // (idempotent replay) branch above returns before this point and is
  // deliberately not logged as a second creation.
  logJobEvent("JOB_CREATED", { jobId: created.job.id, type: "IMPORT_DATASET", status: created.job.status });
  const delivery = await enqueueExistingJob(created.job.id, queueName, created.job);
  if (!delivery.ok) return delivery;
  return { ...delivery, datasetId: created.job.datasetId, sourceConnectionId: created.sourceConnectionId, reused: false as const };
}

type QueueClient = {
  queue: { add: (name: string, payload: unknown, options?: { jobId?: string }) => Promise<unknown> };
  close: () => Promise<void>;
};
type EnqueueOptions = { createQueue?: () => QueueClient };

/**
 * The queue transport contract is deliberately constructed in one place: it
 * contains the durable Job identifier and nothing else. PostgreSQL remains
 * the source for all Job input and state.
 */
export function buildDurableJobQueueDelivery(jobId: string) {
  return {
    name: "durable-job" as const,
    payload: jobQueuePayloadSchema.parse({ jobId }),
    queueJobId: getQueueDeliveryId(jobId),
  };
}

/**
 * 021-production-hardening-garbage-collection (FR-016/FR-017): every
 * Job-creating path in this file — `createAndEnqueueFoundationJob`,
 * `createAndEnqueueSourceImportJob`, `createAndEnqueueNewDatasetSourceImportJob`
 * — terminates in this one function, and only here. A Redis/queue outage
 * therefore has exactly one place to be handled honestly: on a `queue.add()`
 * failure, the Job's `queueName`/`queueJobId`/`enqueuedAt` are never
 * stamped, a `QUEUE_DELIVERY_PENDING` event is recorded, and the caller
 * receives `deliveryPending: true` (never a false "queued" success). A
 * future Job-creation path must call this function rather than
 * `queue.add()` directly, or it silently loses this guarantee.
 */
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
  const delivery = buildDurableJobQueueDelivery(job.id);
  const deliveryId = delivery.queueJobId;
  if (job.enqueuedAt) {
    return job.queueName === queueName && job.queueJobId === deliveryId
      ? { ok: true as const, status: 200 as const, job, deliveryPending: false }
      : { ok: false as const, status: 409 as const };
  }
  // Construction may fail before `queue.add()` when the local Redis transport
  // is unavailable. The Job is already durable, so preserve it as QUEUED for
  // recovery rather than allowing a route-level 500.
  let client: QueueClient | null = null;
  try {
    client = options.createQueue?.() ?? createWebQueue();
    await client.queue.add(delivery.name, delivery.payload, { jobId: delivery.queueJobId });
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
    logJobEvent("QUEUE_ENQUEUED", { jobId: job.id, status: stamped.status });
    return { ok: true as const, status: 201 as const, job: stamped, deliveryPending: false };
  } catch (error) {
    // 021-production-hardening-garbage-collection (FR-017): a Redis/queue
    // enqueue failure is never swallowed — it is always both recorded as a
    // JobEvent (above the browser-safe line — see safe-job-event.ts) and
    // logged here, in addition to the honest `deliveryPending: true` this
    // function already returns instead of a false "queued" success.
    logRedisEvent("ENQUEUE_FAILED", { detail: error instanceof Error ? error.message : "unknown error" }, "error");
    await writeQueueEvent(job.id, "QUEUE_DELIVERY_PENDING", { queueName, reason: "QUEUE_UNAVAILABLE" });
    return { ok: true as const, status: 202 as const, job, deliveryPending: true };
  } finally { await client?.close().catch(() => undefined); }
}
