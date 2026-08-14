"use client";

import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import type { AssetStatus } from "@internal/db";

import {
  ensureDefaultImageLabelsAction,
  updateImageDescriptionAction,
} from "@/app/(app)/workspace/[datasetId]/actions";
import { AssetNavigator } from "@/components/workspace/asset-navigator";
import { SaveConflictPanel } from "@/components/workspace/save-conflict-panel";
import { Badge } from "@/components/ui/badge";
import { imageStatusOptions, imageStatusPresentation } from "@/lib/image-status";
import { putAssetAnnotations } from "@/lib/annotations/annotation-api-client";
import { useAnnotationStore } from "@/stores/image-annotation-store";
import { useDatasetLabels, useDatasetLabelsStore, type DatasetLabel } from "@/stores/dataset-labels-store";
import type { SafeImageAnnotation, SafeImageWorkspaceAsset } from "@/types/image-workspace";
import type { SafeWorkspaceAsset } from "@/types/workspace";
import type { WorkspaceSelection } from "@/types/workspace";

type PanelTab = "description" | "labels" | "shapes" | "assets";
export type ImagePropertiesTabsProps = {
  datasetId: string;
  selection: Extract<WorkspaceSelection, { engine: "IMAGE" }>;
  assets: SafeWorkspaceAsset[];
  page: number;
  pageSize: number;
  totalAssets: number;
  completedAssets: number;
  search: string;
  statuses: AssetStatus[];
  selectedAssetId: string | null;
  tab: string;
  setTab: (tab: string) => void;
};

/**
 * IMAGE's `PropertiesPanel` tabs content (Details/Labels/Shapes/Assets).
 * This is the pre-registry `PropertiesPanel` implementation, unchanged in
 * behavior, moved here so `workspace-engine-registry.ts` can reference it as
 * the IMAGE entry's `Tabs` without a circular import back into the shared
 * `PropertiesPanel` shell.
 */
