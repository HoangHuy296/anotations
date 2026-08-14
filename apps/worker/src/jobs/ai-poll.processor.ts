import type { AiProviderAdapter } from "@fieldframe/domain/ai-provider";

import { handleAiTaskCompleted } from "./ai-prediction-writer.js";
import {
  LOCK_RENEWAL_BUFFER_MS,
  MAX_POLL_ATTEMPTS,
  MAX_POLL_DURATION_MS,
  POLL_BACKOFF_FACTOR,
  POLL_BASE_DELAY_MS,
  POLL_MAX_DELAY_MS,
} from "./ai-poll-constants.js";
import { releaseLock, renewLock, renewOrReclaimLock } from "../queue/job-lock.js";
import { resolveAiProviderForTask } from "../providers/ai/ai-provider-registry.js";
import type { AiTask, PrismaClient } from "../../../../lib/generated/prisma/client.js";

/**
 * Exponential backoff, capped at POLL_MAX_DELAY_MS: POLL_BASE_DELAY_MS *
 * POLL_BACKOFF_FACTOR^pollAttempts. `pollAttempts` is the count *before* the
 * current step's increment, so the first reschedule (pollAttempts = 0) uses
 * the base delay.
 */
export function computePollDelay(pollAttempts: number): number {
  const delay = POLL_BASE_DELAY_MS * POLL_BACKOFF_FACTOR ** Math.max(0, pollAttempts);
  return Math.min(delay, POLL_MAX_DELAY_MS);
}

/**
 * Trips when either budget is exceeded (FR-010): a poll-count ceiling
 * (MAX_POLL_ATTEMPTS) or a wall-clock ceiling since the AiTask was created
 * (MAX_POLL_DURATION_MS) — whichever comes first.
 */
export function hasExceededPollBudget(aiTask: Pick<AiTask, "pollAttempts" | "createdAt">): boolean {
  if (aiTask.pollAttempts >= MAX_POLL_ATTEMPTS) return true;
  return Date.now() - aiTask.createdAt.getTime() >= MAX_POLL_DURATION_MS;
}

/**
 * One poll step, invoked by the scanner (ai-poll-scanner.ts) for a due
 * AiTask. Follows the required sequence: load Job -> renew-or-reclaim lock
 * -> check cancellation -> poll provider -> update AiTask -> update Job ->
 * (re)schedule next poll. Cancellation is checked strictly after the lock is
 * acquired and before any provider call, to avoid an outbound call for an
 * already-canceled task while the lock prevents a race between reading
 * cancelRequestedAt and mutating state.
 *
 * `providerRegistry`, when supplied, is forwarded to `resolveAiProviderForTask`
 * — used by tests to inject a fake `AiProviderAdapter` in place of the real
 * (currently unregistered — T006 is blocked) AIOZ-company adapter.
 */
export async function processAiPoll(
  db: PrismaClient,
  jobId: string,
  workerId: string,
  providerRegistry?: Record<string, AiProviderAdapter>,
): Promise<void> {
  // 1. Load Job.
  const job = await db.job.findUnique({ where: { id: jobId }, select: { id: true, lockToken: true } });
  if (!job) return;

  // 2. Claim/renew-or-reclaim the lock.
  const lockResult = await renewOrReclaimLock(db, jobId, workerId, job.lockToken);
  if (!lockResult.acquired) return; // Held by another worker's still-valid lease — back off, no error.
  const lockToken = lockResult.lockToken;

  // 3. Check cancellation *after* acquiring the lock, *before* contacting the provider.
  const afterLock = await db.job.findUnique({ where: { id: jobId }, select: { cancelRequestedAt: true } });
  if (afterLock?.cancelRequestedAt) {
    await finalizeCanceledAiTask(db, jobId, lockToken, workerId);
    return;
  }

  const aiTask = await db.aiTask.findUnique({
    where: { jobId },
    select: { id: true, datasetId: true, createdById: true, modality: true, type: true, modelKeySnapshot: true, input: true, modelId: true, externalTaskId: true, pollAttempts: true, createdAt: true },
  });
  if (!aiTask || !aiTask.externalTaskId) {
    await releaseLock(db, jobId, lockToken, workerId);
    return;
  }

  // Poll budget (FR-010) is checked before every provider call, not just on
  // a non-terminal result — a task must never poll forever.
  if (hasExceededPollBudget(aiTask)) {
    await db.aiTask.update({
      where: { id: aiTask.id },
      data: { status: "FAILED", error: "AI task exceeded its poll budget.", errorCode: "AI_TASK_TIMEOUT" },
    });
    await db.job.updateMany({
      where: { id: jobId, lockToken, status: "RUNNING" },
      data: { status: "FAILED", stage: "FINISHED", errorCode: "AI_TASK_TIMEOUT", finishedAt: new Date() },
    });
    await releaseLock(db, jobId, lockToken, workerId);
    return;
  }

  // 4. Poll the provider.
  const adapter = await resolveAiProviderForTask(db, aiTask, providerRegistry);
  const result = await adapter.getTaskStatus(aiTask.externalTaskId);

  // 5-7. Update AiTask -> update Job -> schedule next poll.
  switch (result.status) {
    case "PENDING":
    case "IN_PROGRESS": {
      const delay = computePollDelay(aiTask.pollAttempts);
      await db.aiTask.update({
        where: { id: aiTask.id },
        data: { pollAttempts: { increment: 1 }, nextPollAt: new Date(Date.now() + delay) },
      });
      await renewLock(db, jobId, lockToken, workerId, delay + LOCK_RENEWAL_BUFFER_MS);
      return;
    }
    case "COMPLETED": {
      const predictions = adapter.normalizePredictions(result.rawPredictions);
      await handleAiTaskCompleted(db, jobId, aiTask, predictions, lockToken, workerId);
      return;
    }
    case "FAILED": {
      await db.aiTask.update({
        where: { id: aiTask.id },
        data: { status: "FAILED", error: result.error.message, errorCode: result.error.code },
      });
      await db.job.updateMany({
        where: { id: jobId, lockToken, status: "RUNNING" },
        data: { status: "FAILED", stage: "FINISHED", errorCode: result.error.code, finishedAt: new Date() },
      });
      await releaseLock(db, jobId, lockToken, workerId);
      return;
    }
  }
}

/**
 * Finalizes an AiTask as canceled without ever contacting the provider.
 * Only advances a non-terminal AiTask — a second cancellation on an
 * already-terminal task is a no-op (idempotent), matching the existing
 * Job-cancel route's own terminal-state guard.
 */
export async function finalizeCanceledAiTask(db: PrismaClient, jobId: string, lockToken: string, workerId: string): Promise<void> {
  await db.aiTask.updateMany({
    where: { jobId, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status: "CANCELED" },
  });
  await releaseLock(db, jobId, lockToken, workerId);
}
