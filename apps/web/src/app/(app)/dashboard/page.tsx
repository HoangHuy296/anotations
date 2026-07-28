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
import { AssetStatus, DatasetSourceMode, UserRole } from "@internal/db";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { AppShell } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { DatasetActionMenu } from "@/components/dashboard/dataset-action-menu";
import { Button } from "@/components/ui/button";
import { getRequestActor } from "@/lib/auth";
import { db, isDatabaseConfigured } from "@/lib/db";

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

type ActiveDataset = {
  id: string;
  name: string;
  sourceMode: DatasetSourceMode;
  sourceRef: string | null;
  externalRepository: { fullName: string } | null;
  _count: { assets: number };
  completedAssets: number;
};

export default async function DashboardPage() {
  await connection();
  const actor = await getRequestActor();
  if (!actor) redirect("/unauthorized");
  const activeDatasets = await loadActiveDatasets(actor);
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
            {activeDatasets.length === 0 ? (
              <div className="px-5 py-12 text-center lg:px-6">
                <Database aria-hidden="true" className="mx-auto text-zinc-300" size={28} weight="duotone" />
                <p className="mt-3 text-sm font-semibold text-zinc-800">No datasets yet</p>
                <p className="mt-1 text-sm text-zinc-500">Create one from a repository or upload a local folder to begin annotation work.</p>
              </div>
            ) : activeDatasets.map((dataset) => {
              const total = dataset._count.assets;
              const progress = total === 0 ? 0 : Math.round((dataset.completedAssets / total) * 1000) / 10;
              const status = total === 0 ? "Empty" : progress >= 100 ? "Complete" : "In progress";
              const variant = total === 0 ? "neutral" as const : progress >= 100 ? "success" as const : "warning" as const;
              const source = dataset.externalRepository?.fullName ?? (dataset.sourceMode === DatasetSourceMode.UPLOAD ? "Local upload" : "Repository source");
              const branch = dataset.sourceRef ?? "default ref";
              return (
              <article
                key={dataset.id}
                className="grid gap-5 border-b border-zinc-200 p-5 last:border-b-0 hover:bg-zinc-50/70 md:grid-cols-[minmax(0,1.2fr)_minmax(200px,0.7fr)_auto] md:items-center lg:p-6"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="grid size-9 place-items-center rounded-xl bg-zinc-100 text-zinc-600">
                      <Database aria-hidden="true" size={18} weight="duotone" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-bold text-zinc-950">
                        <Link className="rounded-sm outline-none hover:text-sky-700 focus-visible:ring-2 focus-visible:ring-sky-400" href={`/workspace/${dataset.id}`}>{dataset.name}</Link>
                      </h3>
                      <p className="mt-1 truncate font-mono text-[10px] text-zinc-400">
                        {source}
                      </p>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-4 text-xs">
                    <span className="text-zinc-400">{total} images</span>
                    <span className="font-mono font-semibold text-zinc-800">
                      {progress}%
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100">
                    <div
                      className="h-full rounded-full bg-sky-600"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3 md:justify-end">
                  <div className="hidden text-right lg:block">
                    <p className="flex items-center justify-end gap-1.5 text-[11px] text-zinc-500">
                      <GitBranch aria-hidden="true" size={13} />
                      {branch}
                    </p>
                    <p className="mt-1 flex items-center justify-end gap-1.5 font-mono text-[10px] text-zinc-400">
                      <Clock aria-hidden="true" size={12} />
                      updated recently
                    </p>
                  </div>
                  <Badge variant={variant}>{status}</Badge>
                  <Button
                    asChild
                    variant="icon"
                    aria-label={`Open ${dataset.name}`}
                  >
                    <Link href={`/workspace/${dataset.id}`}>
                      <ArrowRight aria-hidden="true" size={17} />
                    </Link>
                  </Button>
                </div>
              </article>
              );
            })}
          </div>
        </section>
      </div>
    </AppShell>
  );
}

async function loadActiveDatasets(actor: NonNullable<Awaited<ReturnType<typeof getRequestActor>>>) {
  if (!isDatabaseConfigured()) return [] as ActiveDataset[];
  try {
    const datasets = await db.dataset.findMany({
      where: {
        deletedAt: null,
        archivedAt: null,
        ...(actor.role === UserRole.ADMIN
          ? {}
          : { OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }] }),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 5,
      include: {
        externalRepository: { select: { fullName: true } },
        _count: { select: { assets: true } },
      },
    });
    const counts = await db.asset.groupBy({
      by: ["datasetId", "status"],
      where: { datasetId: { in: datasets.map((dataset) => dataset.id) }, deletedAt: null },
      _count: { _all: true },
    });
    return datasets.map((dataset) => ({
      ...dataset,
      completedAssets: counts
        .filter((count) => count.datasetId === dataset.id && count.status !== AssetStatus.NEW)
        .reduce((sum, count) => sum + count._count._all, 0),
    }));
  } catch {
    return [] as ActiveDataset[];
  }
}
