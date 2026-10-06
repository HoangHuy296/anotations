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
const labels = { data: "Dataset viewer", insights: "Insights", schema: "Schema", versions: "Files and versions", activity: "Activity" };

export function VisualizationShell({ dataset, tab }: { dataset: VisualizationDatasetIdentity; tab: VisualizationTab }) {
  const Panel = panels[tab];
  return <VisualizationSession datasetId={dataset.id}><div className="mx-auto min-w-0 max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8 dark:bg-[#0b0f17]">
    <DatasetHeader dataset={dataset} />
    {/* URL navigation uses native link semantics: Tab/Enter, open in new tab,
        and browser history. No client-only ARIA tab widget or cached guard. */}
    <nav aria-label="Dataset visualization sections" className="mt-5 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
      <ul className="flex min-w-max gap-2">
        {visualizationTabs.map((value) => <li key={value}>
          <Link href={visualizationTabHref(dataset.id, value)} prefetch={false} aria-current={tab === value ? "page" : undefined}
            className={cn("inline-flex min-h-11 items-center gap-2 border-b-2 px-3 py-3 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500", tab === value
              ? "border-zinc-700 text-zinc-950 dark:border-zinc-300 dark:text-zinc-100"
              : "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-950 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-50")}>
            {(() => { const Icon = icons[value]; return <Icon aria-hidden="true" size={17} />; })()}{labels[value]}
          </Link>
        </li>)}
      </ul>
    </nav>
    <div className="grid min-w-0 gap-6 pt-5 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0"><Panel /></div><DatasetSummary dataset={dataset} />
    </div>
  </div></VisualizationSession>;
}
