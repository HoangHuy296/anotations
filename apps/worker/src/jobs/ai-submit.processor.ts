import { failJob } from "./job-claim-lock.js";
import { resolveAiProviderForTask } from "../providers/ai/ai-provider-registry.js";
import { POLL_BASE_DELAY_MS } from "./ai-poll-constants.js";
import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

/**
 * First and only queue delivery for an AI Job. Submits the task to the
 * resolved AiProviderAdapter, then hands off to the scanner-driven poll
 * loop (ai-poll.processor.ts / ai-poll-scanner.ts) for everything after —
 * this processor never polls itself.
 */
export async function processAiSubmit(db: PrismaClient, jobId: string, lockToken: string): Promise<void> {
  const aiTask = await db.aiTask.findUnique({
    where: { jobId },
    select: { id: true, modelId: true, modelKeySnapshot: true, input: true },
  });
  if (!aiTask) {
    await failJob(db, { jobId, lockToken });
    return;
  }

  const assetIds = ((aiTask.input as { assetIds?: unknown } | null)?.assetIds ?? []) as string[];

  try {
    const adapter = await resolveAiProviderForTask(db, aiTask);
    const result = await adapter.submitTask({ aiTaskId: aiTask.id, assetIds, modelKey: aiTask.modelKeySnapshot });

    await db.aiTask.update({
      where: { id: aiTask.id },
      data: { externalTaskId: result.externalTaskId, status: "RUNNING", nextPollAt: new Date(Date.now() + POLL_BASE_DELAY_MS) },
    });
    // Job.status stays RUNNING (set by claimJob before this processor ran);
    // only the observability stage advances here.
    await db.job.updateMany({
      where: { id: jobId, lockToken, status: "RUNNING" },
      data: { stage: "WAITING_AI_RESULT" },
    });
  } catch {
    // Submission failure is terminal for this AiTask/Job — there is nothing
    // to poll without an externalTaskId. Never retried automatically here;
    // an authorized retry (existing Job retry flow) creates a successor.
    await db.aiTask.update({ where: { id: aiTask.id }, data: { status: "FAILED", error: "AI provider submission failed.", errorCode: "AI_SUBMIT_FAILED" } }).catch(() => undefined);
    await db.job.updateMany({ where: { id: jobId, lockToken, status: "RUNNING" }, data: { errorCode: "AI_SUBMIT_FAILED" } }).catch(() => undefined);
    await failJob(db, { jobId, lockToken });
  }
}
