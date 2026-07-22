import {
  ArrowRight,
  Database,
  GitBranch,
  Images,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";
import { AssetStatus } from "@internal/db";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { AppShell } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { db, isDatabaseConfigured } from "@/lib/db";
import { getRequestActor } from "@/lib/auth";

type DatasetSummary = {
  id: string;
  name: string;
  sourceRootPath: string | null;
  sourceBranch: string | null;
  externalRepository: { fullName: string } | null;
  _count: { assets: number };
};

type DatasetStatusCount = {
  datasetId: string;
  status: AssetStatus;
  _count: { _all: number };
};

export default async function DatasetsPage() {
  await connection();

  const actor = await getRequestActor();
  if (!actor) redirect("/unauthorized");

  if (!isDatabaseConfigured()) {
    return <DatasetSetupState />;
  }

  let data;
  try {
    const [datasets, statusCounts] = await Promise.all([
      db.dataset.findMany({
        where: { deletedAt: null, archivedAt: null, OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }] },
        orderBy: { updatedAt: "desc" },
        include: {
          externalRepository: {
            select: { fullName: true },
          },
          _count: {
            select: { assets: true },
          },
        },
      }),
      db.asset.groupBy({
        by: ["datasetId", "status"],
        where: { modality: "IMAGE", dataset: { OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }] } },
        _count: { _all: true },
      }),
    ]);
    data = {
      datasets: datasets as DatasetSummary[],
      statusCounts: statusCounts as DatasetStatusCount[],
    };
  } catch (error: unknown) {
    console.error("Datasets could not be loaded.", error);
    return <DatasetSetupState unavailable />;
  }
  const { datasets, statusCounts } = data;

  return (
    <AppShell currentPath="/datasets">
      <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <header className="flex flex-wrap items-end justify-between gap-5 border-b border-zinc-200 pb-7">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-sky-700">
              Repository-backed data
            </p>
            <h1 className="mt-3 text-3xl font-bold tracking-[-0.04em] text-zinc-950">
              Datasets
            </h1>
            <p className="mt-2 text-sm leading-6 text-zinc-500">
              Imported folders retain their repository, branch, path, and file
              SHA provenance.
            </p>
          </div>
          <Button asChild>
            <Link href="/imports">Import dataset</Link>
          </Button>
        </header>

        {datasets.length === 0 ? (
          <div className="mt-7 grid min-h-96 place-items-center rounded-2xl border border-dashed border-zinc-300 bg-zinc-50">
            <div className="max-w-sm px-6 text-center">
              <Database
                aria-hidden="true"
                className="mx-auto text-sky-600"
                size={30}
                weight="duotone"
              />
              <h2 className="mt-4 text-lg font-bold text-zinc-950">
                No datasets imported
              </h2>
              <p className="mt-2 text-sm leading-6 text-zinc-500">
                Preview a repository folder, then persist its supported image
                files from the imports page.
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-7 divide-y divide-zinc-200 overflow-hidden rounded-2xl border border-zinc-200 bg-white">
            {datasets.map((dataset) => {
              const total = dataset._count.assets;
              const completed = statusCounts
                .filter(
                  (count) =>
                    count.datasetId === dataset.id &&
                    count.status !== AssetStatus.NEW,
                )
                .reduce((sum, count) => sum + count._count._all, 0);
              const progress =
                total === 0
                  ? 0
                  : Math.round((completed / total) * 1000) / 10;

              return (
                <article
                  key={dataset.id}
                  className="grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_minmax(180px,0.55fr)_auto] md:items-center lg:p-6"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-3">
                      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-zinc-100 text-zinc-600">
                        <Database
                          aria-hidden="true"
                          size={19}
                          weight="duotone"
                        />
                      </span>
                      <div className="min-w-0">
                        <h2 className="truncate text-sm font-bold text-zinc-950">
                          <Link className="rounded-sm outline-none hover:text-sky-700 focus-visible:ring-2 focus-visible:ring-sky-400" href={`/workspace/${dataset.id}`} aria-label={`Open ${dataset.name} workspace`}>
                            {dataset.name}
                          </Link>
                        </h2>
                        <p className="mt-1 truncate font-mono text-[10px] text-zinc-400">
                          {dataset.externalRepository?.fullName ?? "Local dataset"}
                          {dataset.sourceRootPath ? ` / ${dataset.sourceRootPath}` : ""}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between text-xs">
                      <span className="flex items-center gap-1.5 text-zinc-500">
                        <Images aria-hidden="true" size={14} />
                        {total} images
                      </span>
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
                    <Badge variant="info">
                      <GitBranch aria-hidden="true" size={12} />
                      {dataset.sourceBranch ?? "local"}
                    </Badge>
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
        )}
      </div>
    </AppShell>
  );
}

function DatasetSetupState({ unavailable = false }: { unavailable?: boolean }) {
  return (
    <AppShell currentPath="/datasets">
      <div className="grid min-h-[calc(100dvh-64px)] place-items-center px-4 py-8">
        <div className="max-w-md text-center">
          {unavailable ? (
            <WarningCircle
              aria-hidden="true"
              className="mx-auto text-rose-600"
              size={30}
              weight="duotone"
            />
          ) : (
            <Database
              aria-hidden="true"
              className="mx-auto text-sky-600"
              size={30}
              weight="duotone"
            />
          )}
          <h1 className="mt-4 text-xl font-bold text-zinc-950">
            {unavailable ? "Database unavailable" : "Database setup required"}
          </h1>
          <p className="mt-2 text-sm leading-6 text-zinc-500">
            Configure DATABASE_URL and apply the Prisma migration to manage
            imported datasets.
          </p>
        </div>
      </div>
    </AppShell>
  );
}
