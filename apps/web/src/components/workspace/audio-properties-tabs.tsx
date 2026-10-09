"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import type { AssetStatus } from "@internal/db";

import { updateAudioDescriptionAction } from "@/app/(app)/workspace/[datasetId]/actions";
import { AssetBrowserFilters } from "@/components/workspace/asset-browser-filters";
import { AssetNavigator, type AssetNavigatorFilters } from "@/components/workspace/asset-navigator";
import { BulkActionBar } from "@/components/workspace/bulk-action-bar";
import { AssetAssignmentPanel } from "@/components/workspace/asset-assignment-panel";
import { SaveConflictPanel } from "@/components/workspace/save-conflict-panel";
import { WorkflowHistoryPanel } from "@/components/workspace/workflow-history-panel";
import { Badge } from "@/components/ui/badge";
import { workspaceEngineRegistry } from "@/lib/workspace/workspace-engine-registry";
import { useAnnotationStore } from "@/stores/image-annotation-store";
import { useDatasetLabels, useDatasetLabelsStore, type DatasetLabel } from "@/stores/dataset-labels-store";
import type { SafeWorkspaceAsset } from "@/types/workspace";
import type { WorkspaceSelection } from "@/types/workspace";

type PanelTab = "description" | "labels" | "assets";
type LabelUpdate = { name: string; color: string; description: string; hotkey: string };

export type AudioPropertiesTabsProps = {
  datasetId: string;
  selection: Extract<WorkspaceSelection, { engine: "AUDIO" }>;
  assets: SafeWorkspaceAsset[];
  page: number;
  pageSize: number;
  totalAssets: number;
  completedAssets: number;
  search: string;
  statuses: AssetStatus[];
  selectedAssetId: string | null;
  filters: AssetNavigatorFilters;
  tab: string;
  setTab: (tab: string) => void;
};

/**
 * AUDIO's `PropertiesPanel` tabs content: description / labels / assets. Everything shown here comes from AUDIO data - the asset row and the AUDIO media readiness
 * (`selection.readiness.audio`: duration, sample rate, channels, codec, waveform) - never from the VIDEO annotation store, which is a module-level singleton that can still
 * hold the tracks of a VIDEO asset opened earlier in the same browser session. There is no AUDIO annotation model in this phase ("Audio annotation editing is intentionally
 * unavailable", audio-engine.tsx), so there is no track/keyframe/time-range editor here and none is simulated. The description autosave uses the AUDIO-scoped mutation.
 */
