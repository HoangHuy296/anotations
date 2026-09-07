import { redirect, notFound } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { DatasetDescriptionEditor } from "@/components/datasets/dataset-description-editor";
import { DatasetMembersPanel } from "@/components/datasets/dataset-members-panel";
import { getRequestActor } from "@/lib/auth";
import { requireDatasetCollaborationManager, requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { assetMetadataSelect } from "@/lib/dataset-metadata";
import { readDatasetOverview } from "@/lib/datasets/dataset-overview-service";
import { listDatasetInvitations, listDatasetMembers } from "@/lib/collaboration/dataset-membership-service";

export default async function DatasetDetailPage({ params }: { params: Promise<{ datasetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) redirect("/unauthorized");
  const { datasetId } = await params;
  const overviewResult = await readDatasetOverview(actor, datasetId);
  if (!overviewResult.ok && overviewResult.status === 403) redirect("/unauthorized");
  if (!overviewResult.ok) notFound();
  const { overview } = overviewResult;
  // A second, narrower permission check purely to decide whether to render
  // the description-edit affordance -- `dataset.read` (already granted
  // above) is not `dataset.update`; MANAGER/OWNER only.
  const canEdit = !(await requireDatasetPermission(actor, datasetId, "dataset.update"))?.forbidden;
  const collaborationAccess = await requireDatasetCollaborationManager(actor, datasetId);
  const canManageCollaborators = Boolean(collaborationAccess && !collaborationAccess.forbidden);
  const [initialMembers, initialInvitations] = await Promise.all([
    listDatasetMembers(actor, datasetId),
    canManageCollaborators ? listDatasetInvitations(actor, datasetId) : Promise.resolve([]),
  ]);
  const assets = await db.asset.findMany({ where: { datasetId, deletedAt: null }, select: assetMetadataSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 25 });

  return (
    <AppShell currentPath="/datasets">
      <main className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-3xl font-bold tracking-[-0.04em] text-zinc-950">{overview.dataset.name}</h1><Button asChild><Link href={`/workspace/${datasetId}`}>Open workspace</Link></Button></div>
        {canEdit
          ? <DatasetDescriptionEditor datasetId={datasetId} description={overview.dataset.description} />
          : overview.dataset.description ? <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-500">{overview.dataset.description}</p> : null}

        <dl className="mt-8 grid max-w-xl gap-4 rounded-2xl border border-zinc-200 p-5 text-sm sm:grid-cols-2">
          <div><dt className="text-zinc-500">Primary modality</dt><dd className="mt-1 font-medium text-zinc-950">{overview.dataset.primaryModality ?? "Not set"}</dd></div>
          <div><dt className="text-zinc-500">Source mode</dt><dd className="mt-1 font-medium text-zinc-950">{overview.dataset.sourceMode}</dd></div>
          <div><dt className="text-zinc-500">Created</dt><dd className="mt-1 font-medium text-zinc-950">{new Date(overview.dataset.createdAt).toLocaleDateString()}</dd></div>
          <div><dt className="text-zinc-500">Updated</dt><dd className="mt-1 font-medium text-zinc-950">{new Date(overview.dataset.updatedAt).toLocaleDateString()}</dd></div>
        </dl>

        <section className="mt-8 max-w-3xl">
          <h2 className="text-lg font-bold text-zinc-950">Overview</h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <StatTile label="Assets" value={overview.assetCounts.total.toLocaleString()} />
            <StatTile label="Annotations" value={overview.annotationCount.toLocaleString()} />
            <StatTile label="Asset progress" value={`${overview.progress.totalAssets ? Math.round((overview.progress.completedAssets / overview.progress.totalAssets) * 100) : 0}%`} sub={`${overview.progress.completedAssets.toLocaleString()} / ${overview.progress.totalAssets.toLocaleString()}`} />
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${overview.progress.totalAssets ? Math.round((overview.progress.completedAssets / overview.progress.totalAssets) * 100) : 0}%` }} /></div>

          <h3 className="mt-6 text-sm font-bold text-zinc-950">Modality breakdown</h3>
          <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(["IMAGE", "VIDEO", "AUDIO", "TEXT"] as const).map((modality) => <div key={modality} className="rounded-xl border border-zinc-200 p-3"><dt className="text-[11px] uppercase tracking-wide text-zinc-400">{modality}</dt><dd className="mt-1 text-lg font-bold text-zinc-950">{overview.assetCounts.byModality[modality].toLocaleString()}</dd></div>)}
          </dl>
        </section>

        <DatasetMembersPanel datasetId={datasetId} canManage={canManageCollaborators} initialMembers={initialMembers} initialInvitations={initialInvitations} />

        <section className="mt-8 max-w-3xl">
          <h2 className="text-lg font-bold text-zinc-950">Dataset health</h2>
          <p className="mt-1 text-xs text-zinc-500">Data integrity and operational signals only -- not an annotation quality score.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <HealthRow label="Missing storage references" count={overview.health.missingStorageReferences} />
            <HealthRow label="Sync conflicts" count={overview.health.syncConflicts} />
            <HealthRow label="Failed background jobs (30d)" count={overview.health.failedJobs} />
            <HealthRow label="Incomplete imports" count={overview.health.incompleteImports} />
          </div>
        </section>

        <section className="mt-8 max-w-3xl">
          <h2 className="text-lg font-bold text-zinc-950">Assets</h2>
          {assets.length === 0 ? <p className="mt-2 text-sm text-zinc-500">No asset metadata is available yet.</p> : <ul className="mt-3 divide-y rounded-2xl border border-zinc-200">{assets.map((asset) => <li key={asset.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm"><span className="truncate font-medium text-zinc-900">{asset.filename}</span><span className="shrink-0 text-zinc-500">{asset.status}</span></li>)}</ul>}
        </section>
      </main>
    </AppShell>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="rounded-2xl border border-zinc-200 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{label}</p><p className="mt-1 text-2xl font-bold text-zinc-950">{value}</p>{sub && <p className="text-xs text-zinc-500">{sub}</p>}</div>;
}

function HealthRow({ label, count }: { label: string; count: number }) {
  const healthy = count === 0;
  return <div className={`flex items-center justify-between rounded-xl border px-3 py-2 text-sm ${healthy ? "border-zinc-200" : "border-amber-200 bg-amber-50"}`}>
    <span className={healthy ? "text-zinc-700" : "text-amber-900"}>{label}</span>
    <Badge variant={healthy ? "success" : "warning"}>{healthy ? "OK" : count.toLocaleString()}</Badge>
  </div>;
}
