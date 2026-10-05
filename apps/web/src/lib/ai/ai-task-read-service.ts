import "server-only";

import { aiBatchJobInputV1Schema, aiPerAssetOutcomeSchema, isDefinitelyNotSubmitted, reconcileAiOutcomes } from "@annotationplatform/domain/ai-batch";
import { z } from "zod";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import type { AiTaskBatchDto } from "@/types/ai";

/**
 * Safe DTO shape from contracts/ai-api.md's GET /api/ai/tasks/{aiTaskId}.
 * Deliberately excludes externalTaskId, raw provider output, and lock/worker
 * fields — none of those are ever safe to return to a browser client.
 */
export type AiTaskStatusDto = {
  taskId: string;
  jobId: string;
  datasetId: string;
  status: string;
  type: string;
  modality: string | null;
  modelNameSnapshot: string;
  modelVersionSnapshot: string | null;
  pollAttempts: number;
  createdAt: Date;
  updatedAt: Date;
  error: string | null;
  errorCode: string | null;
  batch: AiTaskBatchDto | null;
};

export type ReadAiTaskResult =
  | { ok: true; status: 200; task: AiTaskStatusDto }
  | { ok: false; status: 404 };

/**
 * Loads an AiTask and authorizes the read against its Dataset with
 * `dataset.read` (matching contracts/ai-api.md's Common rules). A task that
 * does not exist, or whose dataset the actor cannot read, is concealed as
 * 404 AI_TASK_NOT_FOUND either way — matching the platform's existing
 * resource-concealment policy for Job routes.
 */
export async function readAuthorizedAiTask(actor: RequestActor, taskId: string): Promise<ReadAiTaskResult> {
  const aiTask = await db.aiTask.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      jobId: true,
      datasetId: true,
      status: true,
      type: true,
      modality: true,
      modelNameSnapshot: true,
      modelVersionSnapshot: true,
      pollAttempts: true,
      createdAt: true,
      updatedAt: true,
      error: true,
      errorCode: true,
      output: true,
      externalTaskId: true,
      summary: true,
      job: { select: { input: true } },
    },
  });
  if (!aiTask) return { ok: false, status: 404 };

  const access = await requireDatasetPermission(actor, aiTask.datasetId, "dataset.read");
  if (!access || access.forbidden) return { ok: false, status: 404 };

  return {
    ok: true,
    status: 200,
    task: {
      taskId: aiTask.id,
      jobId: aiTask.jobId,
      datasetId: aiTask.datasetId,
      status: aiTask.status,
      type: aiTask.type,
      modality: aiTask.modality,
      modelNameSnapshot: aiTask.modelNameSnapshot,
      modelVersionSnapshot: aiTask.modelVersionSnapshot,
      pollAttempts: aiTask.pollAttempts,
      createdAt: aiTask.createdAt,
      updatedAt: aiTask.updatedAt,
      error: aiTask.error,
      errorCode: aiTask.errorCode,
      batch: toBatchDto(aiTask),
    },
  };
}

/**
 * Bounded projection of a versioned operation's accepted target and per-Asset
 * outcomes. Only allowlisted fields cross the boundary (never the manifest,
 * digests, provider output or external ids); a historical task yields `null`.
 */
function toBatchDto(task: { status: string; output: unknown; externalTaskId: string | null; summary: unknown; errorCode: string | null; job: { input: unknown } }): AiTaskBatchDto | null {
  const input = aiBatchJobInputV1Schema.safeParse(task.job.input);
  if (!input.success) return null;
  const perAsset = (task.output as { perAsset?: unknown } | null)?.perAsset;
  const outcomes = z.array(aiPerAssetOutcomeSchema).safeParse(perAsset ?? []);
  const safeOutcomes = outcomes.success ? outcomes.data : [];
  let counts: AiTaskBatchDto["counts"];
  try {
    const summary = reconcileAiOutcomes(input.data.targets, safeOutcomes);
    counts = { total: summary.total, processed: summary.processed, succeeded: summary.succeeded, failed: summary.failed + summary.missing, skipped: summary.skipped, canceled: summary.canceled };
  } catch {
    counts = { total: input.data.targets.length, processed: 0, succeeded: 0, failed: 0, skipped: 0, canceled: 0 };
  }
  return {
    targetMode: input.data.targetMode, count: input.data.targets.length, modality: input.data.modality, counts,
    outcomes: safeOutcomes.map((outcome) => ({ assetId: outcome.assetId, inputIndex: outcome.inputIndex, outcome: outcome.outcome, predictionCount: outcome.predictionCount, ...(outcome.reason ? { reason: outcome.reason } : {}) })),
    retryable: task.status === "FAILED" && isDefinitelyNotSubmitted(task),
  };
}
