import {
  ArrowRight,
  BoundingBox,
  CheckCircle,
  Database,
  GitBranch,
  Images,
  TrayArrowDown,
  TrendUp,
  UploadSimple,
} from "@phosphor-icons/react/dist/ssr";
import { AssetStatus, DatasetSourceMode, Modality, UserRole } from "@internal/db";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { AppShell } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { DatasetActionMenu } from "@/components/dashboard/dataset-action-menu";
import { Button } from "@/components/ui/button";
import { getRequestActor } from "@/lib/auth";
import { db, isDatabaseConfigured } from "@/lib/db";
import { datasetStatusLabels, readDatasetWorkflowStatus } from "@/lib/datasets/dataset-library-query";
import { datasetDestination } from "@/lib/datasets/dataset-destination";

const dateFormatter = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

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
  sourceRootPath: string | null;
  metadata: unknown;
  createdAt: Date;
  externalRepository: { fullName: string } | null;
  _count: { assets: number };
  completedAssets: number;
  modalities: { modality: Modality; count: number }[];
};

export default async function DashboardPage() {
  await connection();
  const actor = await getRequestActor();
  if (!actor) redirect("/unauthorized");
  const activeDatasets = await loadActiveDatasets(actor);
  return (
    <AppShell currentPath="/dashboard">
      <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <section className="grid gap-8 border-b border-zinc-200 pb-9 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)] xl:items-end dark:border-zinc-800">
          <div>
            <Badge variant="info">Gitea-connected workspace</Badge>
            <h1 className="mt-5 max-w-3xl text-3xl font-bold leading-[1.05] tracking-[-0.045em] text-zinc-950 sm:text-4xl lg:text-5xl dark:text-zinc-50">
              Turn repository images into review-ready training data.
            </h1>
            <p className="mt-5 max-w-[62ch] text-base leading-7 text-zinc-500 dark:text-zinc-400">
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
          className="grid divide-y divide-zinc-200 border-b border-zinc-200 md:grid-cols-3 md:divide-x md:divide-y-0 dark:divide-zinc-800 dark:border-zinc-800"
          aria-label="Workspace metrics"
        >
          {metrics.map((metric) => {
            const Icon = metric.icon;

            return (
              <div key={metric.label} className="py-7 md:px-6 md:first:pl-0">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                    {metric.label}
                  </span>
                  <Icon
                    aria-hidden="true"
                    className="text-zinc-400"
                    size={20}
                    weight="duotone"
                  />
                </div>
                <p className="mt-5 font-mono text-3xl font-semibold tracking-[-0.04em] text-zinc-950 dark:text-zinc-50">
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
              <h2 className="mt-2 text-2xl font-bold tracking-[-0.03em] text-zinc-950 dark:text-zinc-50">
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

          {activeDatasets.length === 0 ? (
            <div className="mt-6 grid min-h-80 place-items-center rounded-2xl border border-dashed border-zinc-300 bg-zinc-50/60 dark:border-zinc-700 dark:bg-zinc-900/40">
              <div className="max-w-sm px-6 py-12 text-center">
                <span className="mx-auto grid size-14 place-items-center rounded-2xl border border-zinc-200 bg-white text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"><Database aria-hidden="true" size={25} weight="duotone" /></span>
                <h3 className="mt-5 text-lg font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">No datasets yet</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">Upload a folder from your computer or import a repository to start annotating.</p>
                <Button asChild variant="secondary" className="mt-5"><Link href="/datasets/local-folder">Upload your first dataset<ArrowRight aria-hidden="true" size={15} /></Link></Button>
              </div>
            </div>
          ) : (
            <section aria-label="Active datasets" className="mt-6 rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <div className="hidden grid-cols-[minmax(0,1fr)_minmax(180px,0.65fr)_120px_56px] gap-6 rounded-t-2xl border-b border-zinc-200 bg-zinc-50/80 px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500 xl:grid dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
                <span>Dataset / source</span><span>Assets / activity</span><span>Status</span><span className="text-right">Open</span>
              </div>
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {activeDatasets.map((dataset) => {
                  const total = dataset._count.assets;
                  const progress = total === 0 ? 0 : Math.round((dataset.completedAssets / total) * 1000) / 10;
                  const workflowStatus = readDatasetWorkflowStatus(dataset.metadata);
                  const destination = datasetDestination(dataset.id, workflowStatus);
                  const uploaded = dataset.sourceMode === DatasetSourceMode.UPLOAD;
                  const SourceIcon = uploaded ? UploadSimple : TrayArrowDown;
                  return (
                    <article key={dataset.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-5 p-5 transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-zinc-50/60 xl:grid-cols-[minmax(0,1fr)_minmax(180px,0.65fr)_120px_56px] xl:items-center xl:gap-6 dark:hover:bg-zinc-800/40">
                      <div className="col-span-2 flex min-w-0 items-start gap-3.5 sm:col-span-1">
                        <span className={`grid size-11 shrink-0 place-items-center rounded-xl border ${uploaded ? "border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400" : "border-sky-100 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-400"}`}><Database aria-hidden="true" size={21} weight="duotone" /></span>
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-semibold text-zinc-950 dark:text-zinc-50"><Link className="rounded-sm outline-none hover:text-sky-700 focus-visible:ring-2 focus-visible:ring-sky-400 dark:hover:text-sky-400" href={destination} prefetch={false} aria-label={`Open ${dataset.name}`}>{dataset.name}</Link></h3>
                          <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                            <span className="inline-flex shrink-0 items-center gap-1 font-medium"><SourceIcon aria-hidden="true" size={12} />{uploaded ? "Upload" : "Import"}</span>
                            <span aria-hidden="true" className="text-zinc-300 dark:text-zinc-700">/</span>
                            <span className="truncate" title={dataset.externalRepository?.fullName ?? undefined}>{dataset.externalRepository?.fullName ?? (uploaded ? "Local files" : "Repository")}{dataset.sourceRootPath ? ` / ${dataset.sourceRootPath}` : ""}</span>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-zinc-400">
                            <time dateTime={dataset.createdAt.toISOString()}>Created {dateFormatter.format(dataset.createdAt)}</time>
                            {!uploaded && dataset.sourceRef ? <span className="inline-flex min-w-0 items-center gap-1"><GitBranch aria-hidden="true" size={11} /><span className="max-w-32 truncate font-mono">{dataset.sourceRef}</span></span> : null}
                          </div>
                        </div>
                      </div>
                      <div className="col-span-2 row-start-2 xl:col-span-1 xl:row-auto">
                        <div className="flex justify-between gap-3 text-xs">
                          <span className="flex items-center gap-1.5 font-medium text-zinc-700 dark:text-zinc-300"><Images aria-hidden="true" size={14} className="text-zinc-400" />{total.toLocaleString()} assets</span>
                          <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400" title="Share of assets that have moved past New; dataset status is managed separately.">{progress}% active</span>
                        </div>
                        <div role="progressbar" aria-label={`Assets past New in ${dataset.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="mt-2.5 h-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"><div className="h-full rounded-full bg-sky-600" style={{ width: `${progress}%` }} /></div>
                        <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1" aria-label="Asset modality counts">
                          {dataset.modalities.length ? dataset.modalities.map(({ modality, count }) => <span key={modality} className="text-[10px] text-zinc-500 dark:text-zinc-400"><span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">{count.toLocaleString()}</span> {modality.toLowerCase()}</span>) : <span className="text-[10px] text-zinc-400">No assets yet</span>}
                        </div>
                      </div>
                      <div className="col-start-1 row-start-3 self-center xl:col-auto xl:row-auto"><Badge className="gap-1.5 whitespace-nowrap" variant={workflowStatus === "IN_PROGRESS" ? "warning" : "success"}><span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{datasetStatusLabels[workflowStatus]}</Badge></div>
                      <div className="col-start-2 row-start-3 flex items-center justify-end sm:row-start-1 xl:col-auto xl:row-auto">
                        <Button asChild variant="icon" aria-label={`Open ${dataset.name}`}><Link href={destination} prefetch={false}><ArrowRight aria-hidden="true" size={17} /></Link></Button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}
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
    const assetWhere = { datasetId: { in: datasets.map((dataset) => dataset.id) }, deletedAt: null };
    const [counts, modalityCounts] = await Promise.all([
      db.asset.groupBy({ by: ["datasetId", "status"], where: assetWhere, _count: { _all: true } }),
      db.asset.groupBy({ by: ["datasetId", "modality"], where: assetWhere, _count: { _all: true } }),
    ]);
    return datasets.map((dataset) => ({
      ...dataset,
      completedAssets: counts
        .filter((count) => count.datasetId === dataset.id && count.status !== AssetStatus.NEW)
        .reduce((sum, count) => sum + count._count._all, 0),
      modalities: modalityCounts
        .filter((count) => count.datasetId === dataset.id)
        .map((count) => ({ modality: count.modality, count: count._count._all })),
    }));
  } catch {
    return [] as ActiveDataset[];
  }
}
