import "server-only";

import { JobStatus, JobType, AiTaskStatus } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { enqueueExistingJob } from "@/lib/queue/enqueue-job";
import { resolveQueueName } from "@/lib/queue/queue-names";
import { AiTaskError } from "@/lib/ai/ai-task-errors";
import { createAiTaskSchema } from "@/lib/validation/ai-task";

/**
 * Rejects before any transaction opens (FR-002) — an actor certain to be
 * refused must never cause a Job/AiTask row to be created.
 */
export async function assertAssetsBelongToDataset(assetIds: string[], datasetId: string): Promise<void> {
  const count = await db.asset.count({
    where: { id: { in: assetIds }, datasetId, deletedAt: null, archivedAt: null },
  });
  if (count !== assetIds.length) throw new AiTaskError("ASSET_NOT_IN_DATASET");
}

export type CreateAiTaskFailureCode =
  | "INVALID_REQUEST"
  | "FORBIDDEN"
  | "DATASET_NOT_FOUND"
  | "AI_MODEL_NOT_FOUND"
  | "AI_MODEL_INACTIVE"
  | "ASSET_NOT_IN_DATASET"
  | "JOB_CONFLICT";

export type CreateAiTaskResult =
  | { ok: true; status: 202; taskId: string; jobId: string }
  | { ok: false; status: 400 | 403 | 404 | 409; code: CreateAiTaskFailureCode };

/**
 * Creates exactly one Job + one AiTask (AiTask.jobId @unique enforces the
 * 1:1 invariant at the database level) in a single transaction, then
 * enqueues { jobId } strictly after that transaction commits — never
 * before, per docs/bullmq-postgres-job-flow.md.
 */
export async function createAiTask(actor: RequestActor, input: unknown): Promise<CreateAiTaskResult> {
  const parsed = createAiTaskSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, code: "INVALID_REQUEST" };

  const access = await requireDatasetPermission(actor, parsed.data.datasetId, "annotation.create");
  if (!access) return { ok: false, status: 404, code: "DATASET_NOT_FOUND" };
  if (access.forbidden) return { ok: false, status: 403, code: "FORBIDDEN" };

  const model = await db.aiModel.findUnique({
    where: { id: parsed.data.modelId },
    select: { id: true, displayName: true, key: true, provider: true, modality: true, taskType: true, isActive: true, metadata: true },
  });
  if (!model) return { ok: false, status: 404, code: "AI_MODEL_NOT_FOUND" };
  if (!model.isActive) return { ok: false, status: 409, code: "AI_MODEL_INACTIVE" };

  try {
    await assertAssetsBelongToDataset(parsed.data.assetIds, parsed.data.datasetId);
  } catch (error) {
    if (error instanceof AiTaskError) return { ok: false, status: 409, code: "ASSET_NOT_IN_DATASET" };
    throw error;
  }

  const metadata = model.metadata as { version?: unknown } | null;
  const modelVersionSnapshot = typeof metadata?.version === "string" ? metadata.version : null;

  const created = await db.$transaction(async (tx) => {
    const job = await tx.job.create({
      data: {
        datasetId: parsed.data.datasetId,
        createdById: actor.id,
        type: parsed.data.assetIds.length > 1 ? JobType.AI_PREANNOTATE_DATASET : JobType.AI_PREANNOTATE_ASSET,
        status: JobStatus.QUEUED,
        stage: "CREATING_AI_TASK",
      },
      select: { id: true, datasetId: true, type: true, status: true, queueName: true, queueJobId: true, enqueuedAt: true, cancelRequestedAt: true },
    });

    const aiTask = await tx.aiTask.create({
      data: {
        datasetId: parsed.data.datasetId,
        jobId: job.id,
        createdById: actor.id,
        modelId: model.id,
        modelNameSnapshot: model.displayName,
        modelVersionSnapshot,
        modelKeySnapshot: model.key,
        type: model.taskType,
        modality: model.modality,
        input: { assetIds: parsed.data.assetIds },
        status: AiTaskStatus.QUEUED,
      },
      select: { id: true },
    });

    return { job, aiTask };
  });

  // $transaction resolves only after commit; enqueue is strictly post-commit.
  const queueName = resolveQueueName(created.job.type);
  if (!queueName) return { ok: false, status: 400, code: "INVALID_REQUEST" };
  const delivery = await enqueueExistingJob(created.job.id, queueName, created.job);
  if (!delivery.ok) return { ok: false, status: delivery.status, code: delivery.status === 400 ? "INVALID_REQUEST" : "JOB_CONFLICT" };

  return { ok: true, status: 202, taskId: created.aiTask.id, jobId: created.job.id };
}
