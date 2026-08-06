"use client";

import { Play, SpinnerGap, VideoCamera } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { SafeMediaReadiness } from "@/types/media-processing";
import type { SafeVideoAnnotations } from "@/types/video-annotation";
import { VideoDetailsPanel } from "@/components/workspace/video-details-panel";
import { VideoTimeline } from "@/components/workspace/video-timeline";
import { VideoTemporalLabels } from "@/components/workspace/video-temporal-labels";
import { VideoToolbar } from "@/components/workspace/video-toolbar";
import { useVideoAnnotationStore } from "@/stores/video-annotation-store";
import { TrackAutosaveCoordinator, type VideoSaveState } from "@/lib/workspace/video-autosave";
import { addKeyframeHere, createVideoKeyframe, createVideoTrack, deleteVideoKeyframe, deleteVideoTrack, updateVideoKeyframe } from "@/lib/workspace/video-annotation-client";

type VideoEngineProps = {
  asset: { id: string; filename: string; description: string | null };
  readiness: SafeMediaReadiness;
  annotations: SafeVideoAnnotations;
};
type KeyframeChanges = { timestampMs?: number; geometry?: { kind: "BOUNDING_BOX"; x: number; y: number; width: number; height: number } };

/**
 * Read-only Phase 018 VIDEO surface. Frame/track/keyframe mutations stay
 * behind their dedicated revision-guarded contract; this component never
 * falls through to ImageCanvas or exposes a storage location.
 */
