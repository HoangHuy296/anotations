import { ArrowUpRight, CaretDown, GitBranch, GithubLogo, GitlabLogo, PlugsConnected } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

import { cn } from "@/lib/utils";

type SourceConnectionsPanelProps = { savedGiteaConnections: number | null; className?: string };

const upcomingProviders = [
  { name: "GitHub", icon: GithubLogo, description: "GitHub repositories" },
  { name: "GitLab", icon: GitlabLogo, description: "GitLab repositories" },
];

export function SourceConnectionsPanel({ savedGiteaConnections, className }: SourceConnectionsPanelProps) {
  const saved = savedGiteaConnections !== null && savedGiteaConnections > 0;
  return <section aria-label="Source connections" className={cn("border-t border-zinc-200 pt-5 dark:border-zinc-800", className)}>
    <div className="mb-3 flex items-center justify-between px-1">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">Source connections</h2>
      <PlugsConnected aria-hidden="true" size={14} className="text-zinc-400" />
    </div>
    <div className="space-y-2">
      <Link href="/datasets/imports" className="group block rounded-xl border border-zinc-200 bg-white p-3.5 outline-none transition-colors hover:border-sky-300 hover:bg-sky-50/30 focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-sky-800 dark:hover:bg-sky-950/30">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-emerald-100 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400"><GitBranch aria-hidden="true" size={19} weight="bold" /></span>
          <div className="min-w-0 flex-1">
            <h3 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">Gitea</h3>
            <p className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">Repository source</p>
          </div>
          <ArrowUpRight aria-hidden="true" size={14} className="text-zinc-400 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 motion-reduce:transform-none" />
        </div>
        <div className="mt-3 border-t border-zinc-100 pt-2.5 dark:border-zinc-800">
          <p className={`flex items-center gap-1.5 text-[10px] font-medium ${saved ? "text-emerald-700 dark:text-emerald-400" : "text-zinc-500 dark:text-zinc-400"}`}><span aria-hidden="true" className={`size-1.5 rounded-full ${saved ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600"}`} />{savedGiteaConnections === null ? "Status unavailable" : saved ? `${savedGiteaConnections} saved connection${savedGiteaConnections === 1 ? "" : "s"}` : "No saved connections"}</p>
          <p className="mt-1.5 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">{saved ? "Use a saved connection to import a repository." : "Import a public repository or connect a private source."}</p>
        </div>
      </Link>
      <details className="group/providers">
        <summary className="flex cursor-pointer list-none items-center justify-between rounded-lg px-1 py-2 text-[11px] font-medium text-zinc-500 outline-none hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-sky-500 [&::-webkit-details-marker]:hidden dark:text-zinc-400 dark:hover:text-zinc-100">More providers<span className="flex items-center gap-2"><span className="text-[10px] text-zinc-400">{upcomingProviders.length}</span><CaretDown aria-hidden="true" size={11} className="transition-transform group-open/providers:rotate-180 motion-reduce:transition-none" /></span></summary>
        <div className="mt-1 space-y-2">
          {upcomingProviders.map(({ name, icon: Icon, description }) => <div key={name} className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-700 dark:bg-zinc-900/60">
            <div className="flex items-center gap-2"><Icon aria-hidden="true" size={17} className="text-zinc-400" /><h3 className="flex-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">{name}</h3><span className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[9px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">Planned</span></div>
            <p className="mt-1.5 text-[10px] text-zinc-400">{description} · Not available yet</p>
          </div>)}
        </div>
      </details>
    </div>
  </section>;
}
