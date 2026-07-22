import { jobFailureMessage, type JobDisplayStatus } from "@/lib/jobs/job-progress-view";

export function JobErrorPanel({ job }: { job: Pick<JobDisplayStatus, "status" | "summary"> }) {
  const message = jobFailureMessage(job);
  if (!message) return null;
  const timeout = /timed out/i.test(message);
  return <aside className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950" role="status"><p className="font-semibold">This job needs attention</p><p className="mt-1 leading-6 text-amber-900">{message}</p>{timeout ? <p className="mt-2 text-amber-800">Completed files remain available; retry or reconcile only through the authorized import flow.</p> : null}</aside>;
}
