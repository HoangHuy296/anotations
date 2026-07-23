import { Database, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { DatasetSidebar } from "@/components/workspace/dataset-sidebar";
import { PropertiesPanel } from "@/components/workspace/properties-panel";
import { WorkspaceEngine } from "@/components/workspace/workspace-engine";
import { WorkspaceHeader } from "@/components/workspace/workspace-header";
import { getRequestActor } from "@/lib/auth";
import { isDatabaseConfigured } from "@/lib/db";
import { datasetIdSchema } from "@/lib/validation/dataset";
import { workspaceListQuerySchema } from "@/lib/validation/image-workspace";
import { readImageWorkspaceAsset, readImageWorkspacePage } from "@/lib/workspace/image-workspace";

export const metadata: Metadata = { title: "Annotation Workspace" };

type SearchParams = { q?: string | string[]; status?: string | string[]; image?: string | string[]; page?: string | string[] };
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
const values = (value: string | string[] | undefined) => Array.isArray(value) ? value : value ? [value] : [];

export default async function WorkspacePage({ params, searchParams }: { params: Promise<{ datasetId: string }>; searchParams: Promise<SearchParams> }) {
  await connection();
  const { datasetId } = await params;
  if (!datasetIdSchema.safeParse(datasetId).success) notFound();
  if (!isDatabaseConfigured()) return <WorkspaceSetupState />;
  const actor = await getRequestActor();
  if (!actor) notFound();
  const query = await searchParams;
  const parsedQuery = workspaceListQuerySchema.safeParse({
    page: first(query.page),
    q: first(query.q),
    statuses: values(query.status),
    image: first(query.image),
  });
  const listQuery = parsedQuery.success ? parsedQuery.data : { page: 1, q: "", statuses: [], image: undefined };
  const workspace = await readImageWorkspacePage(actor, datasetId, { page: listQuery.page, search: listQuery.q, statuses: listQuery.statuses, selectedAssetId: listQuery.image });
  if (!workspace) notFound();
  const selectedAssetId = workspace.page.selectedAssetId;
  const selectedAsset = workspace.page.items.find((item) => item.id === selectedAssetId) ?? null;
  const selected = selectedAsset?.modality === "IMAGE" ? await readImageWorkspaceAsset(actor, datasetId, selectedAsset.id) : null;
  return <div className="flex min-h-[100dvh] flex-col bg-zinc-100">
    <WorkspaceHeader datasetName={workspace.dataset.name} branch="image workspace" repositoryFullName="Dataset storage" rootPath="" />
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)_280px] lg:grid-rows-[calc(100dvh-64px)]">
      <DatasetSidebar datasetId={datasetId} datasetName={workspace.dataset.name} selectedAssetId={selectedAssetId} search={listQuery.q} statuses={listQuery.statuses} page={workspace.page.page} previous={workspace.page.previous} next={workspace.page.next} />
      <WorkspaceEngine datasetId={datasetId} asset={selectedAsset} image={selected?.asset ?? null} annotations={selected?.annotations ?? []} labels={selected?.labels ?? []} />
      <PropertiesPanel datasetId={datasetId} image={selected?.asset ?? null} labels={selected?.labels ?? []} images={workspace.page.items} page={workspace.page.page} pageSize={workspace.page.pageSize} totalAssets={workspace.page.total} completedAssets={workspace.page.completed} search={listQuery.q} statuses={listQuery.statuses} selectedAssetId={selectedAssetId} />
    </div>
  </div>;
}

function WorkspaceSetupState({ unavailable = false }: { unavailable?: boolean }) {
  return <main className="grid min-h-[100dvh] place-items-center bg-zinc-50 px-4 py-10"><div className="max-w-md rounded-2xl border border-zinc-200 bg-white p-7 text-center">{unavailable ? <WarningCircle aria-hidden="true" className="mx-auto text-rose-600" size={30} weight="duotone" /> : <Database aria-hidden="true" className="mx-auto text-sky-600" size={30} weight="duotone" />}<h1 className="mt-4 text-xl font-bold text-zinc-950">{unavailable ? "Database unavailable" : "Database setup required"}</h1><p className="mt-2 text-sm leading-6 text-zinc-500">Configure database access and import an image before opening the annotation workspace.</p></div></main>;
}
