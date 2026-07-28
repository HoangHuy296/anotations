import { notFound, redirect } from "next/navigation";

import { JobDetailClient } from "@/components/jobs/job-detail-client";
import { AppShell } from "@/components/layout/app-shell";
import { getRequestActor } from "@/lib/auth";
import { db } from "@/lib/db";
import { readAuthorizedJob } from "@/lib/jobs/authorization";
import { toSafeJobEvent } from "@/lib/jobs/safe-job-event";
import { toSafeJobStatus } from "@/lib/jobs/safe-job-status";

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) redirect("/unauthorized");
  const { jobId } = await params;
  const access = await readAuthorizedJob(actor, jobId);
  if (!access.ok) notFound();
  const [job, eventRows] = await Promise.all([
    db.job.findUnique({ where: { id: access.job.id }, select: { id: true, datasetId: true, type: true, status: true, stage: true, progress: true, totalItems: true, processedItems: true, successItems: true, failedItems: true, skippedItems: true, summary: true, errorCode: true, createdAt: true, startedAt: true, finishedAt: true, updatedAt: true } }),
    db.jobEvent.findMany({ where: { jobId: access.job.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50, select: { id: true, createdAt: true, level: true, stage: true, message: true, data: true } }),
  ]);
  if (!job) notFound();
  return <AppShell currentPath="/jobs"><JobDetailClient initialJob={toSafeJobStatus(job)} initialEvents={eventRows.flatMap((event) => { const safe = toSafeJobEvent(event); return safe ? [safe] : []; })} /></AppShell>;
}
