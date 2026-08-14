"use client";

import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import type { AssetStatus } from "@internal/db";

import { updateVideoDescriptionAction } from "@/app/(app)/workspace/[datasetId]/actions";
import { AssetNavigator } from "@/components/workspace/asset-navigator";
import { SaveConflictPanel } from "@/components/workspace/save-conflict-panel";
import { Badge } from "@/components/ui/badge";
import { imageStatusOptions, imageStatusPresentation } from "@/lib/image-status";
import { deleteVideoKeyframe, deleteVideoTrack, updateVideoTrack } from "@/lib/workspace/video-annotation-client";
import { flushVideoAutosaves } from "@/lib/workspace/video-autosave";
import { useAnnotationStore } from "@/stores/image-annotation-store";
import { useDatasetLabels, useDatasetLabelsStore, type DatasetLabel } from "@/stores/dataset-labels-store";
import { useVideoAnnotationStore } from "@/stores/video-annotation-store";
import type { SafeWorkspaceAsset } from "@/types/workspace";
import type { SafeVideoTrack } from "@/types/video-annotation";
import type { WorkspaceSelection } from "@/types/workspace";

type PanelTab = "description" | "labels" | "tracks" | "assets";
type TrackDraft = { objectId: string; name: string; labelId: string; interpolationMode: "LINEAR" | "NONE" };

