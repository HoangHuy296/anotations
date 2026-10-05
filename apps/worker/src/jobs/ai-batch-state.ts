import {
  aiBatchJobInputV1Schema,
  reconcileAiOutcomes,
  type AiBatchJobInputV1,
  type AiBatchTarget,
  type AiPerAssetOutcome,
} from "@annotationplatform/domain/ai-batch";
import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

/**
 * Worker-side helpers for one AI operation over one or many Assets (feature
 * 026). `Job.input` carries the authoritative accepted target; `AiTask.input`
 * is the provider-facing projection and must agree with it. Historical Jobs
 * (`Job.input = {}`) keep working through an explicit legacy branch and are
 * never reinterpreted as versioned work.
 */
export type AiBatchInputResolution =
  | { kind: "legacy" }
  | { kind: "v1"; input: AiBatchJobInputV1 }
  | { kind: "invalid" };

export function resolveAiBatchInput(jobInput: unknown): AiBatchInputResolution {
  if (jobInput !== null && typeof jobInput === "object" && !Array.isArray(jobInput) && Object.keys(jobInput).length === 0) return { kind: "legacy" };
  const parsed = aiBatchJobInputV1Schema.safeParse(jobInput);
  return parsed.success ? { kind: "v1", input: parsed.data } : { kind: "invalid" };
}

/** True only when the AiTask projection agrees with the authoritative Job input; a mismatch is detected, never resolved by picking one side. */
export function projectionMatchesJobInput(input: AiBatchJobInputV1, task: { modelKeySnapshot: string; input: unknown }): boolean {
  const projection = task.input as { assetIds?: unknown; confidence_threshold?: unknown; iou_threshold?: unknown; classes?: unknown } | null;
  if (!projection || task.modelKeySnapshot !== input.modelKey) return false;
  const ids = input.targets.map((target) => target.assetId);
  return JSON.stringify(projection.assetIds) === JSON.stringify(ids)
    && projection.confidence_threshold === input.confidence_threshold
    && projection.iou_threshold === input.iou_threshold
    && JSON.stringify(projection.classes ?? null) === JSON.stringify(input.classes ?? null);
}

/**
 * Sanitized per-Asset reason for a failed submission. Provider error text is
 * never an input (it can contain signed URLs); only the worker's own error
 * code and whether a submission reservation existed are used.
 *
 * A reservation without a recorded external task id means the outcome of the
 * create call is unknown unless a 4xx response proved the provider refused
 * it: unknown outcomes are `AI_SUBMISSION_AMBIGUOUS` and are never re-sent.
 */
export function submitFailureReason(errorCode: string, submissionReserved: boolean): string {
  switch (errorCode) {
    case "AIOZ_HTTP_4XX": return "AI_PROVIDER_REJECTED";
    case "AIOZ_SOURCE_CHANGED": return "SOURCE_CHANGED";
    case "AIOZ_ASSET_UNAVAILABLE":
    case "AIOZ_ASSET_BINARY_UNAVAILABLE": return "ASSET_UNAVAILABLE";
    case "AI_INPUT_INVALID":
    case "AI_INPUT_MISMATCH":
    case "REQUESTER_ACCESS_LOST": return errorCode;
    default: return submissionReserved ? "AI_SUBMISSION_AMBIGUOUS" : "DISPATCH_FAILED";
  }
}

/**
 * Finalizes every accepted target as FAILED with one sanitized reason and
 * records the aggregate on the Job. Used when nothing can be attributed
 * per Asset (dispatch-time failure, provider whole-batch failure): a terminal
 * operation never keeps unaccounted targets, and a smaller batch is never
 * substituted. The caller still moves Job/AiTask to their terminal status.
 */
export async function finalizeAllTargetsFailed(
  db: PrismaClient,
  context: { jobId: string; aiTaskId: string; lockToken: string; targets: readonly AiBatchTarget[]; reason: string },
): Promise<void> {
  const outcomes: AiPerAssetOutcome[] = context.targets.map((target) => ({
    assetId: target.assetId, inputIndex: target.inputIndex, outcome: "FAILED", predictionCount: 0, reason: context.reason,
  }));
  const summary = reconcileAiOutcomes(context.targets, outcomes);
  await db.aiTask.updateMany({ where: { id: context.aiTaskId }, data: { output: { predictions: [], perAsset: outcomes } } });
  await db.job.updateMany({
    where: { id: context.jobId, lockToken: context.lockToken, status: "RUNNING" },
    data: { totalItems: summary.total, processedItems: summary.processed, successItems: summary.succeeded, failedItems: summary.failed + summary.missing, skippedItems: summary.skipped },
  });
}

/** Sanitized reason for a terminal poll failure; provider text is never an input. */
export function pollFailureReason(errorCode: string): string {
  switch (errorCode) {
    case "AIOZ_EXTERNAL_FAILED": return "AI_PROVIDER_FAILED";
    case "AIOZ_STATUS_UNKNOWN": return "AI_PROVIDER_STATUS_UNKNOWN";
    case "AIOZ_HTTP_4XX": return "AI_PROVIDER_REJECTED";
    case "AIOZ_TIMEOUT":
    case "AIOZ_NETWORK_ERROR":
    case "AIOZ_HTTP_5XX":
    case "AIOZ_INVALID_RESPONSE":
    case "AIOZ_RESPONSE_TOO_LARGE":
    case "AIOZ_INVALID_RESULT_RESPONSE": return "AI_PROVIDER_UNAVAILABLE";
    case "AI_TASK_TIMEOUT": return "AI_TASK_TIMEOUT";
    case "AI_PROVIDER_FAILED_SYSTEM": return "AI_PROVIDER_FAILED_SYSTEM";
    default: return "AI_RESULT_INVALID";
  }
}

/**
 * Cancellation of a versioned operation: every accepted target that has no
 * committed outcome is CANCELED (the prediction writer commits an operation
 * atomically with its completion claim, so cancellation before that claim
 * means nothing was committed). Works inside the cancellation transaction.
 */
export async function finalizeAllTargetsCanceled(
  db: Pick<PrismaClient, "aiTask" | "job">,
  context: { jobId: string; aiTaskId: string; targets: readonly AiBatchTarget[] },
): Promise<void> {
  const outcomes: AiPerAssetOutcome[] = context.targets.map((target) => ({
    assetId: target.assetId, inputIndex: target.inputIndex, outcome: "CANCELED", predictionCount: 0, reason: "OPERATION_CANCELED",
  }));
  const summary = reconcileAiOutcomes(context.targets, outcomes, { operationCanceled: true });
  await db.aiTask.updateMany({ where: { id: context.aiTaskId }, data: { output: { predictions: [], perAsset: outcomes } } });
  await db.job.updateMany({
    where: { id: context.jobId, status: "CANCELING" },
    data: { totalItems: summary.total, processedItems: summary.processed, successItems: 0, failedItems: 0, skippedItems: 0, summary: { canceledItems: summary.canceled } },
  });
}
