import "server-only";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";

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
    },
  };
}