export type VideoPropertiesTabsProps = {
  datasetId: string;
  selection: Extract<WorkspaceSelection, { engine: "VIDEO" }>;
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
 * VIDEO's `PropertiesPanel` tabs content -- description/labels/shapes/tracks/
 * assets, mirroring `image-properties-tabs.tsx`'s structure and autosave
 * conventions but reading/writing VIDEO's own stores and endpoints:
 * `useVideoAnnotationStore` for tracks/keyframes (kept in sync by
 * `video-engine.tsx`'s `setSnapshot`), `updateVideoDescriptionAction` for the
 * asset description, and `useDatasetLabelsStore` (`dataset-labels-store.ts`)
 * for the taxonomy -- VIDEO has no server-projected `labels` in
 * `WorkspaceSelection` (unlike IMAGE), so this component is what asks the
 * shared store to load them, the same store `ImagePropertiesTabs` reads.
 *
 * "Shapes" lists every persisted keyframe -- each one *is* one bounding-box
 * video annotation. Its Object ID/Name are read from the keyframe's own
 * `properties.objectId`/`properties.name` (the user-typed values from the
 * create-annotation dialog in `video-engine.tsx`), never from the parent
 * Track -- a Track is routinely shared by many keyframes (that's what makes
 * it a track), so displaying or editing a shared Track field here would
 * silently relabel every other box on that track. Per-shape label
 * assignment follows the same rule: it writes the *keyframe's own*
 * `labelId` column via `updateVideoKeyframe`, not the Track's `labelId`.
 * Clicking a shape card sets `useVideoAnnotationStore`'s
 * `selectedKeyframeId`, which `video-engine.tsx` reacts to by switching to
 * that keyframe's track, seeking to its timestamp, and pausing -- so
 * selecting a shape here highlights it on the paused frame.
 */
export function VideoPropertiesTabs({ datasetId, selection, assets, page, pageSize, totalAssets, completedAssets, search, statuses, selectedAssetId, tab, setTab }: VideoPropertiesTabsProps) {
  const asset = selection.asset;
  const router = useRouter();
  const [description, setDescription] = useState(asset.description ?? "");
  const [serverDescription, setServerDescription] = useState(asset.description ?? "");
  const [version, setVersion] = useState(asset.version);
  const [descriptionState, setDescriptionState] = useState<"idle" | "pending" | "saving" | "saved" | "failed" | "conflict">("idle");
  const [conflictDraft, setConflictDraft] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [shapeError, setShapeError] = useState<string | null>(null);
  const [newLabelName, setNewLabelName] = useState("");
  const taxonomy = useDatasetLabels(datasetId);
  const [expandedTrackId, setExpandedTrackId] = useState<string | null>(null);
  const [trackDrafts, setTrackDrafts] = useState<Record<string, TrackDraft>>({});
  const [savingTrackId, setSavingTrackId] = useState<string | null>(null);
  const lastAttemptedDescriptionRef = useRef<string | null>(null);
  const scheduleAutosave = useAnnotationStore((store) => store.scheduleAutosave);
  const flushAllAutosaves = useAnnotationStore((store) => store.flushAllAutosaves);
  const setConflictDraftInStore = useAnnotationStore((store) => store.setConflictDraft);
  const tracks = useVideoAnnotationStore((store) => store.tracks);
  const keyframes = useVideoAnnotationStore((store) => store.keyframes);
  const storeTrackList = useVideoAnnotationStore((store) => store.trackList);
  const storeKeyframeList = useVideoAnnotationStore((store) => store.keyframeList);
  const markSaved = useVideoAnnotationStore((store) => store.markSaved);
  const removeTrackFromStore = useVideoAnnotationStore((store) => store.removeTrack);
  const removeKeyframeFromStore = useVideoAnnotationStore((store) => store.removeKeyframe);
  const selectedKeyframeId = useVideoAnnotationStore((store) => store.selectedKeyframeId);
  const setSelectedKeyframeId = useVideoAnnotationStore((store) => store.setSelectedKeyframeId);
  const requestedTab = useVideoAnnotationStore((store) => store.requestedTab);

  // Applies `video-engine.tsx`'s toolbar "Create track" tab request (see
  // `requestedTab`'s doc comment in the store): switching here, then
  // clearing the flag, is what makes a track created via the toolbar
  // appear in the Tracks tab immediately, with no reload and no re-fire on
  // unrelated re-renders.
  useEffect(() => {
    if (!requestedTab) return;
    setTab(requestedTab);
    useVideoAnnotationStore.getState().clearRequestedTab();
  }, [requestedTab, setTab]);

  // `useDatasetLabelsStore` is a module-level singleton, not component
  // state -- once loaded for `datasetId`, this resolves immediately without
  // a network call on every later mount (every asset switch remounts this
  // component via `PropertiesPanel`'s `key`, and switching back from IMAGE
  // does too).
  useEffect(() => { void useDatasetLabelsStore.getState().ensureLoaded(datasetId); }, [datasetId]);

  useEffect(() => {
    if (description === serverDescription || lastAttemptedDescriptionRef.current === description) return;
    const resourceKey = `video-description:${asset.id}`;
    setDescriptionState("pending");
    scheduleAutosave(resourceKey, async () => {
      lastAttemptedDescriptionRef.current = description;
      setDescriptionState("saving");
      const result = await updateVideoDescriptionAction({ datasetId, assetId: asset.id, version, description: description.trim() || null });
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
  }, [asset.id, datasetId, description, scheduleAutosave, serverDescription, setConflictDraftInStore, version]);

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

  /**
   * A Track *is* a shape/object identity in this UI (spec: "Each shape card
   * corresponds to a VideoObjectTrack"). It is never created from this tab --
   * only from `video-engine.tsx`'s toolbar ("Create track", or drawing a box
   * via `confirmPendingBox`, which creates a track and its first keyframe
   * together) -- this tab is view/expand/edit/delete only.
   */

  function draftFromTrack(track: SafeVideoTrack): TrackDraft {
    return { objectId: typeof track.properties.objectId === "string" ? track.properties.objectId : "", name: track.name ?? "", labelId: track.labelId ?? "", interpolationMode: track.interpolationMode };
  }

  /** Seeds a fresh draft only on the collapsed->expanded transition, so an in-progress edit is never silently clobbered by the track updating elsewhere while its card stays open. */
  function toggleTrackExpanded(track: SafeVideoTrack) {
    const opening = expandedTrackId !== track.id;
    setExpandedTrackId(opening ? track.id : null);
    if (opening) setTrackDrafts((current) => ({ ...current, [track.id]: draftFromTrack(track) }));
  }

  function updateTrackDraft(trackId: string, changes: Partial<TrackDraft>) {
    setTrackDrafts((current) => ({ ...current, [trackId]: { ...(current[trackId] ?? draftFromTrack(tracks[trackId])), ...changes } }));
  }

  function cancelTrackEdit(trackId: string) {
    setTrackDrafts((current) => { const next = { ...current }; delete next[trackId]; return next; });
    setExpandedTrackId(null);
  }

  /**
   * The only path that saves a track's Object ID/Name/Label/Interpolation --
   * one revision-guarded PATCH sending all four fields from the draft
   * together, replacing the previous implicit save-per-field-blur behavior.
   * Touches Track metadata only; it never creates, updates, or deletes a
   * keyframe.
   */
  async function saveTrackEdit(trackId: string) {
    const track = tracks[trackId];
    const draft = trackDrafts[trackId];
    if (!track || !draft) return;
    setShapeError(null);
    setSavingTrackId(trackId);
    try {
      const result = await updateVideoTrack(trackId, { expectedTrackRevision: track.revision, name: draft.name.trim() || undefined, labelId: draft.labelId || null, interpolationMode: draft.interpolationMode, properties: { ...track.properties, objectId: draft.objectId.trim() } });
      markSaved(result.track);
      setTrackDrafts((current) => { const next = { ...current }; delete next[trackId]; return next; });
      setExpandedTrackId(null);
    } catch (error) {
      setShapeError((error as { code?: string }).code === "VIDEO_TRACK_REVISION_CONFLICT" ? "This track changed elsewhere. Reload and try again." : "This shape could not be saved.");
    } finally {
      setSavingTrackId(null);
    }
  }

  async function removeKeyframeRow(keyframeId: string) {
    const keyframe = keyframes[keyframeId];
    const track = keyframe ? tracks[keyframe.trackId] : undefined;
    if (!keyframe || !track) return;
    setShapeError(null);
    try {
      const result = await deleteVideoKeyframe(keyframeId, track.revision);
      markSaved(result.track);
      removeKeyframeFromStore(keyframeId);
    } catch { setShapeError("The keyframe could not be deleted."); }
  }

  async function removeTrackRow(trackId: string) {
    const track = tracks[trackId];
    if (!track || !window.confirm("Delete this track and its keyframes?")) return;
    setShapeError(null);
    try {
      await deleteVideoTrack(trackId, track.revision);
      removeTrackFromStore(trackId);
    } catch { setShapeError("The track could not be deleted."); }
  }

  async function guardNavigation(event: MouseEvent<HTMLAnchorElement>, href: string) {
    event.preventDefault();
    if (!(await flushBeforeNavigation())) return;
    router.push(href);
  }

  async function flushBeforeNavigation() {
    await flushAllAutosaves();
    await flushVideoAutosaves();
    return true;
  }

  async function applyAssetFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    if (!(await flushBeforeNavigation())) return;
    const form = new FormData(formElement);
    const params = new URLSearchParams({ page: "1" });
    const nextSearch = String(form.get("q") ?? "").trim();
    if (nextSearch) params.set("q", nextSearch);
    const nextStatus = String(form.get("status") ?? "ALL");
    if (nextStatus === "MULTIPLE") { for (const status of statuses) params.append("status", status); }
    else if (imageStatusOptions.includes(nextStatus as AssetStatus)) params.set("status", nextStatus);
    router.push(`/workspace/${datasetId}?${params.toString()}`);
  }

  const selectedStatus = statuses.length === 1 ? statuses[0] : statuses.length > 1 ? "MULTIPLE" : "ALL";
  const activeTab = (["description", "labels", "tracks", "assets"] as const).includes(tab as PanelTab) ? (tab as PanelTab) : "description";
  const trackList = storeTrackList;
  const keyframeList = [...storeKeyframeList].sort((left, right) => left.timestampMs - right.timestampMs);

  return <aside className="min-h-0 overflow-y-auto border-l border-zinc-200 bg-white">
    <div className="border-b border-zinc-200 p-4">
      <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-bold text-zinc-950">Video details</h2><Badge variant="info">VIDEO</Badge></div>
      <p className="mt-3 break-all text-xs font-semibold text-zinc-800">{asset.filename}</p>
      <dl className="mt-4 space-y-2 text-xs"><Detail label="Tracks" value={String(trackList.length)} /><Detail label="Keyframes" value={String(keyframeList.length)} /></dl>
    </div>
    <nav aria-label="Video management" className="grid grid-cols-4 border-b border-zinc-200">
      {(["description", "labels", "tracks", "assets"] as const).map((entry) => <button key={entry} type="button" onClick={() => setTab(entry)} className={`px-1.5 py-3 text-[11px] font-semibold capitalize ${activeTab === entry ? "border-b-2 border-sky-600 text-sky-700" : "text-zinc-500"}`}>{entry}</button>)}
    </nav>
    {activeTab === "description" && <section className="p-4">
      <div className="flex items-center justify-between"><h2 className="text-sm font-bold text-zinc-950">Description</h2><span className="text-[11px] text-zinc-400">{descriptionState === "pending" ? "Saving after inactivity…" : descriptionState === "saving" ? "Saving…" : descriptionState === "saved" ? "Saved" : descriptionState === "failed" ? "Save failed" : ""}</span></div>
      <textarea value={description} onChange={(event) => { lastAttemptedDescriptionRef.current = null; setDescription(event.target.value); }} maxLength={10_000} rows={7} className="mt-3 w-full resize-y rounded-xl border border-zinc-200 p-3 text-sm text-zinc-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100" placeholder="Scene context, notes, or quality flags" />
      {descriptionState === "conflict" && <div className="mt-3"><SaveConflictPanel message="Your description draft is still visible and was not sent again." onReload={() => window.location.reload()} onDiscard={() => { setDescription(serverDescription); setConflictDraft(null); setDescriptionState("idle"); }} /></div>}
      {descriptionState === "failed" && <p role="alert" className="mt-3 text-xs text-rose-700">Description was not saved. Edit it again to retry.</p>}
      {conflictDraft && <p className="sr-only">Local draft preserved.</p>}
    </section>}
    {activeTab === "labels" && <section className="p-4">
      <h2 className="text-sm font-bold text-zinc-950">Labels</h2>
      <div className="mt-3 flex gap-2"><input aria-label="New label name" value={newLabelName} onChange={(event) => setNewLabelName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createCustomLabel(); } }} className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-2 py-2 text-xs" placeholder="Custom label" /><button type="button" onClick={() => void createCustomLabel()} className="rounded-lg bg-zinc-900 px-3 text-xs font-semibold text-white">Add</button></div>
      <div className="mt-3 space-y-2">{taxonomy.map((label) => <div key={label.id} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-2 py-2"><span aria-hidden="true" className="h-3 w-3 rounded-full" style={{ backgroundColor: label.color }} /><span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-800">{label.name}</span><button type="button" onClick={() => void deleteLabel(label.id)} className="text-[11px] font-semibold text-rose-700">Remove</button></div>)}</div>
      {labelError && <p role="alert" className="mt-3 text-xs text-rose-700">{labelError}</p>}
    </section>}
    {activeTab === "tracks" && <section className="p-4">
      <div className="flex items-center justify-between"><h2 className="text-sm font-bold text-zinc-950">Tracks</h2><span className="text-xs text-zinc-400">{trackList.length}</span></div>
      <p className="mt-1 text-[11px] leading-4 text-zinc-400">Each track is one shape/object tracked across frames. Click a track to view and manage its keyframes. Create a new track from the video toolbar.</p>
      <div className="mt-3 space-y-2">{trackList.length === 0 ? <p className="text-xs text-zinc-500">No tracks yet.</p> : trackList.map((track) => {
        const trackKeyframes = keyframeList.filter((keyframe) => keyframe.trackId === track.id);
        const isExpanded = expandedTrackId === track.id;
        const draft = trackDrafts[track.id] ?? draftFromTrack(track);
        const isSaving = savingTrackId === track.id;
        return <div key={track.id} className={`rounded-xl border ${isExpanded ? "border-sky-300" : "border-zinc-200"}`}>
          <div role="button" tabIndex={0} onClick={() => toggleTrackExpanded(track)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleTrackExpanded(track); } }} className="cursor-pointer p-2">
            <div className="flex items-center justify-between gap-2"><span className="truncate font-mono text-[11px] text-zinc-500">Track ID: {track.id ?? "(none)"}</span><span className="shrink-0 text-[11px] text-zinc-400">{trackKeyframes.length} keyframes</span></div>
            <p className="mt-1 truncate text-xs font-semibold text-zinc-800">{track.name ?? "(unnamed shape)"}</p>
            {track.label ? <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-zinc-500"><span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: track.label.color }} />{track.label.name}</span> : null}
          </div>
          {isExpanded && <div className="space-y-2 border-t border-zinc-100 p-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] text-zinc-500">Object ID<input value={draft.objectId} onChange={(event) => updateTrackDraft(track.id, { objectId: event.target.value })} className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-1 text-xs" /></label>
              <label className="text-[11px] text-zinc-500">Name<input value={draft.name} onChange={(event) => updateTrackDraft(track.id, { name: event.target.value })} className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-1 text-xs" /></label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] text-zinc-500">Label
                <select value={draft.labelId} onChange={(event) => updateTrackDraft(track.id, { labelId: event.target.value })} className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs">
                  <option value="">No label</option>
                  {taxonomy.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <label className="text-[11px] text-zinc-500">Interpolation
                <select value={draft.interpolationMode} onChange={(event) => updateTrackDraft(track.id, { interpolationMode: event.target.value as "LINEAR" | "NONE" })} className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs">
                  <option value="LINEAR">Linear</option>
                  <option value="NONE">None</option>
                </select>
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => cancelTrackEdit(track.id)} disabled={isSaving} className="rounded-lg border border-zinc-200 px-3 py-1.5 text-[11px] font-semibold text-zinc-600 hover:bg-zinc-50 disabled:opacity-50">Cancel</button>
              <button type="button" onClick={() => void saveTrackEdit(track.id)} disabled={isSaving} className="rounded-lg bg-sky-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-sky-500 disabled:opacity-50">{isSaving ? "Saving…" : "Save"}</button>
            </div>
            <div>
              <h4 className="text-[11px] font-semibold text-zinc-600">Keyframes</h4>
              <div className="mt-1 space-y-1">{trackKeyframes.length === 0 ? <p className="text-[11px] text-zinc-400">No keyframes yet -- draw on the frame or use &quot;Add keyframe here&quot;.</p> : trackKeyframes.sort((left, right) => left.timestampMs - right.timestampMs).map((keyframe) => <div key={keyframe.id} className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-[11px] ${keyframe.id === selectedKeyframeId ? "bg-sky-50 text-sky-800" : "text-zinc-600 hover:bg-zinc-50"}`}>
                <button type="button" onClick={() => setSelectedKeyframeId(keyframe.id)} className="flex-1 text-left">{(keyframe.timestampMs / 1000).toFixed(2)}s</button>
                <button type="button" onClick={() => void removeKeyframeRow(keyframe.id)} className="font-semibold text-rose-700">Delete</button>
              </div>)}</div>
            </div>
            <button type="button" onClick={() => void removeTrackRow(track.id)} className="w-full rounded-lg px-2 py-1.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-50">Delete track</button>
          </div>}
        </div>;
      })}</div>
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
      <AssetNavigator datasetId={datasetId} assets={assets} page={page} pageSize={pageSize} totalAssets={totalAssets} search={search} statuses={statuses} selectedAssetId={selectedAssetId} onNavigate={guardNavigation} />
    </section>}
  </aside>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><dt className="text-zinc-400">{label}</dt><dd className="max-w-[150px] truncate font-mono text-zinc-700">{value}</dd></div>;
}
