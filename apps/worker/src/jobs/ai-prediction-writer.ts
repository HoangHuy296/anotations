import { z } from "zod";
import { handleVideoAiTaskCompleted } from "./ai-video-prediction-writer.js";
import { canonicalAiLabelKey, resolveAiClassLabels } from "@annotationplatform/domain/ai-label-resolution";

import type { AiProviderPrediction } from "@annotationplatform/domain/ai-provider";

import { aiResultFingerprint } from "./ai-result-fingerprint.js";
import { releaseLock } from "../queue/job-lock.js";
import type { AiTask, PrismaClient } from "../../../../lib/generated/prisma/client.js";

const predictionSchema = z.object({
  assetId: z.string().min(1),
  labelKey: z.string().min(1),
  confidence: z.number().min(0).max(1),
  boundingBoxes: z.unknown(),
});

/**
 * AiModel.taskType -> Annotation.type. Only DETECT_OBJECTS is implemented in
 * this phase (the spec's primary image bounding-box flow); any other
 * AiTaskType is out of scope until a later phase defines its mapping.
 */
const annotationTypeByAiTaskType: Partial<Record<string, "BOUNDING_BOX">> = {
  DETECT_OBJECTS: "BOUNDING_BOX",
  DETECTION: "BOUNDING_BOX",
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
  if (aiTask.modality === "VIDEO" && ["TRACKING", "DETECT_OBJECTS"].includes(aiTask.type)) {
    return handleVideoAiTaskCompleted(db, jobId, aiTask, rawPredictions, lockToken, workerId);
  }
  const submittedAssetIds = new Set(((aiTask.input as { assetIds?: unknown } | null)?.assetIds ?? []) as string[]);
  const parsed = z.array(predictionSchema).safeParse(rawPredictions);
  const candidates: AiProviderPrediction[] = parsed.success ? parsed.data : [];

  const inScope = candidates.filter((prediction) => submittedAssetIds.has(prediction.assetId));
  const annotationType = aiTask.type ? annotationTypeByAiTaskType[aiTask.type] : undefined;

  let labelsCreated = 0;
  let skippedAsDuplicateTotal = 0;
  let labelConflicts: unknown[] = [];
  await db.$transaction(async (tx) => {
    // Claim completion in the same transaction as Annotation writes. A replay
    // or a cancellation that already won cannot append a second result batch.
    // The terminal state is visible only when all writes below commit.
    const completed = await tx.job.updateMany({
      where: { id: jobId, status: "RUNNING", cancelRequestedAt: null, lockToken, lockedBy: workerId },
      data: { status: "COMPLETED", stage: "FINISHED", finishedAt: new Date() },
    });
    if (completed.count !== 1) return;
    if (annotationType) {
      // Shared deterministic class -> Dataset label contract: reuse, create when missing, report (never merge) a conflict. A detection whose class is
      // `unknown` or conflicts keeps its geometry and stays unlabeled instead of being dropped.
      const resolution = await resolveAiClassLabels(tx, aiTask.datasetId, "IMAGE", inScope.map((prediction) => prediction.labelKey));
      labelsCreated = resolution.created.length;
      labelConflicts = [...resolution.conflicts];
      // AI output changes reviewable content too. Claim each parent Asset once, FIRST: the row lock this takes is held to commit, so a concurrent task over
      // the same asset waits here and then sees this task's rows when it reads the fingerprints below (no duplicate under a race). A review-frozen Asset is
      // skipped rather than receiving late predictions, and no queue payload changes.
      const claimedAssets = new Set<string>();
      for (const assetId of new Set(inScope.map((prediction) => prediction.assetId))) {
        const claimed = await tx.asset.updateMany({
          where: { id: assetId, datasetId: aiTask.datasetId, modality: "IMAGE", deletedAt: null, archivedAt: null, status: { notIn: ["NEEDS_REVIEW", "REVIEWED", "REJECTED"] } },
          data: { revision: { increment: 1 } },
        });
        if (claimed.count === 1) claimedAssets.add(assetId);
      }
      // Identical detections already persisted for these assets by an earlier task are skipped, not duplicated (edited/relabeled rows still count).
      const knownByAsset = new Map<string, Set<string>>();
      for (const assetId of claimedAssets) {
        const rows = await tx.annotation.findMany({ where: { assetId, datasetId: aiTask.datasetId, source: "AI", modality: "IMAGE" }, select: { properties: true } });
        knownByAsset.set(assetId, new Set(rows.map((row) => (row.properties as { resultFingerprint?: unknown } | null)?.resultFingerprint).filter((v): v is string => typeof v === "string")));
      }
      for (const [predictionIndex, prediction] of inScope.entries()) {
        if (!claimedAssets.has(prediction.assetId)) continue;
        const canonical = canonicalAiLabelKey(prediction.labelKey);
        const label = { id: canonical ? resolution.labelIds.get(canonical.key) ?? null : null };
        const resultFingerprint = aiResultFingerprint({ modelKey: aiTask.modelKeySnapshot, assetId: prediction.assetId, classKey: canonical ? canonical.key : "unknown", frames: [{ box: prediction.boundingBoxes as never }] });
        const known = knownByAsset.get(prediction.assetId)!;
        if (known.has(resultFingerprint)) { skippedAsDuplicateTotal++; continue; }

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
            // Providers normalize into the existing geometry schema before
            // this writer is called; AIOZ pixel xyxy conversion stays there.
            geometry: (prediction.boundingBoxes ?? {}) as object,
            properties: { confidence: prediction.confidence, aiTaskId: aiTask.id, modelKey: aiTask.modelKeySnapshot, aiPredictionIndex: predictionIndex, predictedClass: prediction.labelKey, resultFingerprint },
            // reviewedById intentionally left unset — only a human review action
            // (existing Phase 017/019 review UI) ever sets it.
          },
        });
        known.add(resultFingerprint);
      }
    }

    await tx.aiTask.update({
      where: { id: aiTask.id },
      data: { status: "SUCCEEDED", output: JSON.parse(JSON.stringify({ predictions: inScope, labelsCreated, labelConflicts, skippedAsDuplicate: skippedAsDuplicateTotal })) },
    });

  });

  await releaseLock(db, jobId, lockToken, workerId);
}
