import { notFound, redirect } from "next/navigation";

import { RepositoryImportProgress } from "@/components/datasets/repository-import-progress";
import { AppShell } from "@/components/layout/app-shell";
import { getRequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { readAuthorizedJob } from "@/lib/jobs/authorization";
import { toSafeJobEvent } from "@/lib/jobs/safe-job-event";
import { toSafeJobStatus } from "@/lib/jobs/safe-job-status";

/** Dataset-scoped, PostgreSQL-backed import progress view. */
export default async function DatasetImportProgressPage({ params }: { params: Promise<{ datasetId: string; jobId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) redirect("/unauthorized");
  const { datasetId, jobId } = await params;
  const datasetAccess = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!datasetAccess || datasetAccess.forbidden) notFound();
  const jobAccess = await readAuthorizedJob(actor, jobId);
  if (!jobAccess.ok || jobAccess.job.datasetId !== datasetId) notFound();
  const [job, events] = await Promise.all([
    db.job.findUnique({ where: { id: jobId }, select: { id: true, datasetId: true, type: true, status: true, stage: true, progress: true, totalItems: true, processedItems: true, successItems: true, failedItems: true, skippedItems: true, summary: true, errorCode: true, createdAt: true, startedAt: true, finishedAt: true, updatedAt: true } }),
    db.jobEvent.findMany({ where: { jobId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50, select: { id: true, createdAt: true, level: true, stage: true, message: true, data: true } }),
  ]);
  if (!job) notFound();
  return <AppShell currentPath={`/datasets/${datasetId}/imports`}><RepositoryImportProgress initialJob={toSafeJobStatus(job)} initialEvents={events.flatMap((event) => { const safe = toSafeJobEvent(event); return safe ? [safe] : []; })} /></AppShell>;
}
