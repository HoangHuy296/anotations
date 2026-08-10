"use client";

import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import type { AssetStatus } from "@internal/db";

import { updateVideoDescriptionAction } from "@/app/(app)/workspace/[datasetId]/actions";
import { AssetNavigator } from "@/components/workspace/asset-navigator";
import { SaveConflictPanel } from "@/components/workspace/save-conflict-panel";
import { Badge } from "@/components/ui/badge";
import { imageStatusOptions, imageStatusPresentation } from "@/lib/image-status";
import { deleteVideoKeyframe, deleteVideoTrack, updateVideoKeyframe } from "@/lib/workspace/video-annotation-client";
import { flushVideoAutosaves } from "@/lib/workspace/video-autosave";
import { useAnnotationStore } from "@/stores/image-annotation-store";
import { useVideoAnnotationStore } from "@/stores/video-annotation-store";
import type { SafeWorkspaceAsset } from "@/types/image-workspace";
import type { WorkspaceSelection } from "@/types/workspace";

type PanelTab = "description" | "labels" | "shapes" | "tracks" | "assets";
type WorkspaceLabel = { id: string; name: string; color: string };

export type VideoPropertiesTabsProps = {
  datasetId: string;
  selection: Extract<WorkspaceSelection, { engine: "VIDEO" }>;
  images: SafeWorkspaceAsset[];
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
 * asset description, and the shared dataset labels endpoint for the taxonomy
 * (VIDEO has no server-projected `labels` in `WorkspaceSelection`, so this
 * component fetches it itself).
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
export function VideoPropertiesTabs({ datasetId, selection, images, page, pageSize, totalAssets, completedAssets, search, statuses, selectedAssetId, tab, setTab }: VideoPropertiesTabsProps) {
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
  const [taxonomy, setTaxonomy] = useState<WorkspaceLabel[]>([]);
  const lastAttemptedDescriptionRef = useRef<string | null>(null);
  const scheduleAutosave = useAnnotationStore((store) => store.scheduleAutosave);
  const flushAllAutosaves = useAnnotationStore((store) => store.flushAllAutosaves);
  const setConflictDraftInStore = useAnnotationStore((store) => store.setConflictDraft);
  const tracks = useVideoAnnotationStore((store) => store.tracks);
  const keyframes = useVideoAnnotationStore((store) => store.keyframes);
  const markSaved = useVideoAnnotationStore((store) => store.markSaved);
  const selectedKeyframeId = useVideoAnnotationStore((store) => store.selectedKeyframeId);
  const setSelectedKeyframeId = useVideoAnnotationStore((store) => store.setSelectedKeyframeId);

  useEffect(() => {
    let active = true;
    void fetch(`/api/datasets/${datasetId}/labels`, { credentials: "same-origin" })
      .then(async (response) => response.ok ? response.json() : null)
      .then((payload: { data?: { items?: WorkspaceLabel[] } } | null) => { if (active && payload?.data?.items) setTaxonomy(payload.data.items); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [datasetId]);

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
    const payload = await response.json().catch(() => null) as { data?: WorkspaceLabel; error?: { message?: string } } | null;
    if (!response.ok || !payload?.data) {
      setLabelError(payload?.error?.message ?? "The label could not be created.");
      return;
    }
    setTaxonomy((current) => [...current, payload.data!].sort((left, right) => left.name.localeCompare(right.name)));
    setNewLabelName("");
  }

  async function deleteLabel(labelId: string) {
    setLabelError(null);
    const response = await fetch(`/api/labels/${labelId}`, { method: "DELETE", credentials: "same-origin" });
    if (response.status === 204) {
      setTaxonomy((current) => current.filter((label) => label.id !== labelId));
      return;
    }
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    setLabelError(payload?.error?.message ?? "The label could not be deleted.");
  }

  /**
   * Writes to the keyframe's own `labelId` column (via `updateVideoKeyframe`),
   * not the parent Track's -- a Track is shared by every keyframe on it, so
   * relabeling the Track here would silently relabel every other box on the
   * same track too.
   */
  async function assignKeyframeLabel(keyframeId: string, labelId: string | null) {
    const keyframe = keyframes[keyframeId];
    const track = keyframe ? tracks[keyframe.trackId] : undefined;
    if (!keyframe || !track) return;
    setShapeError(null);
    try {
      const result = await updateVideoKeyframe(keyframeId, { expectedTrackRevision: track.revision, labelId });
      markSaved(result.track, result.keyframe);
    } catch { setShapeError("This shape's label could not be changed."); }
  }

  async function removeKeyframeRow(keyframeId: string) {
    const keyframe = keyframes[keyframeId];
    const track = keyframe ? tracks[keyframe.trackId] : undefined;
    if (!keyframe || !track) return;
    setShapeError(null);
    try {
      const result = await deleteVideoKeyframe(keyframeId, track.revision);
      markSaved(result.track);
      useVideoAnnotationStore.setState((state) => { const next = { ...state.keyframes }; delete next[keyframeId]; return { keyframes: next }; });
    } catch { setShapeError("The keyframe could not be deleted."); }
  }

  async function removeTrackRow(trackId: string) {
    const track = tracks[trackId];
    if (!track || !window.confirm("Delete this track and its keyframes?")) return;
    setShapeError(null);
    try {
      await deleteVideoTrack(trackId, track.revision);
      useVideoAnnotationStore.setState((state) => {
        const nextTracks = { ...state.tracks };
        delete nextTracks[trackId];
        const nextKeyframes = Object.fromEntries(Object.entries(state.keyframes).filter(([, keyframe]) => keyframe.trackId !== trackId));
        return { tracks: nextTracks, keyframes: nextKeyframes };
      });
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
  const activeTab = (["description", "labels", "shapes", "tracks", "assets"] as const).includes(tab as PanelTab) ? (tab as PanelTab) : "description";
  const trackList = Object.values(tracks);
  const keyframeList = Object.values(keyframes).sort((left, right) => left.timestampMs - right.timestampMs);

  return <aside className="min-h-0 overflow-y-auto border-l border-zinc-200 bg-white">
    <div className="border-b border-zinc-200 p-4">
      <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-bold text-zinc-950">Video details</h2><Badge variant="info">VIDEO</Badge></div>
      <p className="mt-3 break-all text-xs font-semibold text-zinc-800">{asset.filename}</p>
      <dl className="mt-4 space-y-2 text-xs"><Detail label="Tracks" value={String(trackList.length)} /><Detail label="Keyframes" value={String(keyframeList.length)} /></dl>
    </div>
    <nav aria-label="Video management" className="grid grid-cols-5 border-b border-zinc-200">
      {(["description", "labels", "shapes", "tracks", "assets"] as const).map((entry) => <button key={entry} type="button" onClick={() => setTab(entry)} className={`px-1.5 py-3 text-[11px] font-semibold capitalize ${activeTab === entry ? "border-b-2 border-sky-600 text-sky-700" : "text-zinc-500"}`}>{entry}</button>)}
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
    {activeTab === "shapes" && <section className="p-4">
      <div className="flex items-center justify-between"><h2 className="text-sm font-bold text-zinc-950">Shapes</h2><span className="text-xs text-zinc-400">{keyframeList.length}</span></div>
      <p className="mt-1 text-[11px] leading-4 text-zinc-400">Every bounding box drawn on the frame is a keyframe, labelled by the Object ID/Name assigned when it was saved. Click a shape to highlight it on the paused frame.</p>
      <div className="mt-3 space-y-2">{keyframeList.length === 0 ? <p className="text-xs text-zinc-500">No bounding boxes yet.</p> : keyframeList.map((keyframe) => {
        const objectId = typeof keyframe.properties.objectId === "string" && keyframe.properties.objectId ? keyframe.properties.objectId : null;
        const name = typeof keyframe.properties.name === "string" && keyframe.properties.name ? keyframe.properties.name : null;
        const label = taxonomy.find((item) => item.id === keyframe.labelId) ?? null;
        const isSelected = keyframe.id === selectedKeyframeId;
  return <button key={keyframe.id} type="button" onClick={() => setSelectedKeyframeId(keyframe.id)} className={`w-full rounded-xl border p-2 text-left ${isSelected ? "border-sky-400 bg-sky-50" : "border-zinc-200 hover:bg-zinc-50"}`}>
          <div className="flex items-center justify-between gap-2"><span className="truncate font-mono text-[11px] text-zinc-500">Object ID: {objectId ?? "(none)"}</span><span className="shrink-0 text-[11px] text-zinc-400">{(keyframe.timestampMs / 1000).toFixed(2)}s</span></div>
          <p className="mt-1 text-xs font-semibold text-zinc-800">{name ?? "(unnamed shape)"}</p>
          <div className="mt-2 flex gap-1" onClick={(event) => event.stopPropagation()}>
            <select aria-label={`Label for ${objectId ?? keyframe.id}`} value={keyframe.labelId ?? ""} onChange={(event) => void assignKeyframeLabel(keyframe.id, event.target.value || null)} className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-[11px]">
              <option value="">No label</option>
              {taxonomy.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <button type="button" onClick={() => void removeKeyframeRow(keyframe.id)} className="rounded-lg px-2 text-[11px] font-semibold text-rose-700 hover:bg-rose-50">Delete</button>
          </div>
          {label ? <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-zinc-500"><span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: label.color }} />{label.name}</span> : null}
        </button>;
      })}</div>
      {shapeError && <p role="alert" className="mt-3 text-xs text-rose-700">{shapeError}</p>}
    </section>}
    {activeTab === "tracks" && <section className="p-4">
      <div className="flex items-center justify-between"><h2 className="text-sm font-bold text-zinc-950">Tracks</h2><span className="text-xs text-zinc-400">{trackList.length}</span></div>
      <div className="mt-3 space-y-2">{trackList.length === 0 ? <p className="text-xs text-zinc-500">No tracks yet. Draw a box on the frame to create one.</p> : trackList.map((track) => {
        const trackKeyframeCount = keyframeList.filter((keyframe) => keyframe.trackId === track.id).length;
  return <div key={track.id} className="flex items-center justify-between gap-2 rounded-xl border border-zinc-200 p-2">
          <div className="min-w-0"><p className="truncate text-xs font-semibold text-zinc-800">{track.name ?? track.id.slice(0, 8)}</p><p className="text-[11px] text-zinc-400">{trackKeyframeCount} keyframes · {track.interpolationMode.toLowerCase()}</p></div>
          <button type="button" onClick={() => void removeTrackRow(track.id)} className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50">Delete</button>
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
      <AssetNavigator datasetId={datasetId} assets={images} page={page} pageSize={pageSize} totalAssets={totalAssets} search={search} statuses={statuses} selectedAssetId={selectedAssetId} onNavigate={guardNavigation} />
    </section>}
  </aside>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><dt className="text-zinc-400">{label}</dt><dd className="max-w-[150px] truncate font-mono text-zinc-700">{value}</dd></div>;
}
