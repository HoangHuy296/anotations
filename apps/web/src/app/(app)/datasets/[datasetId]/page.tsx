import { UserRole } from "@internal/db";
import { redirect, notFound } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { getRequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { datasetMetadataSelect } from "@/lib/dataset-metadata";
import { assetMetadataSelect } from "@/lib/dataset-metadata";

export default async function DatasetDetailPage({ params }: { params: Promise<{ datasetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) redirect("/unauthorized");
  const { datasetId } = await params;
  const access = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!access) notFound();
  if (access.forbidden) redirect("/unauthorized");
  const dataset = await db.dataset.findFirst({ where: { id: datasetId, deletedAt: null, archivedAt: null, ...(actor.role === UserRole.ADMIN ? {} : { OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }] }) }, select: datasetMetadataSelect });
  if (!dataset) notFound();
  const assets = await db.asset.findMany({ where: { datasetId, deletedAt: null }, select: assetMetadataSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 25 });
  return (
    <AppShell currentPath="/datasets">
      <main className="px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <Badge variant="info">{dataset.type}</Badge>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><h1 className="text-3xl font-bold tracking-[-0.04em] text-zinc-950">{dataset.name}</h1><Button asChild><Link href={`/workspace/${datasetId}`}>Open workspace</Link></Button></div>
        {dataset.description ? <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-500">{dataset.description}</p> : null}
        <dl className="mt-8 grid max-w-xl gap-4 rounded-2xl border border-zinc-200 p-5 text-sm sm:grid-cols-2">
          <div><dt className="text-zinc-500">Primary modality</dt><dd className="mt-1 font-medium text-zinc-950">{dataset.primaryModality ?? "Not set"}</dd></div>
          <div><dt className="text-zinc-500">Source mode</dt><dd className="mt-1 font-medium text-zinc-950">{dataset.sourceMode}</dd></div>
        </dl>
        <section className="mt-8 max-w-3xl">
          <h2 className="text-lg font-bold text-zinc-950">Assets</h2>
          {assets.length === 0 ? <p className="mt-2 text-sm text-zinc-500">No asset metadata is available yet.</p> : <ul className="mt-3 divide-y rounded-2xl border border-zinc-200">{assets.map((asset) => <li key={asset.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm"><span className="truncate font-medium text-zinc-900">{asset.filename}</span><span className="shrink-0 text-zinc-500">{asset.status}</span></li>)}</ul>}
        </section>
      </main>
    </AppShell>
  );
}
