import { Database, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { DatasetModalityError } from "@annotationplatform/domain";

import { DatasetSidebar } from "@/components/workspace/dataset-sidebar";
import { PropertiesPanel } from "@/components/workspace/properties-panel";
import { WorkspaceEngine } from "@/components/workspace/workspace-engine";
import { WorkspaceHeader } from "@/components/workspace/workspace-header";
import { getRequestActor } from "@/lib/auth";
import { isDatabaseConfigured } from "@/lib/db";
import { readDatasetModality } from "@/lib/datasets/modality";
import { datasetIdSchema } from "@/lib/validation/dataset";
import { workspaceListQuerySchema } from "@/lib/validation/image-workspace";
import { readSafeDiscussionCommentId, readWorkspacePage, readWorkspaceSelection, readWorkspaceWorkflow } from "@/lib/workspace/workspace-read";

export const metadata: Metadata = { title: "Annotation Workspace" };

type SearchParams = {
  q?: string | string[]; status?: string | string[]; image?: string | string[]; video?: string | string[]; audio?: string | string[]; text?: string | string[]; page?: string | string[];
  filterModality?: string | string[]; labelId?: string | string[]; assignedToId?: string | string[];
  createdFrom?: string | string[]; createdTo?: string | string[]; updatedFrom?: string | string[]; updatedTo?: string | string[];
  sort?: string | string[]; order?: string | string[];
  discussion?: string | string[];
};
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
const values = (value: string | string[] | undefined) => Array.isArray(value) ? value : value ? [value] : [];

export default async function WorkspacePage({ params, searchParams }: { params: Promise<{ datasetId: string }>; searchParams: Promise<SearchParams> }) {
  await connection();
  const { datasetId } = await params;
  if (!datasetIdSchema.safeParse(datasetId).success) notFound();
  if (!isDatabaseConfigured()) return <WorkspaceSetupState />;
  const actor = await getRequestActor();
  if (!actor) notFound();
  const dataset = await readDatasetModality(actor, datasetId);
  if (!dataset) notFound();
  if (dataset.modality === null) return <div key={dataset.id} className="flex min-h-100dvh flex-col bg-zinc-100">
    <WorkspaceHeader datasetName={dataset.name} branch="Unresolved dataset" repositoryFullName="Dataset storage" rootPath="" engine={null} actor={{ email: actor.email, name: actor.name }} />
    <WorkspaceEngine dataset={dataset} selection={null} />
  </div>;
  const query = await searchParams;
  const image = first(query.image)|| undefined;
  const video = first(query.video)|| undefined;
  const audio = first(query.audio)|| undefined;
  const text = first(query.text)|| undefined;
  const discussionCommentId = first(query.discussion) || undefined;
  // Legacy navigation keys identify content only. They cannot choose an engine.
  const requestedIds = [...new Set([image, video, audio, text].filter((id): id is string => Boolean(id)))];
  if (requestedIds.length > 1) notFound();
  const requestedId = requestedIds[0];
  let requestedSelection = null;
  if (requestedId) {
    if (!workspaceListQuerySchema.shape.asset.safeParse(requestedId).success) notFound();
    try { requestedSelection = await readWorkspaceSelection(actor, datasetId, requestedId); }
    catch (error) { if (error instanceof DatasetModalityError) return <WorkspaceIntegrityState />; throw error; }
    if (!requestedSelection) notFound();
  }
  const parsedQuery = workspaceListQuerySchema.safeParse({
    page: first(query.page),
    q: first(query.q),
    statuses: values(query.status),
    asset: requestedId,
    modality: requestedId ? dataset.modality : undefined,
    filterModality: first(query.filterModality),
    labelId: values(query.labelId),
    assignedToId: first(query.assignedToId),
    createdFrom: first(query.createdFrom),
    createdTo: first(query.createdTo),
    updatedFrom: first(query.updatedFrom),
    updatedTo: first(query.updatedTo),
    sort: first(query.sort),
    order: first(query.order),
  });
  const listQuery = parsedQuery.success ? parsedQuery.data : {
    page: 1, q: "", statuses: [], asset: undefined, modality: undefined,
    filterModality: undefined, labelId: [], assignedToId: undefined,
    createdFrom: undefined, createdTo: undefined, updatedFrom: undefined, updatedTo: undefined,
    sort: undefined, order: "desc" as const,
  };
  const selectedAsset = requestedId ? { id: requestedId, modality: dataset.modality } : undefined;
  const workspace = await readWorkspacePage(actor, datasetId, {
    page: listQuery.page,
    search: listQuery.q,
    statuses: listQuery.statuses,
    selectedAsset,
    modality: listQuery.filterModality,
    labelId: listQuery.labelId,
    assignedToId: listQuery.assignedToId,
    createdFrom: listQuery.createdFrom,
    createdTo: listQuery.createdTo,
    updatedFrom: listQuery.updatedFrom,
    updatedTo: listQuery.updatedTo,
    sort: listQuery.sort,
    order: listQuery.order,
  });
  if (!workspace) notFound();
  if (workspace.dataset.modality === null) return <WorkspaceEngine dataset={workspace.dataset} selection={null} />;
  const selectedAssetId = workspace.page.selectedAsset?.id ?? null;
  const safeDiscussionCommentId = selectedAssetId ? await readSafeDiscussionCommentId(actor, datasetId, selectedAssetId, discussionCommentId) : null;
  let selected = null;
  try { selected = selectedAssetId ? selectedAssetId === requestedId ? requestedSelection : await readWorkspaceSelection(actor, datasetId, selectedAssetId) : null; }
  catch (error) { if (error instanceof DatasetModalityError) return <WorkspaceIntegrityState />; throw error; }
  if (selectedAssetId && !selected) notFound();
  const engine = workspace.dataset.modality;
  const workflow = selectedAssetId ? await readWorkspaceWorkflow(actor, datasetId, selectedAssetId) : null;
  const filters = {
    filterModality: listQuery.filterModality, labelId: listQuery.labelId,
    createdFrom: listQuery.createdFrom, createdTo: listQuery.createdTo,
    updatedFrom: listQuery.updatedFrom, updatedTo: listQuery.updatedTo,
    sort: listQuery.sort, order: listQuery.order,
  };
  return <div key={datasetId} className="flex min-h-100dvh flex-col bg-zinc-100">
    <WorkspaceHeader key={datasetId} datasetName={workspace.dataset.name} branch={`${engine.toLowerCase()} workspace`} repositoryFullName="Dataset storage" rootPath="" engine={engine} actor={{ email: actor.email, name: actor.name }} workflow={workflow} discussion={{ datasetId, assetId: selectedAssetId, commentId: safeDiscussionCommentId }} />
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)_280px] lg:grid-rows-[calc(100dvh-64px)]">
      <DatasetSidebar key={datasetId} datasetId={datasetId} datasetName={workspace.dataset.name} selectedAssetId={selectedAssetId} search={listQuery.q} statuses={listQuery.statuses} page={workspace.page.page} previous={workspace.page.previous} next={workspace.page.next} engine={engine} filters={filters} />
      <WorkspaceEngine dataset={workspace.dataset} selection={selected} />
      <PropertiesPanel key={datasetId} datasetId={datasetId} engine={engine} selection={selected} assets={workspace.page.items} page={workspace.page.page} pageSize={workspace.page.pageSize} totalAssets={workspace.page.total} completedAssets={workspace.page.completed} search={listQuery.q} statuses={listQuery.statuses} selectedAssetId={selectedAssetId} filters={filters} />
    </div>
  </div>;
}

function WorkspaceSetupState({ unavailable = false }: { unavailable?: boolean }) {
  return <main className="grid min-h-100dvh place-items-center bg-zinc-50 px-4 py-10"><div className="max-w-md rounded-2xl border border-zinc-200 bg-white p-7 text-center">{unavailable ? <WarningCircle aria-hidden="true" className="mx-auto text-rose-600" size={30} weight="duotone" /> : <Database aria-hidden="true" className="mx-auto text-sky-600" size={30} weight="duotone" />}<h1 className="mt-4 text-xl font-bold text-zinc-950">{unavailable ? "Database unavailable" : "Database setup required"}</h1><p className="mt-2 text-sm leading-6 text-zinc-500">Configure database access before opening the annotation workspace.</p></div></main>;
}

function WorkspaceIntegrityState() {
  return <main role="alert" className="grid min-h-100dvh place-items-center bg-zinc-50 px-4"><div className="max-w-md text-center"><h1 className="text-xl font-bold">Workspace unavailable</h1><p className="mt-2 text-sm text-zinc-600">Dataset state or selected content could not be verified. Refresh the workspace.</p></div></main>;
}
