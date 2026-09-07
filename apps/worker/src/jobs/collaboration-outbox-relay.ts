import { Redis } from "ioredis";
import { z } from "zod";

import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

import { getWorkerConfig } from "../config.js";
import { completeJob, failJob } from "./job-claim-lock.js";

const outboxJobInputSchema = z.object({ outboxEventId: z.string().min(1) }).strict();
const safePayloadSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

/** This stable channel is private transport between the worker and the later
 * delivery-only gateway. Browser clients never publish to or subscribe to it. */
export function collaborationRedisChannel(prefix: string) {
  return `${prefix}:collaboration:events`;
}

/**
 * Resolves durable intent only after the common Job claim succeeds. Publishing
 * may be repeated if the worker crashes between Redis delivery and the final
 * dispatchedAt stamp; the gateway treats every envelope as at-least-once.
 */
export async function processCollaborationOutboxDispatch(db: PrismaClient, jobId: string, lockToken: string) {
  const job = await db.job.findUnique({ where: { id: jobId }, select: { input: true } });
  const parsed = outboxJobInputSchema.safeParse(job?.input);
  if (!parsed.success) {
    await db.job.updateMany({ where: { id: jobId, lockToken }, data: { errorCode: "COLLABORATION_OUTBOX_INPUT_INVALID" } });
    await failJob(db, { jobId, lockToken });
    return;
  }

  const event = await db.collaborationOutboxEvent.findFirst({
    where: { id: parsed.data.outboxEventId, jobId },
    select: { id: true, datasetId: true, assetId: true, recipientUserId: true, type: true, payload: true, dispatchedAt: true },
  });
  if (!event || event.dispatchedAt) {
    await completeJob(db, { jobId, lockToken });
    return;
  }

  const payload = safePayloadSchema.safeParse(event.payload);
  if (!payload.success) {
    await db.job.updateMany({ where: { id: jobId, lockToken }, data: { errorCode: "COLLABORATION_OUTBOX_PAYLOAD_INVALID" } });
    await failJob(db, { jobId, lockToken });
    return;
  }

  const config = getWorkerConfig();
  const publisher = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    db: config.REDIS_DB,
    maxRetriesPerRequest: null,
  });
  try {
    await publisher.publish(collaborationRedisChannel(config.BULLMQ_PREFIX), JSON.stringify({
      id: event.id,
      type: event.type,
      occurredAt: new Date().toISOString(),
      datasetId: event.datasetId,
      ...(event.assetId ? { assetId: event.assetId } : {}),
      ...(event.recipientUserId ? { recipientUserId: event.recipientUserId } : {}),
      payload: payload.data,
    }));
    await db.collaborationOutboxEvent.updateMany({
      where: { id: event.id, jobId, dispatchedAt: null },
      data: { dispatchedAt: new Date() },
    });
    await completeJob(db, { jobId, lockToken });
  } catch (error) {
    await db.job.updateMany({ where: { id: jobId, lockToken }, data: { errorCode: "COLLABORATION_OUTBOX_DELIVERY_FAILED" } });
    // Do not terminally fail a durable delivery because Redis was transiently
    // unavailable. Leaving the claimed Job RUNNING lets the existing lease
    // recovery scanner move it to RETRYING under its normal attempt budget;
    // duplicate later publish is safe by the outbox/event invariants.
    throw error;
  } finally {
    try {
      await publisher.quit();
    } catch {
      publisher.disconnect();
    }
  }
}
