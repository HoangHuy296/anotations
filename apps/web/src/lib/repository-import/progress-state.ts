import type { JobDisplayStatus } from "@/lib/jobs/job-progress-view";

export type RepositoryImportProgressState = {
  kind: "pending" | "active" | "terminal";
  message: string;
};

export function repositoryImportProgressPath(datasetId: string, jobId: string) {
  return `/datasets/${datasetId}/imports/${jobId}`;
}

/**
 * Derived only from the safe PostgreSQL status DTO. It intentionally does not
 * inspect queue metadata, keeping Redis/BullMQ internals out of browser code.
 */
export function repositoryImportProgressState(job: Pick<JobDisplayStatus, "status" | "stage">): RepositoryImportProgressState {
  if (job.status === "QUEUED" && job.stage === null) {
    return {
      kind: "pending",
      message: "This import is queued and waiting for a worker. Delivery will be recovered safely if the queue is temporarily unavailable.",
    };
  }
  if (["COMPLETED", "FAILED", "CANCELED"].includes(job.status)) {
    return { kind: "terminal", message: "This import has reached a terminal state." };
  }
  return { kind: "active", message: "This import is being processed." };
}