export function VideoEngine({ asset, readiness, annotations }: VideoEngineProps) {
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [currentTime, setCurrentTime] = useState(0);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(annotations.tracks[0]?.id ?? null);
  const [selectedKeyframeId, setSelectedKeyframeId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftLabelId, setDraftLabelId] = useState<string>("");
  const [draftMode, setDraftMode] = useState<"LINEAR" | "NONE">("LINEAR");
  const [draftProperties, setDraftProperties] = useState("{}");
  const [draftGeometry, setDraftGeometry] = useState<{ kind: "BOUNDING_BOX"; x: number; y: number; width: number; height: number } | null>(null);
  const [draftTimestampMs, setDraftTimestampMs] = useState<number | null>(null);
  const dragGeometryRef = useRef<{ kind: "BOUNDING_BOX"; x: number; y: number; width: number; height: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [trackSaveStates, setTrackSaveStates] = useState<Record<string, VideoSaveState>>({});
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackCoordinators = useRef(new Map<string, TrackAutosaveCoordinator>());
  const keyframeDraftChanges = useRef(new Map<string, KeyframeChanges>());
  const setSnapshot = useVideoAnnotationStore((state) => state.setSnapshot);
  const mutationState = useVideoAnnotationStore((state) => state.mutationState);
  const localDraft = useVideoAnnotationStore((state) => state.localDraft);

  useEffect(() => {
    let active = true;
    void fetch(`/api/assets/${encodeURIComponent(asset.id)}/view-url`, { credentials: "same-origin" })
      .then(async (response) => response.ok ? response.json() : null)
      .then((payload: { data?: { viewUrl?: unknown } } | null) => {
        if (!active) return;
        if (typeof payload?.data?.viewUrl === "string") {
          setViewUrl(payload.data.viewUrl);
          setLoadState("ready");
        } else setLoadState("unavailable");
      })
      .catch(() => { if (active) setLoadState("unavailable"); });
    return () => { active = false; };
  }, [asset.id]);

  useEffect(() => {
    setSnapshot(annotations.tracks, annotations.keyframes);
  }, [annotations.keyframes, annotations.tracks, setSnapshot]);
  useEffect(() => () => { void Promise.all([...trackCoordinators.current.values()].map((coordinator) => coordinator.dispose())); }, []);

  const selectedTrack = annotations.tracks.find((track) => track.id === selectedTrackId) ?? null;
  const trackKeyframes = useMemo(() => selectedTrack ? annotations.keyframes.filter((keyframe) => keyframe.trackId === selectedTrack.id).sort((a, b) => a.timestampMs - b.timestampMs) : [], [annotations.keyframes, selectedTrack]);
  const exactKeyframeAtTime = trackKeyframes.find((keyframe) => Math.abs(keyframe.timestampMs - currentTime * 1000) < 5);
  const selectedKeyframe = trackKeyframes.find((keyframe) => keyframe.id === selectedKeyframeId) ?? exactKeyframeAtTime ?? trackKeyframes.at(-1) ?? null;
  // A persisted overlay (editable, draggable/resizable) only draws when the
  // user explicitly selected a keyframe or the playhead sits exactly on one;
  // the `.at(-1)` fallback above exists only to keep the keyframe editor form
  // populated with something, and must never masquerade as "this is the
  // current frame's geometry" in the video overlay itself.
  const showsPersistedOverlay = Boolean(selectedKeyframeId && trackKeyframes.some((keyframe) => keyframe.id === selectedKeyframeId)) || Boolean(exactKeyframeAtTime);
  // A derived preview -- never persisted, never draggable -- fills the gap
  // when the playhead sits between two keyframes on the selected track.
  const derivedPreview = !showsPersistedOverlay && selectedTrack
    ? annotations.interpolation.find((item) => item.trackId === selectedTrack.id && Math.abs(item.timestampMs - currentTime * 1000) < 5)
    : undefined;
  const seekTo = (timestampMs: number) => {
    const seconds = Math.max(0, timestampMs / 1000);
    setCurrentTime(seconds);
    if (videoRef.current) videoRef.current.currentTime = seconds;
  };
  const chooseKeyframe = (id: string) => {
    const keyframe = trackKeyframes.find((item) => item.id === id);
    setSelectedKeyframeId(id);
    setDraftGeometry(keyframe?.geometry ?? null);
    setDraftTimestampMs(keyframe?.timestampMs ?? null);
  };
  const selectTrack = (trackId: string) => {
    const next = annotations.tracks.find((track) => track.id === trackId) ?? null;
    setSelectedTrackId(trackId || null);
    setSelectedKeyframeId(null);
    setDraftName(next?.name ?? "");
    setDraftLabelId(next?.labelId ?? "");
    setDraftMode(next?.interpolationMode ?? "LINEAR");
    setDraftProperties(JSON.stringify(next?.properties ?? {}));
  };
  const coordinatorFor = (track: NonNullable<typeof selectedTrack>) => {
    const existing = trackCoordinators.current.get(track.id);
    if (existing) { existing.setRevision(track.revision); return existing; }
    const coordinator = new TrackAutosaveCoordinator(track.id, track.revision, (state) => setTrackSaveStates((values) => ({ ...values, [track.id]: state })), (saved) => useVideoAnnotationStore.getState().markSaved(saved));
    trackCoordinators.current.set(track.id, coordinator);
    return coordinator;
  };
  const addTrack = async () => {
    setActionError(null);
    try {
      const result = await createVideoTrack(asset.id, { name: `Track ${annotations.tracks.length + 1}`, interpolationMode: "LINEAR" });
      selectTrack(result.track.id);
      setDraftName(result.track.name ?? "");
      setDraftProperties(JSON.stringify(result.track.properties ?? {}));
    } catch { setActionError("Track could not be created. Reload and try again."); }
  };
  const addKeyframe = async () => {
    if (!selectedTrack) return;
    setActionError(null);
    try {
      const geometry = annotations.interpolation.find((item) => item.trackId === selectedTrack.id && item.timestampMs === Math.round(currentTime * 1000));
      const coordinator = coordinatorFor(selectedTrack);
      coordinator.schedule((revision) => {
        const request = geometry
          ? addKeyframeHere(selectedTrack.id, geometry, revision)
          : createVideoKeyframe(selectedTrack.id, { expectedTrackRevision: revision, timestampMs: Math.round(currentTime * 1000), geometry: { kind: "BOUNDING_BOX", x: 0.35, y: 0.35, width: 0.2, height: 0.2 } });
        return request.then((result) => { useVideoAnnotationStore.getState().markSaved(result.track, result.keyframe); return result.track; });
      });
      await coordinator.flush();
    } catch (error) {
      if (error instanceof Error && (error as Error & { code?: string }).code === "VIDEO_TRACK_REVISION_CONFLICT") useVideoAnnotationStore.getState().preserveConflict(selectedKeyframe ?? null);
      setActionError("Keyframe save conflicted with a newer track revision.");
    }
  };

  const updateTrack = async () => {
    if (!selectedTrack) return;
    setActionError(null);
    try {
      const coordinator = coordinatorFor(selectedTrack);
      const properties = JSON.parse(draftProperties) as Record<string, unknown>;
      if (!properties || Array.isArray(properties)) throw new Error("Invalid properties");
      coordinator.scheduleTrackUpdate({ name: draftName || undefined, labelId: draftLabelId || null, interpolationMode: draftMode, properties });
      await coordinator.flush();
    } catch { setActionError("Track changed on the server; reload before saving."); }
  };
  const removeTrack = async () => {
    if (!selectedTrack || !window.confirm("Delete this track and its keyframes?")) return;
    try {
      const coordinator = coordinatorFor(selectedTrack);
      await coordinator.flush();
      await deleteVideoTrack(selectedTrack.id, coordinator.getRevision());
      await coordinator.dispose();
      trackCoordinators.current.delete(selectedTrack.id);
      setSelectedTrackId(null);
      setSelectedKeyframeId(null);
    } catch { setActionError("Track could not be deleted. Reload and try again."); }
  };
  const updateKeyframe = async (changes: KeyframeChanges) => {
    if (!selectedKeyframe || !selectedTrack) return;
    if (changes.geometry) setDraftGeometry(changes.geometry);
    if (changes.timestampMs !== undefined) setDraftTimestampMs(changes.timestampMs);
    const mergedChanges = { ...keyframeDraftChanges.current.get(selectedKeyframe.id), ...changes };
    keyframeDraftChanges.current.set(selectedKeyframe.id, mergedChanges);
    const coordinator = coordinatorFor(selectedTrack);
    coordinator.schedule((revision) => updateVideoKeyframe(selectedKeyframe.id, { expectedTrackRevision: revision, ...keyframeDraftChanges.current.get(selectedKeyframe.id) }).then((result) => { useVideoAnnotationStore.getState().markSaved(result.track, result.keyframe); return result.track; }));
  };
  const saveKeyframe = async () => {
    if (!selectedTrack) return;
    try { await coordinatorFor(selectedTrack).flush(); } catch (error) { if (error instanceof Error && (error as Error & { code?: string }).code === "VIDEO_TRACK_REVISION_CONFLICT") useVideoAnnotationStore.getState().preserveConflict(selectedKeyframe); setActionError("Keyframe conflict. Your local draft was retained."); }
  };
  const removeKeyframe = async () => {
    if (!selectedKeyframe || !selectedTrack) return;
    try {
      const coordinator = coordinatorFor(selectedTrack);
      coordinator.schedule((revision) => deleteVideoKeyframe(selectedKeyframe.id, revision).then((result) => { useVideoAnnotationStore.getState().markSaved(result.track); return result.track; }));
      await coordinator.flush();
      setSelectedKeyframeId(null);
    } catch { setActionError("Keyframe could not be deleted."); }
  };
  const beginGeometryDrag = (event: ReactPointerEvent<HTMLDivElement>, mode: "move" | "nw" | "ne" | "sw" | "se") => {
    if (!selectedKeyframe) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startGeometry = draftGeometry ?? selectedKeyframe.geometry;
    const start = { x: event.clientX, y: event.clientY };
    dragGeometryRef.current = startGeometry;
    const rect = (event.currentTarget.closest("[data-video-frame]") as HTMLElement | null)?.getBoundingClientRect();
    const minSize = 0.01;
    const move = (moveEvent: PointerEvent) => {
      if (!rect) return;
      const dx = (moveEvent.clientX - start.x) / rect.width;
      const dy = (moveEvent.clientY - start.y) / rect.height;
      let next = startGeometry;
      if (mode === "move") {
        next = { ...startGeometry, x: Math.min(1 - startGeometry.width, Math.max(0, startGeometry.x + dx)), y: Math.min(1 - startGeometry.height, Math.max(0, startGeometry.y + dy)) };
      } else {
        let { x, y, width, height } = startGeometry;
        if (mode.includes("e")) width = Math.min(1 - x, Math.max(minSize, startGeometry.width + dx));
        if (mode.includes("s")) height = Math.min(1 - y, Math.max(minSize, startGeometry.height + dy));
        if (mode.includes("w")) { const newX = Math.min(x + width - minSize, Math.max(0, x + dx)); width += x - newX; x = newX; }
        if (mode.includes("n")) { const newY = Math.min(y + height - minSize, Math.max(0, y + dy)); height += y - newY; y = newY; }
        next = { kind: "BOUNDING_BOX", x, y, width, height };
      }
      dragGeometryRef.current = next;
      setDraftGeometry(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const geometry = dragGeometryRef.current;
      if (geometry) void updateKeyframe({ geometry });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };
  const navigateKeyframe = (direction: -1 | 1) => {
    if (!trackKeyframes.length) return;
    const index = selectedKeyframe ? trackKeyframes.findIndex((item) => item.id === selectedKeyframe.id) : 0;
    const next = trackKeyframes[Math.min(trackKeyframes.length - 1, Math.max(0, index + direction))];
    if (next) { setSelectedKeyframeId(next.id); setCurrentTime(next.timestampMs / 1000); if (videoRef.current) videoRef.current.currentTime = next.timestampMs / 1000; }
  };

  const durationSeconds = readiness.video?.durationMs ? readiness.video.durationMs / 1000 : null;
  return <section className="canvas-grid flex min-h-[520px] min-w-0 flex-col bg-zinc-950 p-4 text-zinc-100 lg:min-h-0">
    <header className="flex items-center justify-between gap-3 pb-3 text-xs text-zinc-400">
      <span className="inline-flex items-center gap-2"><VideoCamera size={16} weight="duotone" /> VIDEO · {asset.filename}</span>
      <span>{readiness.state.replaceAll("_", " ")}</span>
    </header>
    <div data-video-frame className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl border border-zinc-800 bg-black">
      {loadState === "loading" ? <SpinnerGap className="animate-spin text-sky-400" size={28} /> : null}
      {loadState === "ready" && viewUrl ? <>
        <video ref={videoRef} className="max-h-full max-w-full" controls preload="metadata" src={viewUrl} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} />
        {selectedKeyframe && showsPersistedOverlay ? (() => {
          const geometry = draftGeometry ?? selectedKeyframe.geometry;
          const resizeCursor: Record<"nw" | "ne" | "sw" | "se", string> = { nw: "cursor-nw-resize", ne: "cursor-ne-resize", sw: "cursor-sw-resize", se: "cursor-se-resize" };
          return <div aria-label="Selected video keyframe" className="absolute border-2 border-sky-400" style={{ left: `${geometry.x * 100}%`, top: `${geometry.y * 100}%`, width: `${geometry.width * 100}%`, height: `${geometry.height * 100}%` }}>
            <div aria-label="Move keyframe" className="absolute inset-0 cursor-move" onPointerDown={(event) => beginGeometryDrag(event, "move")} />
            {(["nw", "ne", "sw", "se"] as const).map((corner) => <div key={corner} aria-label={`Resize keyframe ${corner}`} onPointerDown={(event) => beginGeometryDrag(event, corner)} className={`absolute size-2.5 rounded-full border border-sky-100 bg-sky-400 ${resizeCursor[corner]} ${corner.includes("n") ? "-top-1" : "-bottom-1"} ${corner.includes("w") ? "-left-1" : "-right-1"}`} />)}
          </div>;
        })() : null}
        {derivedPreview ? <div aria-label="Derived interpolation preview" title="Derived preview -- not saved. Use Add keyframe here to persist it." className="pointer-events-none absolute border-2 border-dashed border-violet-400" style={{ left: `${derivedPreview.x * 100}%`, top: `${derivedPreview.y * 100}%`, width: `${derivedPreview.width * 100}%`, height: `${derivedPreview.height * 100}%` }} /> : null}
      </> : null}
      {loadState === "unavailable" ? <div className="max-w-sm px-6 text-center"><p className="font-semibold">Video preview is unavailable</p><p className="mt-2 text-xs leading-5 text-zinc-400">The asset remains selectable. Processing status and metadata are available without exposing private storage details.</p></div> : null}
    </div>
    <footer className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs text-zinc-300">
      <div className="flex items-center justify-between gap-3"><span className="inline-flex items-center gap-1.5"><Play size={13} /> Timeline</span><span>{currentTime.toFixed(2)}s{durationSeconds !== null ? ` / ${durationSeconds.toFixed(2)}s` : ""}</span></div>
      <input aria-label="Video timeline" type="range" min={0} max={durationSeconds ?? 0} step={0.01} value={Math.min(currentTime, durationSeconds ?? currentTime)} disabled={!durationSeconds} onChange={(event) => { const next = Number(event.target.value); setCurrentTime(next); if (videoRef.current) videoRef.current.currentTime = next; }} className="mt-2 w-full accent-sky-500" />
      <VideoTimeline
        annotations={annotations}
        durationMs={readiness.video?.durationMs ?? null}
        currentTimeMs={currentTime * 1000}
        selectedKeyframeId={selectedKeyframeId}
        mutationState={mutationState}
        onSelectKeyframe={chooseKeyframe}
        onSelectDerived={(item) => { if (item.trackId !== selectedTrackId) selectTrack(item.trackId); seekTo(item.timestampMs); }}
        onSeek={seekTo}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2"><button type="button" onClick={() => { if (videoRef.current) videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 1 / 30); }} className="rounded border border-zinc-700 px-2 py-1 text-[11px] hover:bg-zinc-800">Previous frame</button><button type="button" onClick={() => { if (videoRef.current) videoRef.current.currentTime = Math.min(videoRef.current.duration || 0, videoRef.current.currentTime + 1 / 30); }} className="rounded border border-zinc-700 px-2 py-1 text-[11px] hover:bg-zinc-800">Next frame</button><button type="button" disabled={!trackKeyframes.length} onClick={() => navigateKeyframe(-1)} className="rounded border border-zinc-700 px-2 py-1 text-[11px] disabled:opacity-50">Previous keyframe</button><button type="button" disabled={!trackKeyframes.length} onClick={() => navigateKeyframe(1)} className="rounded border border-zinc-700 px-2 py-1 text-[11px] disabled:opacity-50">Next keyframe</button></div>
      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-400" aria-label="Video annotation summary">
        <span>{annotations.tracks.length} tracks</span>
        <span>{annotations.keyframes.length} keyframes</span>
        <span>{annotations.temporalLabels.length} temporal labels</span>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px]" aria-live="polite"><span className={mutationState === "conflict" ? "text-amber-300" : mutationState === "error" ? "text-rose-300" : mutationState === "saving" ? "text-sky-300" : "text-emerald-300"}>Save state: {selectedTrack ? (trackSaveStates[selectedTrack.id] ?? mutationState) : mutationState}</span>{localDraft ? <button type="button" onClick={() => useVideoAnnotationStore.getState().clearDraft()} className="rounded border border-amber-800 px-2 py-1 text-amber-200">Discard local draft</button> : null}</div>
      <div className="mt-3 -mx-3 -mb-2">
        <VideoToolbar
          tracks={annotations.tracks}
          selectedTrackId={selectedTrackId}
          onSelectTrack={selectTrack}
          onCreateTrack={() => void addTrack()}
          onAddKeyframeHere={() => void addKeyframe()}
          onSaveTrack={() => void updateTrack()}
          onDeleteTrack={() => void removeTrack()}
          canAddKeyframe={Boolean(selectedTrack)}
          canSaveTrack={Boolean(selectedTrack)}
          canDeleteTrack={Boolean(selectedTrack)}
          actionError={actionError}
        />
      </div>
      {selectedTrack ? <div className="mt-2 grid gap-2 rounded border border-zinc-800 p-2 text-[11px] sm:grid-cols-4" aria-label="Track properties">
        <label>Name<input value={draftName} onChange={(event) => { const name = event.target.value; setDraftName(name); coordinatorFor(selectedTrack).scheduleTrackUpdate({ name: name || undefined, labelId: draftLabelId || null, interpolationMode: draftMode }); }} className="mt-1 w-full rounded bg-zinc-800 px-2 py-1" /></label>
        <label>Label ID<input value={draftLabelId} onChange={(event) => { const labelId = event.target.value; setDraftLabelId(labelId); coordinatorFor(selectedTrack).scheduleTrackUpdate({ name: draftName || undefined, labelId: labelId || null, interpolationMode: draftMode }); }} placeholder="optional" className="mt-1 w-full rounded bg-zinc-800 px-2 py-1" /></label>
        <label>Interpolation<select value={draftMode} onChange={(event) => { const interpolationMode = event.target.value as "LINEAR" | "NONE"; setDraftMode(interpolationMode); coordinatorFor(selectedTrack).scheduleTrackUpdate({ name: draftName || undefined, labelId: draftLabelId || null, interpolationMode }); }} className="mt-1 w-full rounded bg-zinc-800 px-2 py-1"><option value="LINEAR">Linear</option><option value="NONE">None</option></select></label>
        <label>Safe properties JSON<textarea value={draftProperties} onChange={(event) => setDraftProperties(event.target.value)} onBlur={() => { try { const properties = JSON.parse(draftProperties) as Record<string, unknown>; if (!properties || Array.isArray(properties)) throw new Error("Invalid"); coordinatorFor(selectedTrack).scheduleTrackUpdate({ name: draftName || undefined, labelId: draftLabelId || null, interpolationMode: draftMode, properties }); setActionError(null); } catch { setActionError("Track properties must be a JSON object."); } }} className="mt-1 h-8 w-full rounded bg-zinc-800 px-2 py-1 font-mono text-[10px]" /></label>
      </div> : null}
      {selectedKeyframe && selectedTrack ? <div className="mt-2 grid gap-2 rounded border border-zinc-800 p-2 text-[11px] sm:grid-cols-5" aria-label="Keyframe editor">
        <label>Time (ms)<input type="number" min={0} value={draftTimestampMs ?? selectedKeyframe.timestampMs} onChange={(event) => void updateKeyframe({ timestampMs: Number(event.target.value) })} className="mt-1 w-full rounded bg-zinc-800 px-2 py-1" /></label>
        <label>X<input type="number" min={0} max={1} step="0.01" value={(draftGeometry ?? selectedKeyframe.geometry).x} onChange={(event) => void updateKeyframe({ geometry: { ...(draftGeometry ?? selectedKeyframe.geometry), x: Number(event.target.value) } })} className="mt-1 w-full rounded bg-zinc-800 px-2 py-1" /></label>
        <label>Y<input type="number" min={0} max={1} step="0.01" value={(draftGeometry ?? selectedKeyframe.geometry).y} onChange={(event) => void updateKeyframe({ geometry: { ...(draftGeometry ?? selectedKeyframe.geometry), y: Number(event.target.value) } })} className="mt-1 w-full rounded bg-zinc-800 px-2 py-1" /></label>
        <label>Width<input type="number" min={0.01} max={1} step="0.01" value={(draftGeometry ?? selectedKeyframe.geometry).width} onChange={(event) => void updateKeyframe({ geometry: { ...(draftGeometry ?? selectedKeyframe.geometry), width: Number(event.target.value) } })} className="mt-1 w-full rounded bg-zinc-800 px-2 py-1" /></label>
        <label>Height<input type="number" min={0.01} max={1} step="0.01" value={(draftGeometry ?? selectedKeyframe.geometry).height} onChange={(event) => void updateKeyframe({ geometry: { ...(draftGeometry ?? selectedKeyframe.geometry), height: Number(event.target.value) } })} className="mt-1 w-full rounded bg-zinc-800 px-2 py-1" /></label>
        <button type="button" onClick={() => void saveKeyframe()} className="rounded border border-emerald-800 px-2 py-1 text-emerald-300">Save keyframe</button><button type="button" onClick={() => void removeKeyframe()} className="rounded border border-rose-900 px-2 py-1 text-rose-300">Delete keyframe</button>
      </div> : null}
      <div className="mt-3"><VideoDetailsPanel annotations={annotations} /></div>
      <div className="mt-3"><VideoTemporalLabels labels={annotations.temporalLabels} assetId={asset.id} durationMs={readiness.video?.durationMs ?? null} /></div>
    </footer>
  </section>;
}
