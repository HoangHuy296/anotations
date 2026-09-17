import { ArrowLeft, ArrowRight, Database, GitBranch, Images, TrayArrowDown, UploadSimple, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { AssetStatus, Modality, UserRole } from "@internal/db";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { DatasetLibraryToolbar } from "@/components/datasets/dataset-library-toolbar";
import { DatasetRowActions } from "@/components/datasets/dataset-row-actions";
import { AppShell } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getRequestActor } from "@/lib/auth";
import { isDatabaseConfigured } from "@/lib/db";
import { datasetLibraryHref, datasetLibraryQuerySchema, datasetStatusLabels, readDatasetWorkflowStatus } from "@/lib/datasets/dataset-library-query";
import { getDatasetLibrary } from "@/lib/datasets/dataset-library-service";

type SearchParams = Record<string, string | string[] | undefined>;
const dateFormatter = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export default async function DatasetsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await connection();
  const actor = await getRequestActor();
  if (!actor) redirect("/unauthorized");
  if (!isDatabaseConfigured()) return <DatasetSetupState />;

  const params = await searchParams;
  const query = datasetLibraryQuerySchema.parse(Object.fromEntries(Object.entries(params).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])));
  let data;
  try {
    data = await getDatasetLibrary(actor, query);
  } catch {
    console.error("Datasets could not be loaded.");
    return <DatasetSetupState unavailable />;
  }
  const { datasets, statusCounts, modalityCounts, total: matchingCount, hasNext, hasPrevious } = data;
  const filtered = query.status !== "ALL" || query.method !== "ALL";

  return (
    <AppShell currentPath="/datasets">
      <div className="mx-auto max-w-[1400px] px-4 py-7 sm:px-6 lg:px-8 lg:py-9">
        <header>
          <div className="flex items-center gap-2 text-xs font-semibold text-zinc-500 dark:text-zinc-400"><Database aria-hidden="true" size={15} />Data library</div>
          <div className="mt-3 flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-[-0.04em] text-zinc-950 dark:text-zinc-50">Datasets</h1>
            <span className="rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1 font-mono text-xs font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" aria-label={`${matchingCount} matching datasets`}>{matchingCount.toLocaleString()}</span>
          </div>
          <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">Your data, ready for annotation. Pick a dataset to continue where you left off.</p>
        </header>

        <div className="mt-7 flex flex-wrap items-end justify-between gap-5 border-y border-zinc-200 py-4 dark:border-zinc-800">
          <div className="pb-2">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{filtered ? "Filtered datasets" : "All datasets"}</h2>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Most recently updated first</p>
          </div>
          <DatasetLibraryToolbar status={query.status} method={query.method} />
        </div>

        {datasets.length === 0 ? (
          <div className="mt-6 grid min-h-80 place-items-center rounded-2xl border border-dashed border-zinc-300 bg-zinc-50/60 dark:border-zinc-700 dark:bg-zinc-900/40">
            <div className="max-w-sm px-6 py-12 text-center">
              <span className="mx-auto grid size-14 place-items-center rounded-2xl border border-zinc-200 bg-white text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"><Database aria-hidden="true" size={25} weight="duotone" /></span>
              <h2 className="mt-5 text-lg font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">{query.after || query.before ? "No datasets on this page" : filtered ? "No matching datasets" : "Start your data library"}</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">{query.after || query.before ? "The list may have changed. Return to the first page to see the latest datasets." : filtered ? "Try another status or creation method, or clear the filters to see all your datasets." : "Upload a folder from your computer or import a repository to start annotating."}</p>
              <Button asChild variant="secondary" className="mt-5"><Link href={query.after || query.before ? datasetLibraryHref(query) : filtered ? "/datasets" : "/datasets/local-folder"}>{query.after || query.before ? "Back to first page" : filtered ? "Clear filters" : "Upload your first dataset"}<ArrowRight aria-hidden="true" size={15} /></Link></Button>
            </div>
          </div>
        ) : (
          <section aria-label="Dataset list" className="mt-6 rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <div className="hidden grid-cols-[minmax(0,1fr)_minmax(180px,0.65fr)_120px_92px] gap-6 rounded-t-2xl border-b border-zinc-200 bg-zinc-50/80 px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500 xl:grid dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
              <span>Dataset / source</span><span>Assets / activity</span><span>Status</span><span className="text-right">Actions</span>
            </div>
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {datasets.map((dataset) => {
                const total = dataset._count.assets;
                const progressed = statusCounts.filter((count) => count.datasetId === dataset.id && count.status !== AssetStatus.NEW).reduce((sum, count) => sum + count._count._all, 0);
                const progress = total === 0 ? 0 : Math.round((progressed / total) * 1000) / 10;
                const workflowStatus = readDatasetWorkflowStatus(dataset.metadata);
                const canManage = actor.role === UserRole.ADMIN || dataset.ownerId === actor.id || dataset.members.some((member) => member.role === "MANAGER");
                const uploaded = dataset.sourceMode === "UPLOAD";
                const SourceIcon = uploaded ? UploadSimple : TrayArrowDown;
                const modalities = ([Modality.IMAGE, Modality.VIDEO, Modality.AUDIO, Modality.TEXT] as const).map((modality) => ({ modality, count: modalityCounts.find((entry) => entry.datasetId === dataset.id && entry.modality === modality)?._count._all ?? 0 })).filter(({ count }) => count > 0);
                return <article key={dataset.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-5 p-5 transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-zinc-50/60 xl:grid-cols-[minmax(0,1fr)_minmax(180px,0.65fr)_120px_92px] xl:items-center xl:gap-6 dark:hover:bg-zinc-800/40">
                  <div className="col-span-2 flex min-w-0 items-start gap-3.5 sm:col-span-1">
                    <span className={`grid size-11 shrink-0 place-items-center rounded-xl border ${uploaded ? "border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400" : "border-sky-100 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-400"}`}><Database aria-hidden="true" size={21} weight="duotone" /></span>
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-zinc-950 dark:text-zinc-50"><Link className="rounded-sm outline-none hover:text-sky-700 focus-visible:ring-2 focus-visible:ring-sky-400 dark:hover:text-sky-400" href={`/workspace/${dataset.id}`} aria-label={`Open ${dataset.name} workspace`}>{dataset.name}</Link></h3>
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
                      {modalities.length ? modalities.map(({ modality, count }) => <span key={modality} className="text-[10px] text-zinc-500 dark:text-zinc-400"><span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">{count.toLocaleString()}</span> {modality.toLowerCase()}</span>) : <span className="text-[10px] text-zinc-400">No assets yet</span>}
                    </div>
                  </div>
                  <div className="col-start-1 row-start-3 self-center xl:col-auto xl:row-auto"><Badge className="gap-1.5 whitespace-nowrap" variant={workflowStatus === "IN_PROGRESS" ? "warning" : "success"}><span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{datasetStatusLabels[workflowStatus]}</Badge></div>
                  <div className="col-start-2 row-start-3 flex items-center justify-end gap-2 sm:row-start-1 xl:col-auto xl:row-auto">
                    {canManage ? <DatasetRowActions datasetId={dataset.id} datasetName={dataset.name} workflowStatus={workflowStatus} /> : null}
                    <Button asChild variant="icon" aria-label={`Open ${dataset.name}`}><Link href={`/workspace/${dataset.id}`}><ArrowRight aria-hidden="true" size={17} /></Link></Button>
                  </div>
                </article>;
              })}
            </div>
          </section>
        )}
        {datasets.length > 0 ? <nav aria-label="Dataset pages" className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Showing <span className="font-medium text-zinc-800 dark:text-zinc-200">{datasets.length}</span> of {matchingCount.toLocaleString()} {filtered ? "matching" : "accessible"} datasets</p>
          <div className="flex items-center gap-2">
            {hasPrevious && datasets[0] ? <Button asChild variant="secondary" size="sm"><Link href={datasetLibraryHref(query, { before: datasets[0].id })}><ArrowLeft aria-hidden="true" size={13} />Previous</Link></Button> : <Button disabled variant="secondary" size="sm"><ArrowLeft aria-hidden="true" size={13} />Previous</Button>}
            {hasNext && datasets.at(-1) ? <Button asChild variant="secondary" size="sm"><Link href={datasetLibraryHref(query, { after: datasets.at(-1)!.id })}>Next<ArrowRight aria-hidden="true" size={13} /></Link></Button> : <Button disabled variant="secondary" size="sm">Next<ArrowRight aria-hidden="true" size={13} /></Button>}
          </div>
        </nav> : null}
      </div>
    </AppShell>
  );
}

function DatasetSetupState({ unavailable = false }: { unavailable?: boolean }) {
  return <AppShell currentPath="/datasets"><div className="grid min-h-[calc(100dvh-64px)] place-items-center px-4 py-8"><div className="max-w-md text-center">
    {unavailable ? <WarningCircle aria-hidden="true" className="mx-auto text-rose-600" size={30} weight="duotone" /> : <Database aria-hidden="true" className="mx-auto text-sky-600" size={30} weight="duotone" />}
    <h1 className="mt-4 text-xl font-bold text-zinc-950 dark:text-zinc-50">{unavailable ? "Datasets are unavailable" : "Dataset setup required"}</h1>
    <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">{unavailable ? "We couldn’t load your datasets. Please try again shortly." : "Ask your administrator to finish setting up the dataset library."}</p>
    <Button asChild variant="secondary" className="mt-5"><Link href="/datasets">Try again</Link></Button>
  </div></div></AppShell>;
}
