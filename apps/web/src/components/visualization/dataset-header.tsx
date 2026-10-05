import { ArrowLeft, Database, LockSimple } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { VisualizationDatasetIdentity } from "@/types/visualization";

export function DatasetHeader({ dataset }: { dataset: VisualizationDatasetIdentity }) {
  return <header>
    <Link href="/datasets" className="inline-flex items-center gap-2 rounded text-sm text-zinc-500 hover:text-sky-600 focus-visible:outline-2 focus-visible:outline-sky-500"><ArrowLeft aria-hidden="true" size={15} />Datasets</Link>
    <div className="mt-5 flex items-start gap-4">
      <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-sky-100 bg-sky-50 text-sky-600 dark:border-sky-900 dark:bg-sky-950"><Database aria-hidden="true" size={26} /></div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">Dataset explorer</p>
        <div className="mt-1 flex flex-wrap items-center gap-3"><h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight text-zinc-950 sm:text-3xl dark:text-zinc-50">{dataset.name}</h1><Badge variant="success">Completed</Badge></div>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Explore records, inspect annotations, and understand your dataset.</p>
      </div>
      <Badge className="hidden shrink-0 gap-1.5 sm:inline-flex"><LockSimple aria-hidden="true" size={12} />Read-only</Badge>
    </div>
  </header>;
}
