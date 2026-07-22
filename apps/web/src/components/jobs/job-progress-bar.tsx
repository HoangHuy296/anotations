import { jobProgressPercent, type JobDisplayStatus } from "@/lib/jobs/job-progress-view";

export function JobProgressBar({ job }: { job: Pick<JobDisplayStatus, "progress" | "totalItems" | "processedItems"> }) {
  const percent = jobProgressPercent(job);
  return <div className="space-y-2.5">
    <div className="h-2.5 overflow-hidden rounded-full bg-zinc-200/80" aria-label={percent === null ? "Job progress is pending" : `${percent}% complete`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}><div className={percent === null ? "h-full w-1/3 animate-pulse rounded-full bg-sky-300" : "h-full rounded-full bg-gradient-to-r from-sky-600 to-cyan-500 transition-[width] duration-500"} style={percent === null ? undefined : { width: `${percent}%` }} /></div>
    <p className="text-xs font-medium text-zinc-500">{percent === null ? "Waiting for worker progress" : `${percent}% complete`} {job.processedItems !== null && job.totalItems !== null ? <span className="text-zinc-400">({job.processedItems} of {job.totalItems})</span> : null}</p>
  </div>;
}
