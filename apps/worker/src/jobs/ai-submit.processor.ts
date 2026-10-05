import { AiozConfigurationError } from "../config.js";
import { failJob } from "./job-claim-lock.js";
import { resolveAiProviderForTask } from "../providers/ai/ai-provider-registry.js";
import { POLL_BASE_DELAY_MS } from "./ai-poll-constants.js";
import { AiozProviderError } from "../providers/ai/aioz-annotation-services-provider.js";
import type { AiProviderAdapter } from "@annotationplatform/domain/ai-provider";
import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { finalizeAllTargetsFailed, projectionMatchesJobInput, resolveAiBatchInput, submitFailureReason } from "./ai-batch-state.js";
import type { AiBatchTarget } from "@annotationplatform/domain/ai-batch";

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
  const ownedJob = await db.job.findFirst({ where: { id: jobId, lockToken, status: "RUNNING", cancelRequestedAt: null }, select: { id: true, input: true, createdById: true, datasetId: true } });
  if (!ownedJob) return;

  // Versioned Jobs (feature 026) carry the authoritative accepted target in Job.input;
  // historical Jobs (`{}`) keep the AiTask projection through an explicit legacy branch.
  const resolution = resolveAiBatchInput(ownedJob.input);
  let targets: AiBatchTarget[] | null = null;

  async function failSubmission(errorCode: string, reason: string) {
    // Terminal for this AiTask/Job -- there is nothing to poll without an externalTaskId.
    // Never retried automatically; a create call is never repeated after an unknown outcome.
    await db.aiTask.update({ where: { id: aiTask!.id }, data: { status: "FAILED", error: "AI provider submission failed.", errorCode } }).catch(() => undefined);
    await db.job.updateMany({ where: { id: jobId, lockToken, status: "RUNNING" }, data: { errorCode } }).catch(() => undefined);
    if (targets) await finalizeAllTargetsFailed(db, { jobId, aiTaskId: aiTask!.id, lockToken, targets, reason }).catch(() => undefined);
    await failJob(db, { jobId, lockToken });
  }

  if (resolution.kind === "invalid") { await failSubmission("AI_INPUT_INVALID", "AI_INPUT_INVALID"); return; }
  if (resolution.kind === "v1") {
    targets = resolution.input.targets;
    if (!projectionMatchesJobInput(resolution.input, aiTask)) { await failSubmission("AI_INPUT_MISMATCH", "AI_INPUT_MISMATCH"); return; }
    // Revalidate the requester at dispatch: a later access change must not let queued work run.
    const requester = await db.user.findUnique({ where: { id: ownedJob.createdById }, select: { role: true } });
    const dataset = await db.dataset.findFirst({
      where: { id: ownedJob.datasetId, deletedAt: null, archivedAt: null, ...(requester?.role === "ADMIN" ? {} : { OR: [{ ownerId: ownedJob.createdById }, { members: { some: { userId: ownedJob.createdById } } }] }) },
      select: { id: true },
    });
    if (!requester || !dataset) { await failSubmission("REQUESTER_ACCESS_LOST", "REQUESTER_ACCESS_LOST"); return; }
  }

  const assetIds = targets ? targets.map((target) => target.assetId) : ((aiTask.input as { assetIds?: unknown } | null)?.assetIds ?? []) as string[];

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
    const errorCode = error instanceof AiozProviderError ? error.code : error instanceof AiozConfigurationError ? "AIOZ_CONFIG_INVALID" : "AI_SUBMIT_FAILED";
    const latest = await db.aiTask.findUnique({ where: { id: aiTask.id }, select: { summary: true } }).catch(() => null);
    const reserved = Boolean((latest?.summary as { aiozSubmission?: unknown } | null)?.aiozSubmission);
    await failSubmission(errorCode, submitFailureReason(errorCode, reserved));
  }
}
