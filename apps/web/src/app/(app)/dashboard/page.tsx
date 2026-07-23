import {
  ArrowRight,
  BoundingBox,
  CheckCircle,
  Clock,
  Database,
  GitBranch,
  Images,
  TrendUp,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { DatasetActionMenu } from "@/components/dashboard/dataset-action-menu";
import { Button } from "@/components/ui/button";
import { getRequestActor } from "@/lib/auth";

const metrics = [
  {
    label: "Imported images",
    value: "1,284",
    detail: "+86 this week",
    icon: Images,
  },
  {
    label: "Annotations",
    value: "8,471",
    detail: "6.6 per image",
    icon: BoundingBox,
  },
  {
    label: "Verified",
    value: "61.4%",
    detail: "+4.8% this sprint",
    icon: CheckCircle,
  },
];

const datasets = [
  {
    name: "street-scenes-q2",
    source: "vision-lab / training-images",
    branch: "main",
    progress: 61.4,
    images: 184,
    status: "In progress",
    variant: "warning" as const,
  },
  {
    name: "warehouse-safety",
    source: "operations / camera-samples",
    branch: "release/2026-06",
    progress: 84.7,
    images: 326,
    status: "Review pending",
    variant: "danger" as const,
  },
  {
    name: "road-signs-north",
    source: "mobility / regional-capture",
    branch: "main",
    progress: 47.2,
    images: 774,
    status: "Auto-detected",
    variant: "info" as const,
  },
];

export default async function DashboardPage() {
  if (!(await getRequestActor())) redirect("/unauthorized");
  return (
    <AppShell currentPath="/dashboard">
      <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <section className="grid gap-8 border-b border-zinc-200 pb-9 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)] xl:items-end">
          <div>
            <Badge variant="info">Gitea-connected workspace</Badge>
            <h1 className="mt-5 max-w-3xl text-3xl font-bold leading-[1.05] tracking-[-0.045em] text-zinc-950 sm:text-4xl lg:text-5xl">
              Turn repository images into review-ready training data.
            </h1>
            <p className="mt-5 max-w-[62ch] text-base leading-7 text-zinc-500">
              Import source imagery, annotate at native resolution, and keep
              every dataset traceable to its repository origin.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row xl:justify-end">
            <Button asChild variant="secondary" size="lg">
              <Link href="/datasets">
                Browse datasets
                <ArrowRight aria-hidden="true" size={18} weight="bold" />
              </Link>
            </Button>
            <DatasetActionMenu />
          </div>
        </section>

        <section
          className="grid divide-y divide-zinc-200 border-b border-zinc-200 md:grid-cols-3 md:divide-x md:divide-y-0"
          aria-label="Workspace metrics"
        >
          {metrics.map((metric) => {
            const Icon = metric.icon;

            return (
              <div key={metric.label} className="py-7 md:px-6 md:first:pl-0">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm font-medium text-zinc-500">
                    {metric.label}
                  </span>
                  <Icon
                    aria-hidden="true"
                    className="text-zinc-400"
                    size={20}
                    weight="duotone"
                  />
                </div>
                <p className="mt-5 font-mono text-3xl font-semibold tracking-[-0.04em] text-zinc-950">
                  {metric.value}
                </p>
                <p className="mt-2 flex items-center gap-1.5 text-xs text-zinc-400">
                  <TrendUp
                    aria-hidden="true"
                    className="text-emerald-600"
                    size={14}
                  />
                  {metric.detail}
                </p>
              </div>
            );
          })}
        </section>

        <section className="py-9">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-zinc-400">
                Active work
              </p>
              <h2 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-zinc-950">
                Datasets in motion
              </h2>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link href="/datasets">
                View all datasets
                <ArrowRight aria-hidden="true" size={15} />
              </Link>
            </Button>
          </div>

          <div className="mt-6 overflow-hidden rounded-2xl border border-zinc-200">
            {datasets.map((dataset, index) => (
              <article
                key={dataset.name}
                className="grid gap-5 border-b border-zinc-200 p-5 last:border-b-0 hover:bg-zinc-50/70 md:grid-cols-[minmax(0,1.2fr)_minmax(200px,0.7fr)_auto] md:items-center lg:p-6"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="grid size-9 place-items-center rounded-xl bg-zinc-100 text-zinc-600">
                      <Database aria-hidden="true" size={18} weight="duotone" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-bold text-zinc-950">
                        {dataset.name}
                      </h3>
                      <p className="mt-1 truncate font-mono text-[10px] text-zinc-400">
                        {dataset.source}
                      </p>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-4 text-xs">
                    <span className="text-zinc-400">{dataset.images} images</span>
                    <span className="font-mono font-semibold text-zinc-800">
                      {dataset.progress}%
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100">
                    <div
                      className="h-full rounded-full bg-sky-600"
                      style={{ width: `${dataset.progress}%` }}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3 md:justify-end">
                  <div className="hidden text-right lg:block">
                    <p className="flex items-center justify-end gap-1.5 text-[11px] text-zinc-500">
                      <GitBranch aria-hidden="true" size={13} />
                      {dataset.branch}
                    </p>
                    <p className="mt-1 flex items-center justify-end gap-1.5 font-mono text-[10px] text-zinc-400">
                      <Clock aria-hidden="true" size={12} />
                      {index + 2}h ago
                    </p>
                  </div>
                  <Badge variant={dataset.variant}>{dataset.status}</Badge>
                  <Button
                    asChild
                    variant="icon"
                    aria-label={`Open ${dataset.name}`}
                  >
                    <Link href="/datasets">
                      <ArrowRight aria-hidden="true" size={17} />
                    </Link>
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