export function ImagePropertiesTabs({ datasetId, selection, assets, page, pageSize, totalAssets, completedAssets, search, statuses, selectedAssetId, tab, setTab }: ImagePropertiesTabsProps) {
  const image: SafeImageWorkspaceAsset = selection.asset;
  const router = useRouter();
  const [description, setDescription] = useState(image.description ?? "");
  const [serverDescription, setServerDescription] = useState(image.description ?? "");
  const [version, setVersion] = useState(image.version ?? 1);
  const [descriptionState, setDescriptionState] = useState<"idle" | "pending" | "saving" | "saved" | "failed" | "conflict">("idle");
  const [conflictDraft, setConflictDraft] = useState<string | null>(null);
  const [shapeError, setShapeError] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [newLabelName, setNewLabelName] = useState("");
  const taxonomy = useDatasetLabels(datasetId);
  const lastAttemptedDescriptionRef = useRef<string | null>(null);
  const annotations = useAnnotationStore((store) => store.persistedAnnotations);
  const selectedId = useAnnotationStore((store) => store.selectedId);
  const setSelectedId = useAnnotationStore((store) => store.setSelectedId);
  const upsertSafeAnnotation = useAnnotationStore((store) => store.upsertSafeAnnotation);
  const removeSafeAnnotation = useAnnotationStore((store) => store.removeSafeAnnotation);
  const scheduleAutosave = useAnnotationStore((store) => store.scheduleAutosave);
  const flushAllAutosaves = useAnnotationStore((store) => store.flushAllAutosaves);
  const setConflictDraftInStore = useAnnotationStore((store) => store.setConflictDraft);

  // `selection.labels` (SSR-projected, still used as-is by `image-engine.tsx`
  // for annotation coloring) seeds this dataset's entry so the Labels tab
  // never flashes empty on first paint -- but `ensureLoaded` still performs
  // its own fetch regardless, so this store stays the single authoritative,
  // always-fresh source rather than trusting a snapshot that may already be
  // stale by the time hydration runs. `useDatasetLabelsStore` is a
  // module-level singleton, so once loaded for `datasetId` this resolves
  // with no network call on every later mount (every asset switch remounts
  // this component via `PropertiesPanel`'s `key`, and switching back from
  // VIDEO does too).
  useEffect(() => { void useDatasetLabelsStore.getState().ensureLoaded(datasetId, selection.labels); }, [datasetId, selection.labels]);

  useEffect(() => {
    if (description === serverDescription || lastAttemptedDescriptionRef.current === description) return;
    const resourceKey = `asset-description:${image.id}`;
    setDescriptionState("pending");
    scheduleAutosave(resourceKey, async () => {
      lastAttemptedDescriptionRef.current = description;
      setDescriptionState("saving");
      const result = await updateImageDescriptionAction({
        datasetId,
        assetId: image.id,
        version,
        description: description.trim() || null,
      });
      if (result.ok) {
        setVersion(result.asset.version);
        setServerDescription(result.asset.description ?? "");
        setDescriptionState("saved");
        return "saved";
      }
      if (result.error === "CONFLICT") {
        setConflictDraft(description);
        setConflictDraftInStore(resourceKey, description);
        setDescriptionState("conflict");
        return "conflict";
      }
      setDescriptionState("failed");
      return "failed";
    });
  }, [datasetId, description, image, scheduleAutosave, serverDescription, setConflictDraftInStore, version]);

  const currentAssetId = image.id;
  const presentation = imageStatusPresentation[image.status];

  function scheduleLabelChange(annotationId: string, labelId: string | null) {
    const annotation = annotations.find((item) => item.id === annotationId);
    if (!annotation) return;
    upsertSafeAnnotation({ ...annotation, labelId });
    scheduleAutosave(`annotation:${annotationId}`, async () => {
      const result = await putAssetAnnotations(currentAssetId, {
        updates: [{ id: annotationId, revision: annotation.revision, labelId }],
      });
      if (result.ok) {
        const updated = result.annotations.find((item) => item.id === annotationId);
        if (updated?.modality === "IMAGE" && ["BOUNDING_BOX", "POLYGON", "CIRCLE", "POINT", "POLYLINE"].includes(updated.type)) {
          upsertSafeAnnotation({ ...updated, modality: "IMAGE", type: updated.type as SafeImageAnnotation["type"], geometry: updated.geometry as SafeImageAnnotation["geometry"] });
        }
        return "saved";
      }
      if (result.conflict) {
        setConflictDraftInStore(`annotation:${annotationId}`, { labelId });
        setShapeError("A newer annotation version exists. Your local label choice is still visible.");
        return "conflict";
      }
      setShapeError("The annotation label could not be changed.");
      return "failed";
    });
  }

  async function deleteShape(annotationId: string) {
    const annotation = annotations.find((item) => item.id === annotationId);
    if (!annotation) return;
    const result = await putAssetAnnotations(currentAssetId, {
      deletes: [{ id: annotationId, revision: annotation.revision }],
    });
    if (result.ok) {
      removeSafeAnnotation(annotationId);
      return;
    }
    setShapeError(result.conflict ? "A newer annotation version exists. Reload before deleting." : "The annotation could not be deleted.");
  }

  async function createCustomLabel() {
    const name = newLabelName.trim();
    if (!name) return;
    setLabelError(null);
    const response = await fetch(`/api/datasets/${datasetId}/labels`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, color: "#0EA5E9", description: "", hotkey: "" }),
    });
    const payload = await response.json().catch(() => null) as { data?: DatasetLabel; error?: { message?: string } } | null;
    if (!response.ok || !payload?.data) {
      setLabelError(payload?.error?.message ?? "The label could not be created.");
      return;
    }
    useDatasetLabelsStore.getState().addLabel(datasetId, payload.data);
    setNewLabelName("");
  }

  async function deleteLabel(labelId: string) {
    setLabelError(null);
    const response = await fetch(`/api/labels/${labelId}`, { method: "DELETE", credentials: "same-origin" });
    if (response.status === 204) {
      useDatasetLabelsStore.getState().removeLabel(datasetId, labelId);
      return;
    }
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    setLabelError(payload?.error?.message ?? "The label could not be deleted.");
  }

  async function addDefaults() {
    setLabelError(null);
    const result = await ensureDefaultImageLabelsAction(datasetId);
    if (!result.ok) {
      setLabelError("You do not have permission to establish default labels.");
      return;
    }
    window.location.reload();
  }

  async function guardImageNavigation(event: MouseEvent<HTMLAnchorElement>, href: string) {
    event.preventDefault();
    if (!(await flushBeforeNavigation())) return;
    router.push(href);
  }

  async function flushBeforeNavigation() {
    await flushAllAutosaves();
    const latestStates = Object.values(useAnnotationStore.getState().saveStates);
    const needsResolution = latestStates.some((state) => state === "failed" || state === "conflict");
    return !needsResolution || window.confirm("An image edit could not be saved or has a conflict. Discard the local draft and leave this image?");
  }

  async function applyAssetFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // React clears currentTarget once the synchronous handler exits. Capture the
    // actual form before awaiting an autosave flush so status clicks/submits
    // cannot hand FormData a non-form target.
    const formElement = event.currentTarget;
    if (!(await flushBeforeNavigation())) return;
    const form = new FormData(formElement);
    const params = new URLSearchParams({ page: "1" });
    const nextSearch = String(form.get("q") ?? "").trim();
    if (nextSearch) params.set("q", nextSearch);
    const nextStatus = String(form.get("status") ?? "ALL");
    if (nextStatus === "MULTIPLE") {
      for (const status of statuses) params.append("status", status);
    } else if (imageStatusOptions.includes(nextStatus as AssetStatus)) {
      params.set("status", nextStatus);
    }
    router.push(`/workspace/${datasetId}?${params.toString()}`);
  }

  // The previous Images-tab UX used one clear status choice plus an explicit
  // “All statuses” reset. Preserve multi-status query compatibility for old
  // links, while rendering that proven, less error-prone control.
  const selectedStatus = statuses.length === 1 ? statuses[0] : statuses.length > 1 ? "MULTIPLE" : "ALL";
  const activeTab = (["description", "labels", "shapes", "assets"] as const).includes(tab as PanelTab) ? (tab as PanelTab) : "description";

  return <aside className="min-h-0 overflow-y-auto border-l border-zinc-200 bg-white">
    <div className="border-b border-zinc-200 p-4">
      <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-bold text-zinc-950">Image details</h2><Badge variant={presentation.variant}>{presentation.label}</Badge></div>
      <p className="mt-3 break-all text-xs font-semibold text-zinc-800">{image.filename}</p>
      <dl className="mt-4 space-y-2 text-xs"><Detail label="Dimensions" value={image.width && image.height ? `${image.width} × ${image.height}` : "Unknown"} /><Detail label="Annotations" value={String(annotations.length)} /><Detail label="Batch" value={String(image.batchIndex + 1)} /></dl>
    </div>
    <nav aria-label="Image management" className="grid grid-cols-4 border-b border-zinc-200">
      {(["description", "labels", "shapes", "assets"] as const).map((entry) => <button key={entry} type="button" onClick={() => setTab(entry)} className={`px-2 py-3 text-xs font-semibold capitalize ${activeTab === entry ? "border-b-2 border-sky-600 text-sky-700" : "text-zinc-500"}`}>{entry}</button>)}
    </nav>
    {activeTab === "description" && <section className="p-4">
      <div className="flex items-center justify-between"><h2 className="text-sm font-bold text-zinc-950">Description</h2><span className="text-[11px] text-zinc-400">{descriptionState === "pending" ? "Saving after inactivity…" : descriptionState === "saving" ? "Saving…" : descriptionState === "saved" ? "Saved" : descriptionState === "failed" ? "Save failed" : ""}</span></div>
      <textarea value={description} onChange={(event) => { lastAttemptedDescriptionRef.current = null; setDescription(event.target.value); }} maxLength={10_000} rows={7} className="mt-3 w-full resize-y rounded-xl border border-zinc-200 p-3 text-sm text-zinc-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100" placeholder="Scene context, notes, or quality flags" />
      {descriptionState === "conflict" && <div className="mt-3"><SaveConflictPanel message="Your description draft is still visible and was not sent again." onReload={() => window.location.reload()} onDiscard={() => { setDescription(serverDescription); setConflictDraft(null); setDescriptionState("idle"); }} /></div>}
      {descriptionState === "failed" && <p role="alert" className="mt-3 text-xs text-rose-700">Description was not saved. Edit it again to retry.</p>}
      {conflictDraft && <p className="sr-only">Local draft preserved.</p>}
    </section>}
    {activeTab === "labels" && <section className="p-4">
      <div className="flex items-center justify-between"><h2 className="text-sm font-bold text-zinc-950">Labels</h2><button type="button" onClick={() => void addDefaults()} className="text-xs font-semibold text-sky-700">Add defaults</button></div>
      <div className="mt-3 flex gap-2"><input aria-label="New label name" value={newLabelName} onChange={(event) => setNewLabelName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createCustomLabel(); } }} className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-2 py-2 text-xs" placeholder="Custom label" /><button type="button" onClick={() => void createCustomLabel()} className="rounded-lg bg-zinc-900 px-3 text-xs font-semibold text-white">Add</button></div>
      <div className="mt-3 space-y-2">{taxonomy.map((label) => <div key={label.id} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-2 py-2"><span aria-hidden="true" className="h-3 w-3 rounded-full" style={{ backgroundColor: label.color }} /><span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-800">{label.name}</span><button type="button" onClick={() => void deleteLabel(label.id)} className="text-[11px] font-semibold text-rose-700">Remove</button></div>)}</div>
      {labelError && <p role="alert" className="mt-3 text-xs text-rose-700">{labelError}</p>}
    </section>}
    {activeTab === "shapes" && <section className="p-4">
      <div className="flex items-center justify-between"><h2 className="text-sm font-bold text-zinc-950">Shapes</h2><span className="text-xs text-zinc-400">{annotations.length}</span></div>
      <div className="mt-3 space-y-2">{annotations.length === 0 ? <p className="text-xs text-zinc-500">No annotations yet.</p> : annotations.map((annotation) => <div key={annotation.id} className={`rounded-xl border p-2 ${annotation.id === selectedId ? "border-sky-300 bg-sky-50" : "border-zinc-200"}`}><button type="button" onClick={() => setSelectedId(annotation.id)} className="w-full text-left text-xs font-semibold text-zinc-800">{annotation.type.replaceAll("_", " ")} · {taxonomy.find((label) => label.id === annotation.labelId)?.name ?? "No label"}</button><div className="mt-2 flex gap-1"><select aria-label={`Label for ${annotation.id}`} value={annotation.labelId ?? ""} onChange={(event) => scheduleLabelChange(annotation.id, event.target.value || null)} className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-[11px]"><option value="">No label</option>{taxonomy.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select><button type="button" onClick={() => void deleteShape(annotation.id)} className="rounded-lg px-2 text-[11px] font-semibold text-rose-700 hover:bg-rose-50">Delete</button></div></div>)}</div>
      {shapeError && <p role="alert" className="mt-3 text-xs text-rose-700">{shapeError}</p>}
    </section>}
    {activeTab === "assets" && <section className="p-4">
      <div className="flex items-center justify-between"><h2 className="text-sm font-bold text-zinc-950">Assets</h2><span className="text-xs text-zinc-400">Page {page}</span></div>
      <p className="mt-1 text-xs text-zinc-500">This workspace page is limited to {pageSize} assets.</p>
      <form method="get" onSubmit={(event) => { void applyAssetFilters(event); }} className="mt-3 space-y-2">
        <label className="sr-only" htmlFor="workspace-asset-search">Search assets</label>
        <input id="workspace-asset-search" name="q" type="search" defaultValue={search} placeholder="Search assets" className="w-full rounded-lg border border-zinc-200 px-2 py-2 text-xs outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100" />
        <div className="flex gap-2">
          <label className="sr-only" htmlFor="workspace-asset-status">Filter by status</label>
          <select id="workspace-asset-status" name="status" defaultValue={selectedStatus} className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-2 py-2 text-xs text-zinc-700">
            <option value="ALL">All statuses</option>
            {statuses.length > 1 && <option value="MULTIPLE">Keep multiple status filters</option>}
            {imageStatusOptions.map((option) => <option key={option} value={option}>{imageStatusPresentation[option].label}</option>)}
          </select>
          <button type="submit" className="rounded-lg bg-zinc-900 px-3 text-xs font-semibold text-white hover:bg-zinc-800">Apply</button>
        </div>
      </form>
      <div className="mt-3" aria-label="Dataset progress"><div className="flex justify-between text-[11px] text-zinc-500"><span>Dataset progress</span><span>{completedAssets} / {totalAssets}</span></div><div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${totalAssets ? Math.round((completedAssets / totalAssets) * 100) : 0}%` }} /></div></div>
      <AssetNavigator datasetId={datasetId} assets={assets} page={page} pageSize={pageSize} totalAssets={totalAssets} search={search} statuses={statuses} selectedAssetId={selectedAssetId} onNavigate={guardImageNavigation} />
    </section>}
  </aside>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><dt className="text-zinc-400">{label}</dt><dd className="max-w-[150px] truncate font-mono text-zinc-700">{value}</dd></div>;
}
