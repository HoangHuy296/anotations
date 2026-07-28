import "server-only";

import type { JobStage, JobStatus, JobType } from "@internal/db";

import type { JobSafeSummary } from "@/lib/validation/job";
import { safeJobSummarySchema } from "@/lib/validation/job";
import { toSafeJobStage, type SafeJobStage } from "@/lib/jobs/safe-job-stage";

export type SafeJobStatus = {
  id: string;
  jobId: string;
  datasetId: string;
  type: JobType;
  status: JobStatus;
  stage: SafeJobStage | null;
  progress: number | null;
  totalItems: number | null;
  processedItems: number | null;
  successCount: number | null;
  failedCount: number | null;
  skippedCount: number | null;
  summary: JobSafeSummary | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

const safeErrorCodes = new Set([
  "SOURCE_TOKEN_EXPIRED", "SOURCE_TOKEN_INVALID", "SOURCE_CONNECTION_NOT_FOUND", "SOURCE_URL_UNSAFE",
  "SOURCE_ROOT_PATH_UNSAFE", "SOURCE_IMPORT_LIMIT_EXCEEDED", "SOURCE_PROVIDER_UNAVAILABLE",
  "SOURCE_DOWNLOAD_FAILED", "SOURCE_RECONCILIATION_CONFLICT", "MINIO_UPLOAD_FAILED", "MINIO_OBJECT_VERIFICATION_FAILED",
  "LOCK_LOST", "REPOSITORY_IMPORT_FAILED", "REPOSITORY_IMPORT_TEST_INJECTED_FAILURE",
]);

function safeError(code: string | null) {
  if (!code || !safeErrorCodes.has(code)) return { errorCode: null, errorMessage: null };
  const message = code === "SOURCE_TOKEN_EXPIRED" || code === "SOURCE_TOKEN_INVALID"
    ? "The source connection is no longer usable."
    : code === "LOCK_LOST" ? "This job is being handled by another worker."
      : "This job could not complete safely.";
  return { errorCode: code, errorMessage: message };
}

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
  summary: unknown; errorCode: string | null; createdAt: Date; startedAt: Date | null; finishedAt: Date | null; updatedAt: Date;
}): SafeJobStatus {
  const error = safeError(job.errorCode);
  return {
    id: job.id, jobId: job.id, datasetId: job.datasetId, type: job.type, status: job.status, stage: toSafeJobStage(job.stage),
    progress: job.progress, totalItems: job.totalItems, processedItems: job.processedItems,
    successCount: job.successItems, failedCount: job.failedItems, skippedCount: job.skippedItems,
    summary: sanitizeJobSummary(job.summary), ...error, createdAt: job.createdAt.toISOString(), startedAt: job.startedAt?.toISOString() ?? null, finishedAt: job.finishedAt?.toISOString() ?? null, updatedAt: job.updatedAt.toISOString(),
  };
}
