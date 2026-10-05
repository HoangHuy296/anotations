import "server-only";

import { JobStatus, JobType, AiTaskStatus, Prisma } from "@internal/db";
import { aiBatchJobInputV1Schema } from "@annotationplatform/domain/ai-batch";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { cancelAuthorizedJob } from "@/lib/jobs/authorization";
import { enqueueExistingJob, type EnqueueOptions } from "@/lib/queue/enqueue-job";
import { resolveQueueName } from "@/lib/queue/queue-names";
import { AiTaskError } from "@/lib/ai/ai-task-errors";
import { isModelInDeployedCatalog, loadModelClasses } from "@/lib/ai/ai-model-service";
import { computeAiPreviewFingerprint, resolveAiTarget, type AiTargetFailureCode, type AiTargetInput } from "@/lib/ai/ai-target-service";
import type { BulkSelectionInput } from "@/lib/assets/asset-bulk-service";
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
  | "AI_MODEL_LABELS_UNAVAILABLE"
  | "INVALID_REQUEST"
  | "FORBIDDEN"
  | "DATASET_NOT_FOUND"
  | "AI_MODEL_NOT_FOUND"
  | "AI_MODEL_INACTIVE"
  | "ASSET_NOT_IN_DATASET"
  | "AI_MODEL_CATALOG_UNAVAILABLE"
  | "TARGET_CHANGED"
  | AiTargetFailureCode
  | "JOB_CONFLICT";

export type CreateAiTaskResult =
  | { ok: true; status: 202; taskId: string; jobId: string; target: { mode: string; count: number; modality: "IMAGE" | "VIDEO"; effectiveLimit: number } }
  | { ok: false; status: 400 | 403 | 404 | 409 | 422 | 502; code: CreateAiTaskFailureCode };

/**
 * Creates exactly one Job + one AiTask (AiTask.jobId @unique enforces the
 * 1:1 invariant at the database level) in a single transaction, then
 * enqueues { jobId } strictly after that transaction commits — never
 * before, per docs/bullmq-postgres-job-flow.md.
 */
