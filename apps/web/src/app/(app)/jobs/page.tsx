import { ListChecks } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { AppShell } from "@/components/layout/app-shell";
import { JobStageIndicator } from "@/components/jobs/job-stage-indicator";
import { getRequestActor } from "@/lib/auth";
import { listImportJobHistory } from "@/lib/jobs/job-history";
import { jobProgressPercent } from "@/lib/jobs/job-progress-view";

const formatTime = (date: Date) => date.toISOString().replace("T", " ").slice(0, 19) + " UTC";

export default async function JobsPage() {
  await connection();
  const actor = await getRequestActor();
  if (!actor) redirect("/unauthorized");
  const jobs = await listImportJobHistory(actor.id);

  return (
    <AppShell currentPath="/jobs">
      <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <header className="border-b border-zinc-200 pb-7 dark:border-zinc-800">
          <div className="flex items-center gap-2 text-sky-700 dark:text-sky-400">
            <ListChecks aria-hidden="true" size={18} weight="duotone" />
            <span className="text-xs font-bold uppercase tracking-[0.14em]">History</span>
          </div>
          <h1 className="mt-3 text-3xl font-bold tracking-[-0.04em] text-zinc-950 dark:text-zinc-50">Import jobs</h1>
          <p className="mt-2 max-w-[62ch] text-sm leading-6 text-zinc-500 dark:text-zinc-400">Every upload and repository import into your datasets, newest first.</p>
        </header>
        {jobs.length === 0 ? (
          <p className="mt-8 rounded-2xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">No import jobs yet. Uploads and imports will appear here.</p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-2xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-zinc-50 text-xs font-bold uppercase tracking-[0.1em] text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr><th className="px-4 py-3">Dataset</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Progress</th><th className="px-4 py-3">Started</th><th className="px-4 py-3">Finished</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {jobs.map((job) => {
                  const percent = jobProgressPercent(job);
                  return (
                    <tr key={job.id} className="hover:bg-zinc-50/70 dark:hover:bg-zinc-900/50">
                      <td className="px-4 py-3"><Link href={`/jobs/${job.id}`} className="font-semibold text-zinc-950 hover:text-sky-700 dark:text-zinc-50">{job.dataset.name}</Link><p className="font-mono text-[11px] text-zinc-400">{job.id.slice(0, 8)}</p></td>
                      <td className="px-4 py-3"><JobStageIndicator status={job.status} stage={null} /></td>
                      <td className="px-4 py-3 tabular-nums text-zinc-600 dark:text-zinc-300">{percent === null ? "—" : `${percent}%`}{job.totalItems !== null ? <span className="ml-1 text-zinc-400">({job.processedItems ?? 0}/{job.totalItems}{job.failedItems ? `, ${job.failedItems} failed` : ""})</span> : null}</td>
                      <td className="px-4 py-3 text-zinc-500">{formatTime(job.createdAt)}</td>
                      <td className="px-4 py-3 text-zinc-500">{job.finishedAt ? formatTime(job.finishedAt) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}
