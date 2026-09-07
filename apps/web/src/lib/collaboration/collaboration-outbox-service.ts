import "server-only";

import { randomUUID } from "node:crypto";

import { CollaborationOutboxEventType, JobStatus, JobType, Prisma } from "@internal/db";

import { db } from "@/lib/db";
import { enqueueExistingJob } from "@/lib/queue/enqueue-job";

type TransactionClient = Prisma.TransactionClient;
type SafeOutboxPayload = Record<string, string | number | boolean | null>;

const COLLABORATION_TRANSACTION_ATTEMPTS = 3;

function shouldRetryCollaborationTransaction(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034");
}

/**
 * PostgreSQL aborts the losing transaction on a concurrent unique conflict.
 * Retrying outside the transaction is therefore required for idempotent
 * collaboration commands; callers must put their domain write, notification,
 * and outbox intent in this one callback.
 */
export async function runCollaborationTransaction<T>(operation: (tx: TransactionClient) => Promise<T>) {
  let lastError: unknown;
  for (let attempt = 0; attempt < COLLABORATION_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(operation, { isolationLevel: "Serializable" });
    } catch (error) {
      lastError = error;
      if (!shouldRetryCollaborationTransaction(error) || attempt === COLLABORATION_TRANSACTION_ATTEMPTS - 1) throw error;
    }
  }
  throw lastError;
}

export type CreateOutboxEventInput = {
  datasetId: string;
  actorId: string;
  assetId?: string | null;
  recipientUserId?: string | null;
  type: CollaborationOutboxEventType;
  dedupeKey: string;
  payload: SafeOutboxPayload;
};

/**
 * Durable intent only: callers invoke this inside their already-authorized
 * Prisma transaction. The linked Job transports only its own id through
 * BullMQ; the worker resolves the outbox event from PostgreSQL.
 */
export async function createOrReuseCollaborationOutboxEvent(tx: TransactionClient, input: CreateOutboxEventInput) {
  const outboxEventId = randomUUID();
  const job = await tx.job.upsert({
    where: {
      datasetId_idempotencyKey: {
        datasetId: input.datasetId,
        idempotencyKey: `collaboration-outbox:${input.dedupeKey}`,
      },
    },
    create: {
      datasetId: input.datasetId,
      createdById: input.actorId,
      type: JobType.COLLABORATION_OUTBOX_DISPATCH,
      status: JobStatus.QUEUED,
      idempotencyKey: `collaboration-outbox:${input.dedupeKey}`,
      input: { outboxEventId },
    },
    update: {},
    select: { id: true },
  });

  const event = await tx.collaborationOutboxEvent.upsert({
    where: { dedupeKey: input.dedupeKey },
    create: {
      id: outboxEventId,
      datasetId: input.datasetId,
      assetId: input.assetId ?? null,
      recipientUserId: input.recipientUserId ?? null,
      actorId: input.actorId,
      type: input.type,
      dedupeKey: input.dedupeKey,
      payload: input.payload,
      jobId: job.id,
    },
    update: {},
    select: { id: true, jobId: true, dispatchedAt: true },
  });
  return { kind: event.id === outboxEventId ? "created" as const : "reused" as const, ...event };
}

/** Must run after the transaction resolves; a transport outage leaves the Job durable for recovery. */
export async function enqueueCollaborationOutboxDispatch(jobId: string) {
  return enqueueExistingJob(jobId, undefined, undefined);
}

/** Test/maintenance helper: never expose raw outbox payloads to browser code. */
export async function readOutboxDispatchState(jobId: string) {
  return db.collaborationOutboxEvent.findUnique({
    where: { jobId },
    select: { id: true, jobId: true, dispatchedAt: true, type: true, datasetId: true, assetId: true, recipientUserId: true },
  });
}
