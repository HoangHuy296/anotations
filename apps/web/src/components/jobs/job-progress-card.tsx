import type { JobDisplayStatus } from "@/lib/jobs/job-progress-view";
import { Clock, Database, ListChecks } from "@phosphor-icons/react/dist/ssr";
import { JobErrorPanel } from "@/components/jobs/job-error-panel";
import { JobProgressBar } from "@/components/jobs/job-progress-bar";
import { JobStageIndicator } from "@/components/jobs/job-stage-indicator";

export function JobProgressCard({ job }: { job: JobDisplayStatus }) {
  return <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_18px_45px_-34px_rgba(24,24,27,0.42)]">
    <div className="border-b border-zinc-100 bg-gradient-to-br from-sky-50 via-white to-white px-5 py-5 sm:px-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start"><div><p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.14em] text-sky-700"><Database size={15} weight="bold" />{job.type.replaceAll("_", " ")}</p><h1 className="mt-2 text-xl font-bold tracking-tight text-zinc-950">Job progress</h1><p className="mt-1 text-sm text-zinc-500">Durable status from PostgreSQL</p></div><JobStageIndicator status={job.status} stage={job.stage} /></div>
      <div className="mt-5"><JobProgressBar job={job} /></div>
    </div>
    <div className="space-y-5 p-5 sm:p-6"><dl className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Metric label="Processed" value={job.processedItems} /><Metric label="Succeeded" value={job.successCount} tone="success" /><Metric label="Failed" value={job.failedCount} tone="danger" /><Metric label="Skipped" value={job.skippedCount} /></dl>
      <div className="flex items-center gap-2 text-xs text-zinc-500"><Clock size={15} /><span>Updated {new Date(job.updatedAt).toLocaleString()}</span><span className="text-zinc-300">•</span><ListChecks size={15} /><span>{job.totalItems ?? "—"} total items</span></div>
      <JobErrorPanel job={job} />
    </div>
  </section>;
}
function Metric({ label, value, tone = "neutral" }: { label: string; value: number | null; tone?: "neutral" | "success" | "danger" }) { const classes = tone === "success" ? "border-emerald-100 bg-emerald-50/60" : tone === "danger" ? "border-rose-100 bg-rose-50/60" : "border-zinc-100 bg-zinc-50"; return <div className={`rounded-xl border px-3 py-2.5 ${classes}`}><dt className="text-xs font-medium text-zinc-500">{label}</dt><dd className="mt-1 text-lg font-bold tabular-nums text-zinc-900">{value ?? 0}</dd></div>; }
