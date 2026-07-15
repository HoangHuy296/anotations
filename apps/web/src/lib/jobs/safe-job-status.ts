import "server-only";

import type { JobStage, JobStatus, JobType } from "@internal/db";

import type { JobSafeSummary } from "@/lib/validation/job";

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

/** Phase 007 deliberately does not expose or interpret the raw Prisma summary JSON. */
export function sanitizeJobSummary(raw: unknown): JobSafeSummary | null {
  void raw;
  return null;
}

export function toSafeJobStatus(job: {
  id: string; datasetId: string; type: JobType; status: JobStatus; stage: JobStage | null;
  progress: number | null; totalItems: number | null; processedItems: number | null;
  successItems: number | null; failedItems: number | null; skippedItems: number | null;
  createdAt: Date; updatedAt: Date;
}): SafeJobStatus {
  return {
    id: job.id, datasetId: job.datasetId, type: job.type, status: job.status, stage: job.stage,
    progress: job.progress, totalItems: job.totalItems, processedItems: job.processedItems,
    successCount: job.successItems, failedCount: job.failedItems, skippedCount: job.skippedItems,
    summary: null, createdAt: job.createdAt.toISOString(), updatedAt: job.updatedAt.toISOString(),
  };
}
