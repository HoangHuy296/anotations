import { Database, ChartBar, BracketsCurly, Stack, ClockCounterClockwise } from "@phosphor-icons/react/dist/ssr";
import { DatasetSummary } from "@/components/visualization/dataset-summary";
import Link from "next/link";
import { VisualizationSession } from "@/components/visualization/visualization-session";

import { ActivityTab } from "@/components/visualization/activity-tab";
import { DataTab } from "@/components/visualization/data-tab";
import { DatasetHeader } from "@/components/visualization/dataset-header";
import { InsightsTab } from "@/components/visualization/insights-tab";
import { SchemaTab } from "@/components/visualization/schema-tab";
import { VersionsTab } from "@/components/visualization/versions-tab";
import { visualizationTabHref } from "@/lib/validation/visualization";
import { cn } from "@/lib/utils";
import { visualizationTabs, type VisualizationDatasetIdentity, type VisualizationTab } from "@/types/visualization";

const icons = { data: Database, insights: ChartBar, schema: BracketsCurly, versions: Stack, activity: ClockCounterClockwise };
const panels = { data: DataTab, insights: InsightsTab, schema: SchemaTab, versions: VersionsTab, activity: ActivityTab };
const labels = { data: "Data", insights: "Insights", schema: "Schema", versions: "Versions", activity: "Activity" };

export function VisualizationShell({ dataset, tab }: { dataset: VisualizationDatasetIdentity; tab: VisualizationTab }) {
  const Panel = panels[tab];
  return <VisualizationSession datasetId={dataset.id}><div className="mx-auto max-w-[1400px] px-4 py-7 sm:px-6 lg:px-8 lg:py-9">
    <DatasetHeader dataset={dataset} />
    {/* URL navigation uses native link semantics: Tab/Enter, open in new tab,
        and browser history. No client-only ARIA tab widget or cached guard. */}
    <nav aria-label="Dataset visualization sections" className="mt-7 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
      <ul className="flex min-w-max gap-1">
        {visualizationTabs.map((value) => <li key={value}>
          <Link href={visualizationTabHref(dataset.id, value)} prefetch={false} aria-current={tab === value ? "page" : undefined}
            className={cn("inline-flex min-h-11 items-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500", tab === value
              ? "border-sky-600 text-sky-700 dark:border-sky-400 dark:text-sky-400"
              : "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-950 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-50")}>
            {(() => { const Icon = icons[value]; return <Icon aria-hidden="true" size={17} />; })()}{labels[value]}
          </Link>
        </li>)}
      </ul>
    </nav>
    <div className="grid min-w-0 gap-8 pt-6 lg:grid-cols-[minmax(0,1fr)_240px]">
      <div className="min-w-0"><Panel /></div><DatasetSummary dataset={dataset} />
    </div>
  </div></VisualizationSession>;
}
