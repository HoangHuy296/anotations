import { AiozConfigurationError } from "../config.js";
import { failJob } from "./job-claim-lock.js";
import { resolveAiProviderForTask } from "../providers/ai/ai-provider-registry.js";
import { POLL_BASE_DELAY_MS } from "./ai-poll-constants.js";
import { AiozProviderError } from "../providers/ai/aioz-annotation-services-provider.js";
import type { AiProviderAdapter } from "@annotationplatform/domain/ai-provider";
import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

/**
 * First and only queue delivery for an AI Job. Submits the task to the
 * resolved AiProviderAdapter, then hands off to the scanner-driven poll
 * loop (ai-poll.processor.ts / ai-poll-scanner.ts) for everything after —
 * this processor never polls itself.
 */
export async function processAiSubmit(db: PrismaClient, jobId: string, lockToken: string, registry?: Record<string, AiProviderAdapter>): Promise<void> {
  const aiTask = await db.aiTask.findUnique({
    where: { jobId },
    select: { id: true, modelId: true, modelKeySnapshot: true, input: true, externalTaskId: true, status: true },
  });
  if (!aiTask) {
    await failJob(db, { jobId, lockToken });
    return;
  }

  if (aiTask.status !== "QUEUED" && aiTask.status !== "RUNNING") return;
  const ownedJob = await db.job.findFirst({ where: { id: jobId, lockToken, status: "RUNNING", cancelRequestedAt: null }, select: { id: true } });
  if (!ownedJob) return;

  const assetIds = ((aiTask.input as { assetIds?: unknown } | null)?.assetIds ?? []) as string[];

  try {
    const result = aiTask.externalTaskId ? { externalTaskId: aiTask.externalTaskId } : await (await resolveAiProviderForTask(db, aiTask, registry)).submitTask({ aiTaskId: aiTask.id, assetIds, modelKey: aiTask.modelKeySnapshot });

    await db.aiTask.updateMany({
      where: { id: aiTask.id, status: { in: ["QUEUED", "RUNNING"] } },
      data: { externalTaskId: result.externalTaskId, status: "RUNNING", nextPollAt: new Date(Date.now() + POLL_BASE_DELAY_MS) },
    });
    // Job.status stays RUNNING (set by claimJob before this processor ran);
    // only the observability stage advances here.
    await db.job.updateMany({
      where: { id: jobId, lockToken, status: "RUNNING" },
      data: { stage: "WAITING_AI_RESULT" },
    });
  } catch (error) {
    // Submission failure is terminal for this AiTask/Job — there is nothing
    // to poll without an externalTaskId. Never retried automatically here;
    // an authorized retry (existing Job retry flow) creates a successor.
    const errorCode = error instanceof AiozProviderError ? error.code : error instanceof AiozConfigurationError ? "AIOZ_CONFIG_INVALID" : "AI_SUBMIT_FAILED";
    await db.aiTask.update({ where: { id: aiTask.id }, data: { status: "FAILED", error: "AI provider submission failed.", errorCode } }).catch(() => undefined);
    await db.job.updateMany({ where: { id: jobId, lockToken, status: "RUNNING" }, data: { errorCode } }).catch(() => undefined);
    await failJob(db, { jobId, lockToken });
  }
}
