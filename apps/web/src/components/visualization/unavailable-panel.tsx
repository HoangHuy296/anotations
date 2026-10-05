import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";

export function UnavailablePanel({ title, description, message, icon }: {
  title: string; description: string; message: string; icon: ReactNode;
}) {
  return <section aria-labelledby="visualization-panel-title" className="mt-6 rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-200 p-5 dark:border-zinc-800 sm:p-6">
      <div>
        <h2 id="visualization-panel-title" className="text-lg font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">{title}</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-500 dark:text-zinc-400">{description}</p>
      </div>
      <Badge>Not available yet</Badge>
    </div>
    <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
      <span className="grid size-12 place-items-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-400 dark:border-zinc-700 dark:bg-zinc-800">{icon}</span>
      <p className="mt-5 max-w-lg text-sm leading-6 text-zinc-500 dark:text-zinc-400">{message}</p>
    </div>
  </section>;
}