export async function createAiTask(actor: RequestActor, input: unknown, enqueueOptions: EnqueueOptions = {}): Promise<CreateAiTaskResult> {
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

  // Every request form (current Asset, Phase 022 selection, legacy assetIds) converges on
  // one server-side resolver; the browser's counts, ids and filters are intent, never authority.
  const targetInput: AiTargetInput = parsed.data.target
    ? parsed.data.target.mode === "CURRENT_ASSET"
      ? { mode: "CURRENT_ASSET", assetId: parsed.data.target.assetId }
      : { mode: "BULK_SELECTION", selection: parsed.data.target.selection as BulkSelectionInput }
    : { mode: "LEGACY_ASSET_IDS", assetIds: parsed.data.assetIds ?? [] };

  // Advisory pass outside the transaction: it needs the resolved modality for the remote catalog
  // and class reads, which must never run inside a database transaction.
  const preview = await resolveAiTarget(parsed.data.datasetId, targetInput);
  if (!preview.ok) return { ok: false, status: preview.status, code: preview.code };

  if (model.provider === "aioz-company") {
    const supported = (model.modality === "IMAGE" && ["DETECTION", "DETECT_OBJECTS"].includes(model.taskType)) || (model.modality === "VIDEO" && ["TRACKING", "DETECT_OBJECTS"].includes(model.taskType));
    if (!supported || model.modality !== preview.modality) return { ok: false, status: 400, code: "INVALID_REQUEST" };
    // A locally registered model the deployed service no longer lists would only fail at the
    // provider (422) after a Job exists; reject it before any Job is created (DI-5).
    try {
      if (!(await isModelInDeployedCatalog(model.key, preview.modality))) return { ok: false, status: 409, code: "AI_MODEL_INACTIVE" };
    } catch { return { ok: false, status: 502, code: "AI_MODEL_CATALOG_UNAVAILABLE" }; }
  }

  if (parsed.data.classes !== undefined) {
    if (model.provider !== "aioz-company") return { ok: false, status: 400, code: "INVALID_REQUEST" };
    let available: string[];
    try { available = await loadModelClasses(model.key); }
    catch { return { ok: false, status: 502, code: "AI_MODEL_LABELS_UNAVAILABLE" }; }
    const allowed = new Set(available);
    if (parsed.data.classes.some((label) => !allowed.has(label))) return { ok: false, status: 400, code: "INVALID_REQUEST" };
  }

  if (parsed.data.previewFingerprint && parsed.data.previewFingerprint !== computeAiPreviewFingerprint({ datasetId: parsed.data.datasetId, actorId: actor.id, modelId: parsed.data.modelId }, preview)) {
    return { ok: false, status: 409, code: "TARGET_CHANGED" };
  }

  const metadata = model.metadata as { version?: unknown } | null;
  const modelVersionSnapshot = typeof metadata?.version === "string" ? metadata.version : null;

  // The authoritative accepted target is decided inside this transaction: resolve again on the
  // transaction's snapshot and refuse (never silently reduce or change) if it differs from the
  // advisory pass. Serialization conflicts are retried a bounded number of times.
  let created: Awaited<ReturnType<typeof acceptAiTask>> | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      created = await acceptAiTask();
      break;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && attempt < 2) continue;
      throw error;
    }
  }
  if (!created) return { ok: false, status: 409, code: "JOB_CONFLICT" };
  if (created.kind === "failure") return { ok: false, status: created.failure.status, code: created.failure.code };
  if (created.kind === "changed") return { ok: false, status: 409, code: "TARGET_CHANGED" };

  function acceptAiTask() {
    return db.$transaction(async (tx) => {
      const resolved = await resolveAiTarget(parsed.data!.datasetId, targetInput, tx);
      if (!resolved.ok) return { kind: "failure", failure: resolved } as const;
      if (JSON.stringify(resolved.targets) !== JSON.stringify(preview.ok ? preview.targets : [])) return { kind: "changed" } as const;

      const jobInput = aiBatchJobInputV1Schema.parse({
        schemaVersion: 1,
        targetMode: resolved.targetMode,
        datasetId: parsed.data!.datasetId,
        modality: resolved.modality,
        modelId: model!.id,
        modelKey: model!.key,
        confidence_threshold: parsed.data!.confidence_threshold,
        iou_threshold: parsed.data!.iou_threshold,
        ...(parsed.data!.classes ? { classes: parsed.data!.classes } : {}),
        effectiveLimit: resolved.effectiveLimit,
        targets: resolved.targets,
      });
      const assetIds = resolved.targets.map((target) => target.assetId);

      const job = await tx.job.create({
        data: {
          datasetId: parsed.data!.datasetId,
          createdById: actor.id,
          type: assetIds.length > 1 ? JobType.AI_PREANNOTATE_DATASET : JobType.AI_PREANNOTATE_ASSET,
          status: JobStatus.QUEUED,
          stage: "CREATING_AI_TASK",
          modality: resolved.modality,
          totalItems: assetIds.length,
          input: jobInput as Prisma.InputJsonValue,
        },
        select: { id: true, datasetId: true, type: true, status: true, queueName: true, queueJobId: true, enqueuedAt: true, cancelRequestedAt: true },
      });

      const aiTask = await tx.aiTask.create({
        data: {
          datasetId: parsed.data!.datasetId,
          jobId: job.id,
          createdById: actor.id,
          modelId: model!.id,
          modelNameSnapshot: model!.displayName,
          modelVersionSnapshot,
          modelKeySnapshot: model!.key,
          type: model!.taskType,
          modality: model!.modality,
          input: { confidence_threshold: parsed.data!.confidence_threshold, iou_threshold: parsed.data!.iou_threshold, assetIds, ...(parsed.data!.classes ? { classes: parsed.data!.classes } : {}) },
          status: AiTaskStatus.QUEUED,
        },
        select: { id: true },
      });

      return { kind: "ok", job, aiTask } as const;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  // $transaction resolves only after commit; enqueue is strictly post-commit.
  const queueName = resolveQueueName(created.job.type);
  if (!queueName) return { ok: false, status: 400, code: "INVALID_REQUEST" };
  const delivery = await enqueueExistingJob(created.job.id, queueName, created.job, enqueueOptions);
  if (!delivery.ok) return { ok: false, status: delivery.status, code: delivery.status === 400 ? "INVALID_REQUEST" : "JOB_CONFLICT" };

  return { ok: true, status: 202, taskId: created.aiTask.id, jobId: created.job.id, target: { mode: preview.targetMode, count: preview.targets.length, modality: preview.modality, effectiveLimit: preview.effectiveLimit } };
}

export type CancelAiTaskFailureCode = "AI_TASK_NOT_FOUND" | "FORBIDDEN" | "JOB_CONFLICT";

export type CancelAiTaskResult =
  | { ok: true; status: 200; taskId: string; jobId: string; jobStatus: "CANCELED" | "CANCELING" }
  | { ok: false; status: 403 | 404 | 409; code: CancelAiTaskFailureCode };

/**
 * Cancels an AiTask by its own id (`POST /api/ai/tasks/{aiTaskId}/cancel`) --
 * the caller only ever needs `taskId`, not `jobId`. Resolves `taskId ->
 * jobId` (concealed as `AI_TASK_NOT_FOUND` the same way `readAuthorizedAiTask`
 * conceals a task whose dataset the actor cannot access) and delegates the
 * actual authorization + cancellation transaction entirely to
 * `cancelAuthorizedJob` — this is still cancelling the underlying `Job`
 * (AGENTS.md: a common `Job` is the source of truth for lifecycle/state),
 * only the entry point changes from `jobId` to `taskId`.
 */
export async function cancelAuthorizedAiTask(actor: RequestActor, taskId: string): Promise<CancelAiTaskResult> {
  const aiTask = await db.aiTask.findUnique({ where: { id: taskId }, select: { id: true, jobId: true } });
  if (!aiTask) return { ok: false, status: 404, code: "AI_TASK_NOT_FOUND" };

  const result = await cancelAuthorizedJob(actor, aiTask.jobId);
  if (!result.ok) {
    // cancelAuthorizedJob conceals a Job the actor cannot access as 404 too
    // (job.cancel permission on the AiTask's own Dataset) -- surfaced here
    // under the AI task's own not-found code rather than a Job-shaped one.
    const code: CancelAiTaskFailureCode = result.status === 404 ? "AI_TASK_NOT_FOUND" : result.status === 403 ? "FORBIDDEN" : "JOB_CONFLICT";
    return { ok: false, status: result.status, code };
  }
  // An immediately-canceled Job (still QUEUED, no worker involved) leaves nothing to finalize it: the
  // AiTask would otherwise stay QUEUED forever. Close it here and account for every accepted target.
  if (result.cancellationStatus === "CANCELED") await finalizeQueuedAiTaskCanceled(aiTask.id, aiTask.jobId);
  return { ok: true, status: 200, taskId: aiTask.id, jobId: aiTask.jobId, jobStatus: result.cancellationStatus };
}

async function finalizeQueuedAiTaskCanceled(aiTaskId: string, jobId: string): Promise<void> {
  const job = await db.job.findUnique({ where: { id: jobId }, select: { input: true } });
  const input = aiBatchJobInputV1Schema.safeParse(job?.input);
  const outcomes = input.success
    ? input.data.targets.map((target) => ({ assetId: target.assetId, inputIndex: target.inputIndex, outcome: "CANCELED" as const, predictionCount: 0, reason: "OPERATION_CANCELED" }))
    : null;
  await db.aiTask.updateMany({
    where: { id: aiTaskId, status: AiTaskStatus.QUEUED },
    data: { status: AiTaskStatus.CANCELED, ...(outcomes ? { output: { predictions: [], perAsset: outcomes } } : {}) },
  });
  if (outcomes) {
    await db.job.updateMany({ where: { id: jobId }, data: { totalItems: outcomes.length, processedItems: outcomes.length, successItems: 0, failedItems: 0, skippedItems: 0, summary: { canceledItems: outcomes.length } } });
  }
}
