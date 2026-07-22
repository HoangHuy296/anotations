export type JobDisplayStatus = {
  id: string;
  datasetId: string;
  type: string;
  status: string;
  stage: string | null;
  progress: number | null;
  totalItems: number | null;
  processedItems: number | null;
  successCount: number | null;
  failedCount: number | null;
  skippedCount: number | null;
  summary: { message?: string; outcome?: "completed" | "failed" | "canceled"; completedAt?: string; resultCount?: number } | null;
  createdAt: string;
  updatedAt: string;
};

export type JobDisplayEvent = {
  id: string;
  createdAt: string;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  stage: string | null;
  message: string;
  reason: string | null;
};

export const terminalJobStatuses = new Set(["COMPLETED", "FAILED", "CANCELED"]);
export function isTerminalJobStatus(status: string) { return terminalJobStatuses.has(status); }
export function shouldPollJob(status: string, pageVisible = true) { return pageVisible && !isTerminalJobStatus(status); }

export function jobProgressPercent(job: Pick<JobDisplayStatus, "progress" | "totalItems" | "processedItems">) {
  if (job.progress !== null) return Math.max(0, Math.min(100, job.progress));
  if (job.totalItems && job.totalItems > 0 && job.processedItems !== null) return Math.max(0, Math.min(100, Math.round((job.processedItems / job.totalItems) * 100)));
  return null;
}

export function jobFailureMessage(job: Pick<JobDisplayStatus, "status" | "summary">) {
  if (job.status !== "FAILED" && job.status !== "CANCELED") return null;
  if (job.summary?.message) return job.summary.message;
  return job.status === "CANCELED" ? "This job was canceled." : "This job did not complete.";
}