export function AudioPropertiesTabs({ datasetId, selection, assets, page, pageSize, totalAssets, completedAssets, search, statuses, selectedAssetId, filters, tab, setTab }: AudioPropertiesTabsProps) {
  const asset = selection.asset;
  const readOnly = asset.status === "NEEDS_REVIEW" || asset.status === "REVIEWED" || asset.status === "REJECTED";
  const router = useRouter();
  const [description, setDescription] = useState(asset.description ?? "");
  const [serverDescription, setServerDescription] = useState(asset.description ?? "");
  const [version, setVersion] = useState(asset.version);
  const [descriptionState, setDescriptionState] = useState<"idle" | "pending" | "saving" | "saved" | "failed" | "conflict">("idle");
  const [conflictDraft, setConflictDraft] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#0EA5E9");
  const [expandedLabelId, setExpandedLabelId] = useState<string | null>(null);
  const [labelUpdate, setLabelUpdate] = useState<Record<string, LabelUpdate>>({});
  const [savingLabelId, setSavingLabelId] = useState<string | null>(null);
  const taxonomy = useDatasetLabels(datasetId);
  const lastAttemptedDescriptionRef = useRef<string | null>(null);
  const scheduleAutosave = useAnnotationStore((store) => store.scheduleAutosave);
  const setConflictDraftInStore = useAnnotationStore((store) => store.setConflictDraft);

  // `useDatasetLabelsStore` is a module-level singleton, not component
  // state -- once loaded for `datasetId`, this resolves immediately without
  // a network call on every later mount (every asset switch remounts this
  // component via `PropertiesPanel`'s `key`, and switching back from IMAGE
  // does too).
  useEffect(() => { void useDatasetLabelsStore.getState().ensureLoaded(datasetId); }, [datasetId]);

  useEffect(() => {
    if (readOnly) return;
    if (description === serverDescription || lastAttemptedDescriptionRef.current === description) return;
    const resourceKey = `audio-description:${asset.id}`;
    setDescriptionState("pending");
    scheduleAutosave(resourceKey, async () => {
      lastAttemptedDescriptionRef.current = description;
      setDescriptionState("saving");
      const result = await updateAudioDescriptionAction({ datasetId, assetId: asset.id, version, description: description.trim() || null });
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
  }, [asset.id, datasetId, description, readOnly, scheduleAutosave, serverDescription, setConflictDraftInStore, version]);

  async function createCustomLabel() {
    const name = newLabelName.trim();
    if (!name) return;
    const color = /^#[0-9A-Fa-f]{6}$/.test(newLabelColor) ? newLabelColor : "#0EA5E9";
    setLabelError(null);
    const response = await fetch(`/api/datasets/${datasetId}/labels`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, color, description: "", hotkey: "" }),
    });
    const payload = await response.json().catch(() => null) as { data?: DatasetLabel; error?: { message?: string } } | null;
    if (!response.ok || !payload?.data) {
      setLabelError(payload?.error?.message ?? "The label could not be created.");
      return;
    }
    useDatasetLabelsStore.getState().addLabel(datasetId, payload.data);
    setNewLabelName("");
    setNewLabelColor("#0EA5E9");
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

  function draftFromLabel(label: DatasetLabel): LabelUpdate {
    return { name: label.name, color: label.color, description: label.description ?? "", hotkey: label.hotkey ?? "" };
  }

  function draftIsDirty(label: DatasetLabel, draft: LabelUpdate) {
    const original = draftFromLabel(label);
    return draft.name !== original.name || draft.color.toUpperCase() !== original.color.toUpperCase() || draft.description !== original.description || draft.hotkey !== original.hotkey;
  }

  /** Seeds a fresh draft only on the collapsed->expanded transition -- same pattern as this tab's own track-edit below -- so an in-progress edit is never silently clobbered by the label list refreshing elsewhere while its card stays open. */
  function toggleLabelExpanded(label: DatasetLabel) {
    const opening = expandedLabelId !== label.id;
    setExpandedLabelId(opening ? label.id : null);
    if (opening) setLabelUpdate((current) => ({ ...current, [label.id]: draftFromLabel(label) }));
    setLabelError(null);
  }

  function updateLabelDraft(labelId: string, changes: Partial<LabelUpdate>) {
    setLabelUpdate((current) => ({ ...current, [labelId]: { ...(current[labelId] ?? { name: "", color: "#0EA5E9", description: "", hotkey: "" }), ...changes } }));
  }

  /** Closes the expanded form without saving, discarding the in-progress draft. */
  function cancelLabelEdit(labelId: string) {
    setLabelUpdate((current) => { const next = { ...current }; delete next[labelId]; return next; });
    setExpandedLabelId(null);
    setLabelError(null);
  }

  async function saveLabelEdit(labelId: string) {
    const draft = labelUpdate[labelId];
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) { setLabelError("Name is required."); return; }
    const color = /^#[0-9A-Fa-f]{6}$/.test(draft.color) ? draft.color.toUpperCase() : null;
    if (!color) { setLabelError("Use a 6-digit hex color such as #0EA5E9."); return; }
    setLabelError(null);
    setSavingLabelId(labelId);
    const response = await fetch(`/api/labels/${labelId}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, color, description: draft.description, hotkey: draft.hotkey }),
    });
    const payload = await response.json().catch(() => null) as { data?: DatasetLabel; error?: { message?: string } } | null;
    setSavingLabelId(null);
    if (!response.ok || !payload?.data) {
      setLabelError(payload?.error?.message ?? "The label could not be saved.");
      return;
    }
    useDatasetLabelsStore.getState().updateLabel(datasetId, payload.data);
    setLabelUpdate((current) => { const next = { ...current }; delete next[labelId]; return next; });
    setExpandedLabelId(null);
  }

  async function guardNavigation(event: MouseEvent<HTMLAnchorElement>, href: string) {
    event.preventDefault();
    if (!(await flushBeforeNavigation())) return;
    router.push(href);
  }

  async function flushBeforeNavigation() {
    const flushed = await workspaceEngineRegistry.AUDIO.flush(datasetId, asset.id);
    return flushed.ok || window.confirm("An audio edit could not be saved or has a conflict. Discard the local draft and leave this asset?");
  }

  const activeTab = (["description", "labels", "assets"] as const).includes(tab as PanelTab) ? (tab as PanelTab) : "description";
  const audio = selection.readiness.audio;

  return <aside className="min-h-0 overflow-y-auto border-l border-zinc-200 bg-white">
    <div className="border-b border-zinc-200 p-4">
      <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-bold text-zinc-950">Audio details</h2><Badge variant="info">AUDIO</Badge></div>
      <p className="mt-3 break-all text-xs font-semibold text-zinc-800">{asset.filename}</p>
      <dl className="mt-4 space-y-2 text-xs">
        <Detail label="Duration" value={formatDuration(audio?.durationMs ?? null)} />
        <Detail label="Sample rate" value={audio?.sampleRate ? `${audio.sampleRate} Hz` : "-"} />
        <Detail label="Channels" value={audio?.channels ? String(audio.channels) : "-"} />
        <Detail label="Codec" value={audio?.codec ?? "-"} />
        <Detail label="Waveform" value={audio?.waveformReady ? "ready" : "not ready"} />
        <Detail label="Annotations" value="not available" />
      </dl>
    </div>
    <nav aria-label="Audio management" className="grid grid-cols-3 border-b border-zinc-200">
      {(["description", "labels", "assets"] as const).map((entry) => <button key={entry} type="button" onClick={() => setTab(entry)} className={`px-1.5 py-3 text-[11px] font-semibold capitalize ${activeTab === entry ? "border-b-2 border-sky-600 text-sky-700" : "text-zinc-500"}`}>{entry}</button>)}
    </nav>
    {activeTab === "description" && <section className="p-4">
      <div className="flex items-center justify-between"><h2 className="text-sm font-bold text-zinc-950">Description</h2><span className="text-[11px] text-zinc-400">{descriptionState === "pending" ? "Saving after inactivity…" : descriptionState === "saving" ? "Saving…" : descriptionState === "saved" ? "Saved" : descriptionState === "failed" ? "Save failed" : ""}</span></div>
      <textarea readOnly={readOnly} value={description} onChange={(event) => { if (!readOnly) { lastAttemptedDescriptionRef.current = null; setDescription(event.target.value); } }} maxLength={10_000} rows={7} className="mt-3 w-full resize-y rounded-xl border border-zinc-200 p-3 text-sm text-zinc-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100" placeholder="Scene context, notes, or quality flags" />
      {descriptionState === "conflict" && <div className="mt-3"><SaveConflictPanel message="Your description draft is still visible and was not sent again." onReload={() => window.location.reload()} onDiscard={() => { setDescription(serverDescription); setConflictDraft(null); setDescriptionState("idle"); }} /></div>}
      {descriptionState === "failed" && <p role="alert" className="mt-3 text-xs text-rose-700">Description was not saved. Edit it again to retry.</p>}
      {conflictDraft && <p className="sr-only">Local draft preserved.</p>}
      <AssetAssignmentPanel datasetId={datasetId} assetId={asset.id} />
      <WorkflowHistoryPanel datasetId={datasetId} assetId={asset.id} />
    </section>}
    {activeTab === "labels" && <section className="p-4">
      <h2 className="text-sm font-bold text-zinc-950">Labels</h2>
      <div className="mt-3 flex gap-2">
        <input aria-label="New label name" value={newLabelName} onChange={(event) => setNewLabelName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createCustomLabel(); } }} className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-2 py-2 text-xs" placeholder="Custom label" />
        <input aria-label="Label color" type="color" value={newLabelColor} onChange={(event) => setNewLabelColor(event.target.value)} className="h-8.5 w-9 shrink-0 cursor-pointer rounded-lg border border-zinc-200 p-0.5" title="Choose label color" />
        <input aria-label="Label color code" value={newLabelColor} onChange={(event) => setNewLabelColor(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createCustomLabel(); } }} className="w-20 shrink-0 rounded-lg border border-zinc-200 px-2 py-2 font-mono text-xs uppercase" placeholder="#0EA5E9" maxLength={7} />
        <button type="button" onClick={() => void createCustomLabel()} className="rounded-lg bg-zinc-900 px-3 text-xs font-semibold text-white">Add</button>
      </div>
      <div className="mt-3 space-y-2">{taxonomy.map((label) => {
        const isExpanded = expandedLabelId === label.id;
        const draft = labelUpdate[label.id] ?? draftFromLabel(label);
        const isSaving = savingLabelId === label.id;
        return <div key={label.id} className={`rounded-lg border ${isExpanded ? "border-sky-300" : "border-zinc-200"}`}>
          <div role="button" tabIndex={0} onClick={() => toggleLabelExpanded(label)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleLabelExpanded(label); } }} className="flex cursor-pointer items-center gap-2 px-2 py-2">
            <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-800">{label.name}</span>
            {label.hotkey && <span className="shrink-0 rounded border border-zinc-200 px-1 font-mono text-[10px] text-zinc-500">{label.hotkey}</span>}
            <button type="button" onClick={(event) => { event.stopPropagation(); void deleteLabel(label.id); }} className="shrink-0 text-[11px] font-semibold text-rose-700">Remove</button>
          </div>
          {isExpanded && <div className="space-y-2 border-t border-zinc-100 p-2">
            <label className="block text-[11px] text-zinc-500">Name<input value={draft.name} onChange={(event) => updateLabelDraft(label.id, { name: event.target.value })} maxLength={50} className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-1 text-xs" /></label>
            <div className="flex gap-2">
              <label className="text-[11px] text-zinc-500">Color<input aria-label={`Color for ${label.name}`} type="color" value={/^#[0-9A-Fa-f]{6}$/.test(draft.color) ? draft.color : "#0EA5E9"} onChange={(event) => updateLabelDraft(label.id, { color: event.target.value })} className="mt-1 h-8.5 w-9 cursor-pointer rounded-lg border border-zinc-200 p-0.5" /></label>
              <label className="min-w-0 flex-1 text-[11px] text-zinc-500">Color code<input aria-label={`Color code for ${label.name}`} value={draft.color} onChange={(event) => updateLabelDraft(label.id, { color: event.target.value })} maxLength={7} className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-1 font-mono text-xs uppercase" /></label>
              <label className="w-14 shrink-0 text-[11px] text-zinc-500">Hotkey<input aria-label={`Hotkey for ${label.name}`} value={draft.hotkey} onChange={(event) => updateLabelDraft(label.id, { hotkey: event.target.value.slice(0, 1) })} maxLength={1} className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-1 text-center font-mono text-xs uppercase" /></label>
            </div>
            <label className="block text-[11px] text-zinc-500">Description<textarea value={draft.description} onChange={(event) => updateLabelDraft(label.id, { description: event.target.value })} maxLength={280} rows={2} className="mt-1 w-full resize-y rounded-lg border border-zinc-200 px-2 py-1 text-xs" placeholder="Describe when annotators should apply this label." /></label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => cancelLabelEdit(label.id)} disabled={isSaving} className="rounded-lg border border-zinc-200 px-3 py-1.5 text-[11px] font-semibold text-zinc-600 hover:bg-zinc-50 disabled:opacity-50">Cancel</button>
              <button type="button" onClick={() => void saveLabelEdit(label.id)} disabled={isSaving || !draftIsDirty(label, draft)} className="rounded-lg bg-sky-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-sky-500 disabled:opacity-50">{isSaving ? "Saving…" : "Save"}</button>
            </div>
          </div>}
        </div>;
      })}</div>
      {labelError && <p role="alert" className="mt-3 text-xs text-rose-700">{labelError}</p>}
    </section>}
    {activeTab === "assets" && <section className="p-4">
      <div className="flex items-center justify-between"><h2 className="text-sm font-bold text-zinc-950">Assets</h2><span className="text-xs text-zinc-400">Page {page}</span></div>
      <p className="mt-1 text-xs text-zinc-500">This workspace page is limited to {pageSize} assets.</p>
      <AssetBrowserFilters datasetId={datasetId} search={search} statuses={statuses} filterModality={filters.filterModality} beforeNavigate={flushBeforeNavigation} />
      <div className="mt-3" aria-label="Dataset progress"><div className="flex justify-between text-[11px] text-zinc-500"><span>Dataset progress</span><span>{completedAssets} / {totalAssets}</span></div><div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${totalAssets ? Math.round((completedAssets / totalAssets) * 100) : 0}%` }} /></div></div>
      <AssetNavigator datasetId={datasetId} assets={assets} page={page} pageSize={pageSize} totalAssets={totalAssets} search={search} statuses={statuses} selectedAssetId={selectedAssetId} filters={filters} onNavigate={guardNavigation} />
      <BulkActionBar datasetId={datasetId} labels={taxonomy} />
    </section>}
  </aside>;
}

function formatDuration(durationMs: number | null) {
  if (durationMs === null) return "-";
  const seconds = Math.round(durationMs / 100) / 10;
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s` : `${seconds.toFixed(1)}s`;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><dt className="text-zinc-400">{label}</dt><dd className="max-w-[150px] truncate font-mono text-zinc-700">{value}</dd></div>;
}
