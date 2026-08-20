import { z } from "zod";

import type { AiProviderPrediction } from "@annotationplatform/domain/ai-provider";

import { releaseLock } from "../queue/job-lock.js";
import type { AiTask, PrismaClient } from "../../../../lib/generated/prisma/client.js";

const predictionSchema = z.object({
  assetId: z.string().min(1),
  labelKey: z.string().min(1),
  confidence: z.number().min(0).max(1),
  boundingBoxes: z.unknown(),
});

/** Mirrors apps/web/src/lib/validation/label.ts#normalizeLabelName — apps/worker cannot import apps/web/src/lib. */
function normalizeLabelName(name: string) {
  return name.trim().toLocaleLowerCase("en-US");
}

/**
 * AiModel.taskType -> Annotation.type. Only DETECT_OBJECTS is implemented in
 * this phase (the spec's primary image bounding-box flow); any other
 * AiTaskType is out of scope until a later phase defines its mapping.
 */
const annotationTypeByAiTaskType: Partial<Record<string, "BOUNDING_BOX">> = {
  DETECT_OBJECTS: "BOUNDING_BOX",
};

/**
 * Validates the worker's normalized AiProviderPrediction[] (already produced
 * by the adapter's normalizePredictions() — never the provider's raw
 * response shape), discards out-of-scope assetIds (FR-015), resolves each
 * labelKey against the dataset's Label set (skipping an unresolvable one
 * rather than failing the whole task), then in one transaction creates one
 * new Annotation per valid prediction and finalizes the AiTask/Job. This is
 * the *only* place `tx.annotation.create()` is called anywhere in this
 * feature — it never updates or deletes an existing Annotation, which is
 * what guarantees `source = MANUAL` rows are never touched (FR-016).
 */
export async function handleAiTaskCompleted(
  db: PrismaClient,
  jobId: string,
  aiTask: Pick<AiTask, "id" | "datasetId" | "createdById" | "modality" | "type" | "modelKeySnapshot" | "input">,
  rawPredictions: unknown,
  lockToken: string,
  workerId: string,
): Promise<void> {
  const submittedAssetIds = new Set(((aiTask.input as { assetIds?: unknown } | null)?.assetIds ?? []) as string[]);
  const parsed = z.array(predictionSchema).safeParse(rawPredictions);
  const candidates: AiProviderPrediction[] = parsed.success ? parsed.data : [];

  const inScope = candidates.filter((prediction) => submittedAssetIds.has(prediction.assetId));
  const annotationType = aiTask.type ? annotationTypeByAiTaskType[aiTask.type] : undefined;

  await db.$transaction(async (tx) => {
    if (annotationType) {
      for (const prediction of inScope) {
        const label = await tx.label.findFirst({
          where: { datasetId: aiTask.datasetId, normalizedName: normalizeLabelName(prediction.labelKey) },
          select: { id: true },
        });
        if (!label) continue; // Unresolvable label: skip this prediction, do not fail the task.

        await tx.annotation.create({
          data: {
            datasetId: aiTask.datasetId,
            assetId: prediction.assetId,
            labelId: label.id,
            createdById: aiTask.createdById,
            modality: aiTask.modality!,
            type: annotationType,
            source: "AI",
            status: "DRAFT",
            // TODO: once the real AIOZ-company contract (T006) defines its
            // bounding-box coordinate format, normalize prediction.boundingBoxes
            // into the platform's canonical geometry shape here.
            geometry: (prediction.boundingBoxes ?? {}) as object,
            properties: { confidence: prediction.confidence, aiTaskId: aiTask.id, modelKey: aiTask.modelKeySnapshot },
            // reviewedById intentionally left unset — only a human review action
            // (existing Phase 017/019 review UI) ever sets it.
          },
        });
      }
    }

    await tx.aiTask.update({
      where: { id: aiTask.id },
      data: { status: "SUCCEEDED", output: JSON.parse(JSON.stringify({ predictions: inScope })) },
    });

    await tx.job.update({
      where: { id: jobId },
      data: { status: "COMPLETED", stage: "FINISHED", finishedAt: new Date() },
    });
  });

  await releaseLock(db, jobId, lockToken, workerId);
}
