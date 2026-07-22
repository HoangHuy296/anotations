import "server-only";

import type { JobStage, JobStatus, JobType } from "@internal/db";

import type { JobSafeSummary } from "@/lib/validation/job";
import { safeJobSummarySchema } from "@/lib/validation/job";

export type SafeJobStatus = {
  id: string;
  datasetId: string;
  type: JobType;
  status: JobStatus;
  stage: JobStage | null;
  progress: number | null;
  totalItems: number | null;
  processedItems: number | null;
  successCount: number | null;
  failedCount: number | null;
  skippedCount: number | null;
  summary: JobSafeSummary | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * The raw Prisma JSON is never returned. Only this small, strict schema may
 * become a browser DTO; unknown keys, invalid timestamps, and nested values
 * are discarded as `null` rather than being partially copied.
 */
export function sanitizeJobSummary(raw: unknown): JobSafeSummary | null {
  const parsed = safeJobSummarySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function toSafeJobStatus(job: {
  id: string; datasetId: string; type: JobType; status: JobStatus; stage: JobStage | null;
  progress: number | null; totalItems: number | null; processedItems: number | null;
  successItems: number | null; failedItems: number | null; skippedItems: number | null;
  summary: unknown; createdAt: Date; updatedAt: Date;
}): SafeJobStatus {
  return {
    id: job.id, datasetId: job.datasetId, type: job.type, status: job.status, stage: job.stage,
    progress: job.progress, totalItems: job.totalItems, processedItems: job.processedItems,
    successCount: job.successItems, failedCount: job.failedItems, skippedCount: job.skippedItems,
    summary: sanitizeJobSummary(job.summary), createdAt: job.createdAt.toISOString(), updatedAt: job.updatedAt.toISOString(),
  };
}
