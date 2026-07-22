import "server-only";

import { JobStatus, JobTrigger, Prisma, type JobType } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { db } from "@/lib/db";
import { readAuthorizedJobForAction } from "@/lib/jobs/authorization";
import { enqueueExistingJob } from "@/lib/queue/enqueue-job";
import { resolveQueueName } from "@/lib/queue/queue-names";
import { exportJobInputSchema } from "@/lib/validation/export";

type RetryContext = {
  datasetId: string;
  type: JobType;
  modality: "IMAGE" | "VIDEO" | "TEXT" | "AUDIO" | null;
  input: unknown;
};

/**
 * This is deliberately type-specific rather than a copy of Job.input. New
 * queue types must receive an explicit reviewed mapping here; raw input/state,
 * errors, provider connections and storage references never cross retries.
 */
function extractRetryContext(job: RetryContext): { input: { format: "JSON"; manifestSchemaVersion: "1" }; modality: RetryContext["modality"] } | null {
  switch (job.type) {
    case "EXPORT_DATASET": {
      const parsed = exportJobInputSchema.safeParse(job.input);
      // Historical failed export Jobs predate the explicit contract. Their
      // arbitrary JSON is discarded and replaced with the sole canonical
      // supported configuration rather than copied to the successor.
      return {
        input: parsed.success ? parsed.data : { format: "JSON", manifestSchemaVersion: "1" },
        modality: job.modality,
      };
    }
    default:
      return null;
  }
}

export type RetryJobResult =
  | { ok: false; status: 403 | 404 | 409 }
  | { ok: true; status: 200 | 201; job: { id: string; datasetId: string; type: JobType; status: JobStatus } };

export async function retryAuthorizedJob(actor: RequestActor, jobId: string): Promise<RetryJobResult> {
  const authorized = await readAuthorizedJobForAction(actor, jobId, "job.retry");
  if (!authorized.ok) return authorized;

  const queueName = await db.job.findUnique({
    where: { id: authorized.job.id },
    select: { id: true, datasetId: true, type: true, status: true, modality: true, input: true },
  });
  if (!queueName || queueName.status !== JobStatus.FAILED || !resolveQueueName(queueName.type)) {
    return { ok: false, status: 409 };
  }
  const context = extractRetryContext(queueName);
  if (!context) return { ok: false, status: 409 };

  let created = false;
  let successor: { id: string; datasetId: string; type: JobType; status: JobStatus } | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // A serializable transaction may be retried after having reached the
    // create branch. Its rolled-back local decision must not affect the
    // response for the retry that subsequently observes an existing row.
    created = false;
    try {
      successor = await db.$transaction(async (tx) => {
      const original = await tx.job.findUnique({
        where: { id: jobId },
        select: {
          id: true, datasetId: true, type: true, status: true, modality: true, input: true,
          retrySuccessor: { select: { id: true, datasetId: true, type: true, status: true } },
        },
      });
      if (!original || original.datasetId !== authorized.job.datasetId || original.status !== JobStatus.FAILED) {
        throw new RetryConflict();
      }
      if (original.retrySuccessor) return original.retrySuccessor;
      const retryContext = extractRetryContext(original);
      if (!retryContext || !resolveQueueName(original.type)) throw new RetryConflict();
      created = true;
      return tx.job.create({
        data: {
          datasetId: original.datasetId,
          createdById: actor.id,
          retryOfJobId: original.id,
          type: original.type,
          modality: retryContext.modality,
          status: JobStatus.QUEUED,
          trigger: JobTrigger.RETRY,
          // Only the canonical allowlisted export configuration crosses the
          // retry boundary. Never duplicate the original raw input JSON.
          input: retryContext.input,
        },
        select: { id: true, datasetId: true, type: true, status: true },
      });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      break;
    } catch (error) {
      if (error instanceof RetryConflict) return { ok: false, status: 409 };
      // PostgreSQL can abort one competing serializable transaction before
      // the unique lineage constraint is evaluated. Retrying its small,
      // idempotent transaction lets it observe the committed successor.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && attempt < 2) continue;
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      const existing = await db.job.findUnique({
        where: { retryOfJobId: jobId },
        select: { id: true, datasetId: true, type: true, status: true },
      });
      if (!existing) throw error;
      successor = existing;
      created = false;
      break;
    }
  }

  if (!successor) throw new Error("Retry successor was not resolved.");

  // Enqueue after the durable successor commits. Failure intentionally leaves
  // it QUEUED/un-enqueued for the Phase 007 recovery scanner.
  await enqueueExistingJob(successor.id);
  return { ok: true, status: created ? 201 : 200, job: successor };
}

class RetryConflict extends Error {}
