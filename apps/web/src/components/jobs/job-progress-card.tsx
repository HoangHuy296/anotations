import type { JobDisplayStatus } from "@/lib/jobs/job-progress-view";
import { Database } from "@phosphor-icons/react/dist/ssr";
import { JobErrorPanel } from "@/components/jobs/job-error-panel";
import { JobProgressBar } from "@/components/jobs/job-progress-bar";
import { JobStageIndicator } from "@/components/jobs/job-stage-indicator";

/**
 * Streamlined per user feedback: the percentage/progress bar is the one
 * piece everyone actually watches (it's what tells a local-folder import it
 * finished without a manual "Commit import" click), so it stays. The
 * surrounding chrome that only restated the same numbers in prose — a
 * "Durable status from PostgreSQL" subtitle, an "Updated {time} · {total}
 * total items" line, and a duplicate "N imported, N skipped, N failed"
 * sentence — is gone. Success/failed/skipped stay as a compact row since
 * that's real signal (not repeated elsewhere) for job types that can
 * partially fail, e.g. repository import.
 */
export function JobProgressCard({ job }: { job: JobDisplayStatus }) {
  return <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_18px_45px_-34px_rgba(24,24,27,0.42)]">
    <div className="border-b border-zinc-100 bg-gradient-to-br from-sky-50 via-white to-white px-5 py-5 sm:px-6">
      <div className="flex items-center justify-between gap-3"><p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.14em] text-sky-700"><Database size={15} weight="bold" />{job.type.replaceAll("_", " ")}</p><JobStageIndicator status={job.status} stage={job.stage} /></div>
      <div className="mt-4"><JobProgressBar job={job} /></div>
    </div>
    <div className="space-y-4 p-5 sm:p-6"><dl className="grid grid-cols-3 gap-3"><Metric label="Succeeded" value={job.successCount} tone="success" /><Metric label="Failed" value={job.failedCount} tone="danger" /><Metric label="Skipped" value={job.skippedCount} /></dl>
      <JobErrorPanel job={job} />
    </div>
  </section>;
}
function Metric({ label, value, tone = "neutral" }: { label: string; value: number | null; tone?: "neutral" | "success" | "danger" }) { const classes = tone === "success" ? "border-emerald-100 bg-emerald-50/60" : tone === "danger" ? "border-rose-100 bg-rose-50/60" : "border-zinc-100 bg-zinc-50"; return <div className={`rounded-xl border px-3 py-2.5 ${classes}`}><dt className="text-xs font-medium text-zinc-500">{label}</dt><dd className="mt-1 text-lg font-bold tabular-nums text-zinc-900">{value ?? 0}</dd></div>; }
