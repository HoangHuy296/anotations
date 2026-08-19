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
import { readWorkspacePage, readWorkspaceSelection } from "@/lib/workspace/workspace-read";

export const metadata: Metadata = { title: "Annotation Workspace" };

type SearchParams = { q?: string | string[]; status?: string | string[]; image?: string | string[]; video?: string | string[]; audio?: string | string[]; text?: string | string[]; page?: string | string[] };
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
  const image = first(query.image)|| undefined;
  const video = first(query.video)|| undefined;
  const audio = first(query.audio)|| undefined;
  const text = first(query.text)|| undefined;
  const selection = image
    ? { asset: image, modality: "IMAGE" as const }
    : video
      ? { asset: video, modality: "VIDEO" as const }
      : audio
        ? { asset: audio, modality: "AUDIO" as const }
        : text
          ? { asset: text, modality: "TEXT" as const }
          : undefined;
  const parsedQuery = workspaceListQuerySchema.safeParse({
    page: first(query.page),
    q: first(query.q),
    statuses: values(query.status),
    asset: selection?.asset,
    modality: selection?.modality,
  });
  const listQuery = parsedQuery.success ? parsedQuery.data : { page: 1, q: "", statuses: [], asset: undefined, modality: undefined, };
  const selectedAsset = listQuery.asset && listQuery.modality ? {id: listQuery.asset, modality: listQuery.modality,}: undefined;
  const workspace = await readWorkspacePage(actor, datasetId, {
    page: listQuery.page,
    search: listQuery.q,
    statuses: listQuery.statuses,
    selectedAsset,
  });
  if (!workspace) notFound();
  const selectedAssetId = workspace.page.selectedAsset?.id ?? null;
  const selected = selectedAssetId ? await readWorkspaceSelection(actor, datasetId, selectedAssetId) : null;
  return <div className="flex min-h-100dvh flex-col bg-zinc-100">
    <WorkspaceHeader datasetName={workspace.dataset.name} branch="image workspace" repositoryFullName="Dataset storage" rootPath="" engine={selected?.engine ?? null} />
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)_280px] lg:grid-rows-[calc(100dvh-64px)]">
      <DatasetSidebar datasetId={datasetId} datasetName={workspace.dataset.name} selectedAssetId={selectedAssetId} search={listQuery.q} statuses={listQuery.statuses} page={workspace.page.page} previous={workspace.page.previous} next={workspace.page.next} engine={selected?.engine ?? null} />
      <WorkspaceEngine selection={selected} />
      <PropertiesPanel datasetId={datasetId} selection={selected} assets={workspace.page.items} page={workspace.page.page} pageSize={workspace.page.pageSize} totalAssets={workspace.page.total} completedAssets={workspace.page.completed} search={listQuery.q} statuses={listQuery.statuses} selectedAssetId={selectedAssetId} />
    </div>
  </div>;
}

function WorkspaceSetupState({ unavailable = false }: { unavailable?: boolean }) {
  return <main className="grid min-h-100dvh place-items-center bg-zinc-50 px-4 py-10"><div className="max-w-md rounded-2xl border border-zinc-200 bg-white p-7 text-center">{unavailable ? <WarningCircle aria-hidden="true" className="mx-auto text-rose-600" size={30} weight="duotone" /> : <Database aria-hidden="true" className="mx-auto text-sky-600" size={30} weight="duotone" />}<h1 className="mt-4 text-xl font-bold text-zinc-950">{unavailable ? "Database unavailable" : "Database setup required"}</h1><p className="mt-2 text-sm leading-6 text-zinc-500">Configure database access and import an image before opening the annotation workspace.</p></div></main>;
}
