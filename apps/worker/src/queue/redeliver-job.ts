import type { Queue } from "bullmq";

import { getQueueDeliveryId, queueNameForJobType } from "@fieldframe/queue";
import { logRedisEvent } from "@fieldframe/domain";

import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { writeSafeJobEvent } from "../jobs/job-event-writer.js";
import type { ExistingJobRedelivery } from "./recovery-scanner.js";

/**
 * Worker-side implementation of `recovery-scanner.ts`'s `redeliverExistingJob`
 * callback (021-production-hardening-garbage-collection, User Story 2).
 *
 * Mirrors `apps/web/src/lib/queue/enqueue-job.ts#enqueueExistingJob`'s
 * already-correct outage-safety contract (FR-016/FR-017) — that function
 * cannot be imported here (it is `apps/web`-only, wired to Next's route
 * runtime), so the same shape is reproduced against the worker's own BullMQ
 * `Queue` client: never stamp `queueName`/`queueJobId`/`enqueuedAt` unless
 * `queue.add()` actually succeeded; on failure, record a
 * `QUEUE_DELIVERY_PENDING` event with `reason: "QUEUE_UNAVAILABLE"` and
 * report `deliveryPending: true` rather than a false success, so the Job
 * remains `recovery-scanner.ts`'s candidate on the next scheduled pass.
 */
export function createWorkerJobRedeliverer(db: PrismaClient, queue: Queue): ExistingJobRedelivery {
  return async (jobId: string) => {
    const job = await db.job.findUnique({
      where: { id: jobId },
      select: { id: true, type: true, queueName: true, queueJobId: true, enqueuedAt: true, cancelRequestedAt: true },
    });
    if (!job) return { ok: false, status: 404 };
    if (job.cancelRequestedAt) return { ok: false, status: 409 };

    const queueName = queueNameForJobType(job.type);
    if (!queueName) return { ok: false, status: 400 };

    const deliveryId = getQueueDeliveryId(job.id);
    if (job.enqueuedAt) {
      return job.queueName === queueName && job.queueJobId === deliveryId
        ? { ok: true, status: 200, deliveryPending: false }
        : { ok: false, status: 409 };
    }

    try {
      await queue.add("durable-job", { jobId: job.id }, { jobId: deliveryId });
      const stamp = await db.job.updateMany({
        // Another worker (or the original web request, once Redis recovers
        // and a race lands first) may stamp this Job between our add() and
        // this write — the guarded WHERE makes that safe, matching
        // enqueue-job.ts's own comment on the identical race.
        where: { id: job.id, enqueuedAt: null, queueName: null, queueJobId: null },
        data: { queueName, queueJobId: deliveryId, enqueuedAt: new Date() },
      });
      if (!stamp.count) {
        const reconciled = await db.job.findUnique({ where: { id: job.id }, select: { queueName: true, queueJobId: true, enqueuedAt: true } });
        if (reconciled?.queueName === queueName && reconciled.queueJobId === deliveryId && reconciled.enqueuedAt) {
          return { ok: true, status: 200, deliveryPending: false };
        }
        return { ok: false, status: 409 };
      }
      await writeSafeJobEvent(db, { jobId: job.id, kind: "QUEUE_ENQUEUED", queueName, queueJobId: deliveryId });
      return { ok: true, status: 201, deliveryPending: false };
    } catch (error) {
      logRedisEvent("ENQUEUE_FAILED", { detail: error instanceof Error ? error.message : "unknown error" }, "error");
      await writeSafeJobEvent(db, { jobId: job.id, kind: "QUEUE_DELIVERY_PENDING", queueName, reason: "QUEUE_UNAVAILABLE" }).catch(() => undefined);
      return { ok: true, status: 202, deliveryPending: true };
    }
  };
}
