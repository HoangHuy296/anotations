import { LockKey, Tag, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { connection } from "next/server";

import { AppShell } from "@/components/layout/app-shell";
import { DeleteLabelButton } from "@/components/labels/delete-label-button";
import { LabelForm } from "@/components/labels/label-form";
import { Badge } from "@/components/ui/badge";
import { getRequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db, isDatabaseConfigured } from "@/lib/db";
import { listLabelLibraryDatasets, pickLabelLibraryDataset, shouldBackfillDefaultImageLabels, type LabelLibraryDataset } from "@/lib/labels/label-library";
import { seedDefaultImageLabelsIfEmpty } from "@/lib/workspace/label-management";

type LabelSummary = {
  id: string;
  datasetId: string;
  name: string;
  color: string;
  description: string | null;
  hotkey: string | null;
  modality: "IMAGE" | "VIDEO" | "TEXT" | "AUDIO" | null;
  scope: string;
  _count: { annotations: number };
};

const TEXT_ELIGIBLE_SCOPES = new Set(["ENTITY", "CLASSIFICATION", "SENTIMENT", "INTENT", "RELATION"]);
function textEligibilityBadge(label: Pick<LabelSummary, "modality" | "scope">) {
  if ((label.modality !== null && label.modality !== "TEXT") || !TEXT_ELIGIBLE_SCOPES.has(label.scope)) return null;
  return label.scope;
}

export default async function LabelsPage({ searchParams }: { searchParams: Promise<{ dataset?: string | string[] }> }) {
  await connection();

  const requested = (await searchParams).dataset;
  const data = await loadLabelPageData(Array.isArray(requested) ? requested[0] : requested);

  if (!data) {
    return (
      <AppShell currentPath="/labels">
        <div className="grid min-h-[calc(100dvh-64px)] place-items-center px-4 py-8">
          <div className="max-w-md rounded-2xl border border-rose-200 bg-rose-50 p-6 text-center dark:border-rose-900 dark:bg-rose-950/40">
            <WarningCircle
              aria-hidden="true"
              className="mx-auto text-rose-700 dark:text-rose-400"
              size={30}
              weight="duotone"
            />
            <h1 className="mt-4 text-xl font-bold text-zinc-950 dark:text-zinc-50">
              Database unavailable
            </h1>
            <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
              Configure DATABASE_URL, apply the Prisma migration, and seed the
              initial labels before opening this page.
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  const { labels, actor, dataset, datasets, canManage } = data;

  return (
    <AppShell currentPath="/labels">
      <div className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <header className="flex flex-wrap items-end justify-between gap-5 border-b border-zinc-200 pb-7 dark:border-zinc-800">
          <div>
            <div className="flex items-center gap-2 text-sky-700 dark:text-sky-400">
              <Tag aria-hidden="true" size={18} weight="duotone" />
              <span className="text-xs font-bold uppercase tracking-[0.14em]">
                Taxonomy
              </span>
            </div>
            <h1 className="mt-3 text-3xl font-bold tracking-[-0.04em] text-zinc-950 dark:text-zinc-50">
              Label library
            </h1>
            <p className="mt-2 max-w-[62ch] text-sm leading-6 text-zinc-500 dark:text-zinc-400">
              Keep annotation categories concise, distinguishable, and easy to
              reach from the keyboard.
            </p>
          </div>
          <Badge variant={canManage ? "success" : "neutral"}>
            {canManage ? `${actor?.role} access` : "Read only"}
          </Badge>
        </header>

        {!canManage && (
          <div className="mt-6 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <LockKey
              aria-hidden="true"
              className="mt-0.5 shrink-0 dark:text-amber-400"
              size={18}
              weight="duotone"
            />
            <div>
              <p className="text-sm font-semibold">
                Label mutations are protected.
              </p>
              <p className="mt-1 text-xs leading-5 text-amber-800 dark:text-amber-300">
                Sign in as a reviewer or administrator. During development,
                configure a seeded user with DEV_AUTH_EMAIL.
              </p>
            </div>
          </div>
        )}

        {datasets.length > 0 && (
          <nav aria-label="Your datasets" className="mt-6">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-400">Your taxonomies</p>
            <ul className="mt-3 flex flex-wrap gap-2">
              {datasets.map((item) => {
                const selected = item.id === dataset?.id;
                return (
                  <li key={item.id}>
                    <Link
                      href={`/labels?dataset=${item.id}`}
                      aria-current={selected ? "page" : undefined}
                      className={`inline-flex max-w-[18rem] items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-sky-500 ${selected ? "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-200" : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
                    >
                      <span className="truncate">{item.name}</span>
                      <Badge variant="neutral" className="shrink-0">{item.modality ?? "Unresolved"}</Badge>
                      <span className="shrink-0 font-normal text-zinc-500 dark:text-zinc-400">{item.labelCount} · {item.owned ? "Yours" : "Shared"}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}

        <div className="mt-7 grid items-start gap-7 xl:grid-cols-[minmax(300px,0.72fr)_minmax(0,1.28fr)]">
          <section className="rounded-2xl border border-zinc-200 bg-zinc-50 p-5 lg:p-6 dark:border-zinc-800 dark:bg-zinc-900/60">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-400">
              New label
            </p>
            <h2 className="mt-2 text-lg font-bold tracking-[-0.02em] text-zinc-950 dark:text-zinc-50">
              Add a category
            </h2>
            <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              Names and hotkeys are unique across the workspace.
            </p>
            <div className="mt-6">
              {dataset ? (
                <LabelForm mode="create" canManage={canManage} datasetId={dataset.id} />
              ) : (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">Create a dataset before adding labels.</p>
              )}
            </div>
          </section>

          <section>
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-400">
              Current taxonomy
            </p>
            <h2 className="mt-2 text-lg font-bold tracking-[-0.02em] text-zinc-950 dark:text-zinc-50">
              {labels.length} label{labels.length === 1 ? "" : "s"}{dataset ? ` in ${dataset.name}` : ""}
            </h2>

            {labels.length === 0 ? (
              <div className="mt-5 grid min-h-72 place-items-center rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 px-6 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
                <div>
                  <span className="mx-auto grid size-11 place-items-center rounded-2xl bg-white text-zinc-400 shadow-sm dark:bg-zinc-800">
                    <Tag aria-hidden="true" size={23} weight="duotone" />
                  </span>
                  <p className="mt-4 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                    No labels yet
                  </p>
                  <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                    Create the first category or run the database seed.
                  </p>
                </div>
              </div>
            ) : (
              <div className="mt-5 space-y-2">
                {labels.map((label) => (
                  <details
                    key={label.id}
                    className="group rounded-xl border border-zinc-200 bg-white transition-colors open:border-sky-200 open:shadow-[0_12px_32px_-24px_rgba(2,132,199,0.45)] dark:border-zinc-800 dark:bg-zinc-900 dark:open:border-sky-900"
                  >
                    <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3.5 marker:hidden">
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <span
                          className="size-3.5 shrink-0 rounded-md border border-black/10"
                          style={{ backgroundColor: label.color }}
                        />
                        <div className="min-w-0">
                          <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                            {label.name}
                          </h3>
                          <p className="mt-0.5 truncate text-[11px] text-zinc-400 dark:text-zinc-500">
                            {label.description || "No description"}
                            {" · "}
                            {label._count.annotations} annotation
                            {label._count.annotations === 1 ? "" : "s"}
                          </p>
                        </div>
                      </div>
                      {textEligibilityBadge(label) && (
                        <Badge variant="success" className="shrink-0">
                          TEXT · {textEligibilityBadge(label)}
                        </Badge>
                      )}
                      {label.hotkey && (
                        <Badge variant="neutral" className="shrink-0">
                          <span className="font-mono">{label.hotkey}</span>
                        </Badge>
                      )}
                      <span className="shrink-0 text-xs font-semibold text-zinc-400 group-open:text-sky-700 dark:group-open:text-sky-400">
                        Edit
                      </span>
                    </summary>

                    <div className="border-t border-zinc-100 px-4 py-4 dark:border-zinc-800">
                      <LabelForm
                        mode="edit"
                        canManage={canManage}
                        datasetId={label.datasetId}
                        label={label}
                      />

                      <div className="mt-3 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                        <DeleteLabelButton
                          id={label.id}
                          name={label.name}
                          annotationCount={label._count.annotations}
                          canManage={canManage}
                        />
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </AppShell>
  );
}

async function loadLabelPageData(requestedDatasetId: string | undefined) {
  if (!isDatabaseConfigured()) {
    return null;
  }

  try {
    const actor = await getRequestActor();
    if (!actor) return { labels: [], actor: null, dataset: null, datasets: [] as LabelLibraryDataset[], canManage: false };
    const datasets = await listLabelLibraryDatasets(actor.id);
    const dataset = pickLabelLibraryDataset(datasets, requestedDatasetId);
    const access = dataset ? await requireDatasetPermission(actor, dataset.id, "label.manage") : null;
    let labels: LabelSummary[] = dataset
      ? await db.label.findMany({
        where: { datasetId: dataset.id },
        orderBy: [{ name: "asc" }],
        include: {
          _count: {
            select: { annotations: true },
          },
        },
      }) as LabelSummary[]
      : [];

    // Keep the taxonomy consistent for every authorized reader. Defaults are
    // seeded only into a dataset with no labels, so a removed default stays
    // removed and custom labels are preserved.
    if (dataset && shouldBackfillDefaultImageLabels(dataset.modality)) {
      await seedDefaultImageLabelsIfEmpty(actor, dataset.id);
      labels = await db.label.findMany({
        where: { datasetId: dataset.id },
        orderBy: [{ name: "asc" }],
        include: { _count: { select: { annotations: true } } },
      }) as LabelSummary[];
    }
    return { labels, actor, dataset, datasets, canManage: Boolean(access && !access.forbidden) };
  } catch (error: unknown) {
    console.error("Label page data could not be loaded.", error);
    return null;
  }
}
