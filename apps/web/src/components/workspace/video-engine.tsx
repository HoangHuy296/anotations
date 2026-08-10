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
import { addKeyframeHere, createVideoKeyframe, createVideoTrack, deleteVideoKeyframe, deleteVideoTrack, updateVideoKeyframe, updateVideoTrack } from "@/lib/workspace/video-annotation-client";

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
  const [draftName, setDraftName] = useState("");
  const [draftLabelId, setDraftLabelId] = useState<string>("");
  const [draftMode, setDraftMode] = useState<"LINEAR" | "NONE">("LINEAR");
  const [draftProperties, setDraftProperties] = useState("{}");
  const [draftGeometry, setDraftGeometry] = useState<{ kind: "BOUNDING_BOX"; x: number; y: number; width: number; height: number } | null>(null);
  const [draftTimestampMs, setDraftTimestampMs] = useState<number | null>(null);
  const dragGeometryRef = useRef<{ kind: "BOUNDING_BOX"; x: number; y: number; width: number; height: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [trackSaveStates, setTrackSaveStates] = useState<Record<string, VideoSaveState>>({});
  // A drawn-but-unsaved box, held here (never in the store) until the
  // create-annotation dialog below is resolved. "Cancel" discards it without
  // ever calling the create endpoints; "OK" is the only path that persists a
  // Track + keyframe pair.
  const [pendingBox, setPendingBox] = useState<{ geometry: { kind: "BOUNDING_BOX"; x: number; y: number; width: number; height: number }; timestampMs: number } | null>(null);
  const [pendingBoxObjectId, setPendingBoxObjectId] = useState("");
  const [pendingBoxName, setPendingBoxName] = useState("");
  const [pendingBoxError, setPendingBoxError] = useState<string | null>(null);
  const [pendingBoxSaving, setPendingBoxSaving] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackCoordinators = useRef(new Map<string, TrackAutosaveCoordinator>());
  const keyframeDraftChanges = useRef(new Map<string, KeyframeChanges>());
  const setSnapshot = useVideoAnnotationStore((state) => state.setSnapshot);
  const mutationState = useVideoAnnotationStore((state) => state.mutationState);
  const localDraft = useVideoAnnotationStore((state) => state.localDraft);
  const tool = useVideoAnnotationStore((state) => state.tool);
  const setTool = useVideoAnnotationStore((state) => state.setTool);
  // Shared with `video-properties-tabs.tsx`'s Shapes tab, not local state --
  // clicking a shape card there sets this same value, and the effect below
  // reacts by switching tracks/seeking/pausing so that click highlights the
  // box on the frame.
  const selectedKeyframeId = useVideoAnnotationStore((state) => state.selectedKeyframeId);
  const setSelectedKeyframeId = useVideoAnnotationStore((state) => state.setSelectedKeyframeId);
  const [drawDraft, setDrawDraft] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

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

  /**
   * Reacts to a keyframe selected from *outside* this component -- today
   * only the Shapes tab's shape cards -- by switching to that keyframe's
   * track (without wiping `selectedKeyframeId`, unlike `selectTrack`),
   * seeking the frame to its timestamp, and pausing, so picking a shape in
   * the panel is indistinguishable from clicking it on the frame. Driven by
   * a direct store subscription (setState inside the subscription
   * callback, not the effect body) rather than a `selectedKeyframeId`
   * dependency, since this component treats the store as the external
   * system here -- not state to resynchronize on every render.
   */
  useEffect(() => {
    return useVideoAnnotationStore.subscribe((state, previous) => {
      const id = state.selectedKeyframeId;
      if (!id || id === previous.selectedKeyframeId) return;
      const keyframe = annotations.keyframes.find((item) => item.id === id);
      if (!keyframe) return;
      if (keyframe.trackId !== selectedTrackId) {
        const nextTrack = annotations.tracks.find((item) => item.id === keyframe.trackId) ?? null;
        setSelectedTrackId(keyframe.trackId);
        setDraftName(nextTrack?.name ?? "");
        setDraftLabelId(nextTrack?.labelId ?? "");
        setDraftMode(nextTrack?.interpolationMode ?? "LINEAR");
        setDraftProperties(JSON.stringify(nextTrack?.properties ?? {}));
      }
      setDraftGeometry(keyframe.geometry);
      setDraftTimestampMs(keyframe.timestampMs);
      const seconds = Math.max(0, keyframe.timestampMs / 1000);
      setCurrentTime(seconds);
      if (videoRef.current) { videoRef.current.currentTime = seconds; videoRef.current.pause(); }
    });
  }, [annotations.keyframes, annotations.tracks, selectedTrackId]);

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
  /**
   * "box" tool: click-drag directly on the frame to draw a new keyframe,
   * mirroring IMAGE's `tool === "box"` draw gesture in `canvas-stage.tsx`.
   * Pauses the frame so the drawn box always belongs to one still frame's
   * timestamp, then hands the geometry to the create-annotation dialog
   * (`pendingBox`) instead of persisting immediately -- `confirmPendingBox`/
   * `cancelPendingBox` below are the only two paths out of that dialog.
   */
  const beginBoxDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (tool !== "box" || loadState !== "ready") return;
    videoRef.current?.pause();
    const rect = event.currentTarget.getBoundingClientRect();
    const start = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
    let latest = { x: start.x, y: start.y, width: 0, height: 0 };
    setDrawDraft(latest);
    const move = (moveEvent: PointerEvent) => {
      const px = Math.min(1, Math.max(0, (moveEvent.clientX - rect.left) / rect.width));
      const py = Math.min(1, Math.max(0, (moveEvent.clientY - rect.top) / rect.height));
      latest = { x: Math.min(start.x, px), y: Math.min(start.y, py), width: Math.abs(px - start.x), height: Math.abs(py - start.y) };
      setDrawDraft(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrawDraft(null);
      const minSize = 0.01;
      if (latest.width < minSize || latest.height < minSize) return;
      setPendingBoxError(null);
      setPendingBoxObjectId("");
      setPendingBoxName("");
      setPendingBox({ geometry: { kind: "BOUNDING_BOX", ...latest }, timestampMs: Math.round(currentTime * 1000) });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };
  /** Dialog "Cancel" -- discards the drawn box; nothing was ever persisted. */
  const cancelPendingBox = () => {
    setPendingBox(null);
    setPendingBoxObjectId("");
    setPendingBoxName("");
    setPendingBoxError(null);
    setTool("select");
  };
  /**
   * Dialog "OK" -- the only path that creates the Track + keyframe pair. The
   * user-typed Object ID and Name are written into the new keyframe's own
   * `Annotation.properties` JSON (`{ objectId, name }`), not a new column --
   * that free-form column already exists on every Annotation row for exactly
   * this ("Metadata, model provenance, confidence, notes, custom fields" per
   * `prisma/schema.prisma`), so a user-assigned shape identity never
   * required a schema change. The Track's own `name` field is still set/kept
   * in sync too, so the track dropdown (`VideoToolbar`) stays meaningful.
   */
  const confirmPendingBox = async () => {
    if (!pendingBox) return;
    setPendingBoxSaving(true);
    setPendingBoxError(null);
    try {
      let track = selectedTrack;
      if (!track) {
        const created = await createVideoTrack(asset.id, { name: pendingBoxName.trim() || `Track ${annotations.tracks.length + 1}`, interpolationMode: "LINEAR" });
        track = created.track;
        selectTrack(track.id);
      } else if (pendingBoxName.trim() && pendingBoxName.trim() !== (track.name ?? "")) {
        const renamed = await updateVideoTrack(track.id, { expectedTrackRevision: track.revision, name: pendingBoxName.trim() });
        track = renamed.track;
      }
      const keyframeProperties = Object.fromEntries(Object.entries({ objectId: pendingBoxObjectId.trim(), name: pendingBoxName.trim() }).filter(([, value]) => value !== ""));
      const coordinator = coordinatorFor(track!);
      coordinator.schedule((revision) => createVideoKeyframe(track!.id, { expectedTrackRevision: revision, timestampMs: pendingBox.timestampMs, geometry: pendingBox.geometry, properties: keyframeProperties }).then((result) => {
        useVideoAnnotationStore.getState().markSaved(result.track, result.keyframe);
        // Selecting the new keyframe is what lets a user immediately see, on
        // the frame and in the properties panel's Shapes tab, which saved
        // box this was -- labelled there by the objectId/name just entered.
        setSelectedKeyframeId(result.keyframe.id);
        return result.track;
      }));
      await coordinator.flush();
      setPendingBox(null);
      setPendingBoxObjectId("");
      setPendingBoxName("");
      setTool("select");
    } catch (error) {
      if (error instanceof Error && (error as Error & { code?: string }).code === "VIDEO_TRACK_REVISION_CONFLICT") useVideoAnnotationStore.getState().preserveConflict(selectedKeyframe ?? null);
      setPendingBoxError("This bounding box could not be saved. Try again.");
    } finally {
      setPendingBoxSaving(false);
    }
  };
  const navigateKeyframe = (direction: -1 | 1) => {
    if (!trackKeyframes.length) return;
    const index = selectedKeyframe ? trackKeyframes.findIndex((item) => item.id === selectedKeyframe.id) : 0;
    const next = trackKeyframes[Math.min(trackKeyframes.length - 1, Math.max(0, index + direction))];
    if (next) { setSelectedKeyframeId(next.id); setCurrentTime(next.timestampMs / 1000); if (videoRef.current) videoRef.current.currentTime = next.timestampMs / 1000; }
  };

  const durationSeconds = readiness.video?.durationMs ? readiness.video.durationMs / 1000 : null;
  const saveStateLabel = selectedTrack ? (trackSaveStates[selectedTrack.id] ?? mutationState) : mutationState;
  return <section className="canvas-grid flex h-full min-h-[520px] min-w-0 flex-col overflow-hidden bg-zinc-950 p-3 text-zinc-100 lg:min-h-0">
    <header className="flex items-center justify-between gap-3 pb-2 text-xs text-zinc-400">
      <span className="inline-flex items-center gap-2"><VideoCamera size={16} weight="duotone" /> VIDEO · {asset.filename}</span>
      <span className="flex items-center gap-3">
        <span className={mutationState === "conflict" ? "text-amber-300" : mutationState === "error" ? "text-rose-300" : mutationState === "saving" ? "text-sky-300" : "text-emerald-300"} aria-live="polite">{saveStateLabel}</span>
        <span>{readiness.state.replaceAll("_", " ")}</span>
      </span>
    </header>
    {/* The frame is the dominant surface -- `flex-1` claims every pixel the
       compact scrub/toolbar/details chrome below doesn't need. */}
    <div data-video-frame onPointerDown={beginBoxDraw} className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl border border-zinc-800 bg-black ${tool === "box" ? "cursor-crosshair" : ""}`}>
      {loadState === "loading" ? <SpinnerGap className="animate-spin text-sky-400" size={28} /> : null}
      {loadState === "ready" && viewUrl ? <>
        <video ref={videoRef} className="max-h-full max-w-full" controls preload="metadata" src={viewUrl} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} />
        {drawDraft ? <div aria-label="Drawing new keyframe" className="pointer-events-none absolute border-2 border-dashed border-sky-400" style={{ left: `${drawDraft.x * 100}%`, top: `${drawDraft.y * 100}%`, width: `${drawDraft.width * 100}%`, height: `${drawDraft.height * 100}%` }} /> : null}
        {pendingBox ? <div aria-label="Unsaved drawn box, pending the create-annotation dialog" className="pointer-events-none absolute border-2 border-dashed border-amber-400" style={{ left: `${pendingBox.geometry.x * 100}%`, top: `${pendingBox.geometry.y * 100}%`, width: `${pendingBox.geometry.width * 100}%`, height: `${pendingBox.geometry.height * 100}%` }} /> : null}
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
      {pendingBox ? <div role="dialog" aria-modal="true" aria-label="New bounding box annotation" className="absolute inset-0 grid place-items-center bg-black/60 p-4">
        <div className="w-full max-w-xs rounded-xl border border-zinc-700 bg-zinc-900 p-4 text-xs text-zinc-200 shadow-xl">
          <h3 className="text-sm font-bold text-white">New bounding box</h3>
          <p className="mt-1 text-[11px] leading-4 text-zinc-400">Drawn on the paused frame at {(pendingBox.timestampMs / 1000).toFixed(2)}s. Assign this shape an ID and a name, then confirm to save it as a keyframe.</p>
          <label className="mt-3 block">Object ID
            <input autoFocus value={pendingBoxObjectId} onChange={(event) => setPendingBoxObjectId(event.target.value)} placeholder="e.g. person-1" className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-zinc-100 outline-none focus:border-sky-500" />
          </label>
          <label className="mt-2 block">Name
            <input value={pendingBoxName} onChange={(event) => setPendingBoxName(event.target.value)} placeholder={selectedTrack ? (selectedTrack.name ?? "Track name") : `Track ${annotations.tracks.length + 1}`} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-zinc-100 outline-none focus:border-sky-500" />
          </label>
          {pendingBoxError ? <p role="alert" className="mt-2 text-rose-300">{pendingBoxError}</p> : null}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={cancelPendingBox} disabled={pendingBoxSaving} className="rounded-lg border border-zinc-700 px-3 py-1.5 font-semibold text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">Cancel</button>
            <button type="button" onClick={() => void confirmPendingBox()} disabled={pendingBoxSaving} className="rounded-lg bg-sky-600 px-3 py-1.5 font-semibold text-white hover:bg-sky-500 disabled:opacity-50">{pendingBoxSaving ? "Saving…" : "OK"}</button>
          </div>
        </div>
      </div> : null}
    </div>
    {/* Compact, always-visible chrome: scrub + frame/keyframe stepping,
       annotation ticks, and the simplified track toolbar. Everything else
       (track/keyframe field editors, details, temporal labels) lives in the
       collapsed drawer below so it never competes with the frame for
       height. */}
    <div className="mt-2 flex-none rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs text-zinc-300">
      <div className="flex items-center gap-2">
        <button type="button" title="Previous frame" aria-label="Previous frame" onClick={() => { if (videoRef.current) videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 1 / 30); }} className="rounded border border-zinc-700 px-1.5 py-1 text-[11px] hover:bg-zinc-800">⏮</button>
        <button type="button" title="Next frame" aria-label="Next frame" onClick={() => { if (videoRef.current) videoRef.current.currentTime = Math.min(videoRef.current.duration || 0, videoRef.current.currentTime + 1 / 30); }} className="rounded border border-zinc-700 px-1.5 py-1 text-[11px] hover:bg-zinc-800">⏭</button>
        <span className="inline-flex items-center gap-1"><Play size={12} /> {currentTime.toFixed(2)}s{durationSeconds !== null ? ` / ${durationSeconds.toFixed(2)}s` : ""}</span>
        <input aria-label="Video timeline" type="range" min={0} max={durationSeconds ?? 0} step={0.01} value={Math.min(currentTime, durationSeconds ?? currentTime)} disabled={!durationSeconds} onChange={(event) => { const next = Number(event.target.value); setCurrentTime(next); if (videoRef.current) videoRef.current.currentTime = next; }} className="ml-1 min-w-0 flex-1 accent-sky-500" />
        <button type="button" title="Previous keyframe" aria-label="Previous keyframe" disabled={!trackKeyframes.length} onClick={() => navigateKeyframe(-1)} className="rounded border border-zinc-700 px-1.5 py-1 text-[11px] disabled:opacity-50">◀KF</button>
        <button type="button" title="Next keyframe" aria-label="Next keyframe" disabled={!trackKeyframes.length} onClick={() => navigateKeyframe(1)} className="rounded border border-zinc-700 px-1.5 py-1 text-[11px] disabled:opacity-50">KF▶</button>
      </div>
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
      <div className="-mx-3 -mb-2 mt-2">
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
    </div>
    {/* Collapsed by default so field editors, the summary panel, and
       temporal labels never shrink the frame; opening it doesn't remount
       anything, so in-flight drafts/autosave state are untouched. */}
    <details className="mt-2 flex-none rounded-lg border border-zinc-800 bg-zinc-900/60 text-xs text-zinc-300">
      <summary className="cursor-pointer select-none px-3 py-2 font-semibold text-zinc-300 hover:text-white">
        Track, keyframe &amp; label details
        <span className="ml-2 font-normal text-zinc-500">{annotations.tracks.length} tracks · {annotations.keyframes.length} keyframes · {annotations.temporalLabels.length} labels</span>
      </summary>
      <div className="max-h-64 overflow-y-auto px-3 pb-3">
        {localDraft ? <div className="flex items-center gap-2 pb-2 text-[11px]"><span className="text-amber-300">Unsaved local draft preserved after a conflict.</span><button type="button" onClick={() => useVideoAnnotationStore.getState().clearDraft()} className="rounded border border-amber-800 px-2 py-1 text-amber-200">Discard local draft</button></div> : null}
        {selectedTrack ? <div className="grid gap-2 rounded border border-zinc-800 p-2 text-[11px] sm:grid-cols-4" aria-label="Track properties">
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
        <div className="mt-2"><VideoDetailsPanel annotations={annotations} /></div>
        <div className="mt-2"><VideoTemporalLabels labels={annotations.temporalLabels} assetId={asset.id} durationMs={readiness.video?.durationMs ?? null} /></div>
      </div>
    </details>
  </section>;
}
