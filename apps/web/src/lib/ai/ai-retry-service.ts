import "server-only";

import { AiTaskStatus, JobStatus, JobTrigger, JobType, Prisma } from "@internal/db";
import { aiBatchJobInputV1Schema, isDefinitelyNotSubmitted } from "@annotationplatform/domain/ai-batch";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { isModelInDeployedCatalog } from "@/lib/ai/ai-model-service";
import { resolveAiTarget } from "@/lib/ai/ai-target-service";
import { enqueueExistingJob, type EnqueueOptions } from "@/lib/queue/enqueue-job";

export const isAiJobType = (type: JobType) => type === JobType.AI_PREANNOTATE_ASSET || type === JobType.AI_PREANNOTATE_DATASET;

type Successor = { id: string; datasetId: string; type: JobType; status: JobStatus };
export type AiRetryResult = { ok: false; status: 403 | 404 | 409 } | { ok: true; status: 200 | 201; job: Successor };

class AiRetryConflict extends Error {}

/**
 * Authorized retry of a failed AI operation (feature 026, decision D-NI). The
 * provider is non-idempotent and has no lookup, so only a *definitely
 * unsubmitted* failure is retryable; an ambiguous or externally-recorded one
 * is refused (409) and only a new deliberate operation may follow. The
 * successor is one Job + one new AiTask linked through the unique
 * `retryOfJobId`; the accepted membership is re-validated strictly (a
 * removed, archived or foreign member rejects the retry, never shrinks it),
 * and only allowlisted, re-validated configuration crosses the boundary --
 * the predecessor's history stays untouched.
 */
export async function retryAiJob(actor: RequestActor, jobId: string, enqueueOptions: EnqueueOptions = {}): Promise<AiRetryResult> {
  const original = await db.job.findUnique({
    where: { id: jobId },
    select: {
      id: true, datasetId: true, type: true, status: true, input: true,
      aiTasks: { select: { modelId: true, externalTaskId: true, summary: true, errorCode: true, modelKeySnapshot: true, modelNameSnapshot: true, modelVersionSnapshot: true, type: true, modality: true } },
      retrySuccessor: { select: { id: true, datasetId: true, type: true, status: true } },
    },
  });
  if (!original || !isAiJobType(original.type) || original.status !== JobStatus.FAILED) return { ok: false, status: 409 };
  if (original.retrySuccessor) return { ok: true, status: 200, job: original.retrySuccessor };

  const access = await requireDatasetPermission(actor, original.datasetId, "annotation.create");
  if (!access) return { ok: false, status: 404 };
  if (access.forbidden) return { ok: false, status: 403 };

  const task = original.aiTasks;
  const input = aiBatchJobInputV1Schema.safeParse(original.input);
  // Historical/unsupported records and ambiguous submissions have no safe recovery evidence.
  if (!task || !input.success || !isDefinitelyNotSubmitted(task)) return { ok: false, status: 409 };

  const model = await db.aiModel.findUnique({ where: { id: task.modelId }, select: { id: true, key: true, provider: true, isActive: true, modality: true } });
  if (!model || !model.isActive || model.key !== input.data.modelKey) return { ok: false, status: 409 };
  if (model.provider === "aioz-company") {
    try { if (!(await isModelInDeployedCatalog(model.key, input.data.modality))) return { ok: false, status: 409 }; }
    catch { return { ok: false, status: 409 }; }
  }

  const assetIds = input.data.targets.map((target) => target.assetId);
  let created = false;
  let successor: Successor | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    created = false;
    try {
      successor = await db.$transaction(async (tx) => {
        const current = await tx.job.findUnique({ where: { id: jobId }, select: { status: true, retrySuccessor: { select: { id: true, datasetId: true, type: true, status: true } } } });
        if (!current || current.status !== JobStatus.FAILED) throw new AiRetryConflict();
        if (current.retrySuccessor) return current.retrySuccessor;

        const resolved = await resolveAiTarget(original.datasetId, { mode: "BULK_SELECTION", selection: { mode: "EXPLICIT", assetIds } }, tx);
        if (!resolved.ok) throw new AiRetryConflict();
        const successorInput = aiBatchJobInputV1Schema.parse({
          schemaVersion: 1, targetMode: input.data.targetMode, datasetId: original.datasetId, modality: resolved.modality,
          modelId: model.id, modelKey: model.key, confidence_threshold: input.data.confidence_threshold, iou_threshold: input.data.iou_threshold,
          ...(input.data.classes ? { classes: input.data.classes } : {}), effectiveLimit: resolved.effectiveLimit, targets: resolved.targets,
        });
        const resolvedIds = resolved.targets.map((target) => target.assetId);
        created = true;
        const job = await tx.job.create({
          data: {
            datasetId: original.datasetId, createdById: actor.id, retryOfJobId: original.id,
            type: resolvedIds.length > 1 ? JobType.AI_PREANNOTATE_DATASET : JobType.AI_PREANNOTATE_ASSET,
            status: JobStatus.QUEUED, trigger: JobTrigger.RETRY, stage: "CREATING_AI_TASK",
            modality: resolved.modality, totalItems: resolvedIds.length, input: successorInput as Prisma.InputJsonValue,
          },
          select: { id: true, datasetId: true, type: true, status: true },
        });
        await tx.aiTask.create({
          data: {
            datasetId: original.datasetId, jobId: job.id, createdById: actor.id, modelId: model.id,
            modelNameSnapshot: task.modelNameSnapshot, modelVersionSnapshot: task.modelVersionSnapshot, modelKeySnapshot: task.modelKeySnapshot,
            type: task.type, modality: task.modality,
            input: { confidence_threshold: input.data.confidence_threshold, iou_threshold: input.data.iou_threshold, assetIds: resolvedIds, ...(input.data.classes ? { classes: input.data.classes } : {}) },
            status: AiTaskStatus.QUEUED,
          },
          select: { id: true },
        });
        return job;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      break;
    } catch (error) {
      if (error instanceof AiRetryConflict) return { ok: false, status: 409 };
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && attempt < 2) continue;
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      // A competing retry won the unique lineage constraint: converge on its successor.
      const existing = await db.job.findUnique({ where: { retryOfJobId: jobId }, select: { id: true, datasetId: true, type: true, status: true } });
      if (!existing) throw error;
      successor = existing; created = false;
      break;
    }
  }
  if (!successor) throw new Error("Retry successor was not resolved.");

  // Enqueue strictly after the durable successor commits; a failure leaves it QUEUED for the recovery scanner.
  await enqueueExistingJob(successor.id, undefined, undefined, enqueueOptions);
  return { ok: true, status: created ? 201 : 200, job: successor };
}
