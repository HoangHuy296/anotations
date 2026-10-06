import { CheckCircle, Database, LockSimple } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { VisualizationDatasetIdentity } from "@/types/visualization";

export function DatasetHeader({ dataset }: { dataset: VisualizationDatasetIdentity }) {
  return (
    <header className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-start gap-x-2.5 gap-y-2">
        <Link
          href="/datasets"
          className="inline-flex shrink-0 items-center gap-2 rounded py-1 text-sm font-medium text-zinc-500 transition-colors hover:text-zinc-950 focus-visible:outline-2 focus-visible:outline-sky-500 dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          <Database aria-hidden="true" size={17} />
          Datasets:
        </Link>
        <span aria-hidden="true" className="py-1 text-zinc-300 dark:text-zinc-600">/</span>
        <h1 className="min-w-0 flex-1 basis-48 break-words text-xl font-semibold tracking-tight text-zinc-950 sm:basis-auto dark:text-zinc-50">
          {dataset.name}
        </h1>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-zinc-500 dark:text-zinc-400">
        <div className="flex items-center gap-2">
          <span>Status:</span>
          <Badge variant="success" className="gap-1.5 rounded-md px-2 py-1">
            <CheckCircle aria-hidden="true" size={13} />Completed
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <span>Access:</span>
          <Badge className="gap-1.5 rounded-md px-2 py-1">
            <LockSimple aria-hidden="true" size={12} />Read-only
          </Badge>
        </div>
        <span className="hidden h-3 w-px bg-zinc-200 sm:block dark:bg-zinc-800" aria-hidden="true" />
        <p className="basis-full sm:basis-auto">Explore dataset records and saved annotations.</p>
      </div>
    </header>
  );
}
