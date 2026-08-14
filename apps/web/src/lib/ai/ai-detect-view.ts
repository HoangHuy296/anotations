import type { Modality } from "@internal/db";

import type { AiModelDto, AiTaskStatusDto, AiTaskStatusValue } from "@/types/ai";

/**
 * Framework-free view logic for the AI Detect flow -- no React, no engine
 * (IMAGE/VIDEO/AUDIO/TEXT) import, so any `*-engine.tsx` can reuse it once it
 * gains write support, not just the current IMAGE caller. Mirrors the shape
 * of `lib/jobs/job-progress-view.ts` (`shouldPollJob`/`isTerminalJobStatus`)
 * for the existing generic Job progress surface.
 */

export const AI_TASK_TERMINAL_STATUSES = new Set<AiTaskStatusValue>(["SUCCEEDED", "FAILED", "CANCELED"]);

export function isTerminalAiTaskStatus(status: AiTaskStatusValue): boolean {
  return AI_TASK_TERMINAL_STATUSES.has(status);
}

export function shouldPollAiTask(status: AiTaskStatusValue, pageVisible = true): boolean {
  return pageVisible && !isTerminalAiTaskStatus(status);
}

/** Human-readable status line, e.g. for a modal's live status region. */
export function aiTaskStatusMessage(task: Pick<AiTaskStatusDto, "status" | "error" | "errorCode">): string {
  switch (task.status) {
    case "QUEUED": return "Waiting for a worker to pick up this request…";
    case "RUNNING": return "The AI provider is processing this request…";
    case "SUCCEEDED": return "AI detection completed.";
    case "CANCELED": return "This AI detection was canceled.";
    case "FAILED":
      if (task.errorCode === "AI_TASK_TIMEOUT") return "The AI provider did not respond in time. Try again later.";
      return task.error ?? "This AI detection failed.";
    default: return "";
  }
}

/** A model applies to `modality` when it's single-modality-matched, or `null` (supports every modality). */
export function modelSupportsModality(model: Pick<AiModelDto, "modality">, modality: Modality): boolean {
  return model.modality === null || model.modality === modality;
}

export type PropertiesBearing = { properties?: unknown };

/**
 * Predictions land as ordinary `Annotation` rows (`source: AI, status:
 * DRAFT`, `properties: { confidence, aiTaskId, modelKey }` --
 * `ai-prediction-writer.ts`). `SafeAnnotation`/`SafeImageAnnotation` don't
 * surface `source`, so `properties.aiTaskId` is the one signal available to
 * a browser client for "this is an AI suggestion still awaiting review,"
 * without inventing a parallel annotation representation.
 */
export function annotationAiTaskId(annotation: PropertiesBearing): string | null {
  const properties = annotation.properties;
  if (!properties || typeof properties !== "object") return null;
  const aiTaskId = (properties as { aiTaskId?: unknown }).aiTaskId;
  return typeof aiTaskId === "string" && aiTaskId.length > 0 ? aiTaskId : null;
}

export function isAiPredictionAnnotation(annotation: PropertiesBearing): boolean {
  return annotationAiTaskId(annotation) !== null;
}

/**
 * The subset of a freshly-fetched annotation list this specific completed
 * task produced. Filtering by `properties.aiTaskId` (rather than diffing
 * against whatever was on screen before the run) is idempotent -- reopening
 * the dialog or re-running `onCompleted` never double-counts or drops
 * predictions a previous pass already applied.
 */
export function predictionsForTask<T extends PropertiesBearing>(annotations: T[], taskId: string): T[] {
  return annotations.filter((annotation) => annotationAiTaskId(annotation) === taskId);
}
