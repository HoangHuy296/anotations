"use client";

import { JobDetailClient } from "@/components/jobs/job-detail-client";
import type { JobDisplayEvent, JobDisplayStatus } from "@/lib/jobs/job-progress-view";

/** Reuses the established safe Job polling UI; no queue client enters browser code. */
export function RepositoryImportProgress({ initialJob, initialEvents }: {
  initialJob: JobDisplayStatus;
  initialEvents: JobDisplayEvent[];
}) {
  return <JobDetailClient initialJob={initialJob} initialEvents={initialEvents} variant="repository-import" />;
}
