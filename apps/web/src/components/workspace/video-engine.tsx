"use client";

import { SpinnerGap, VideoCamera } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { SafeMediaReadiness } from "@/types/media-processing";
import type { SafeVideoAnnotations } from "@/types/video-annotation";
import { VideoTemporalLabels } from "@/components/workspace/video-temporal-labels";
import { VideoToolbar } from "@/components/workspace/video-toolbar";
import { useVideoAnnotationStore } from "@/stores/video-annotation-store";
import { TrackAutosaveCoordinator, type VideoSaveState } from "@/lib/workspace/video-autosave";
import { addKeyframeHere, createVideoKeyframe, createVideoTrack, deleteVideoKeyframe, deleteVideoTrack, updateVideoKeyframe } from "@/lib/workspace/video-annotation-client";
import { createVideoPlaybackController, type VideoPlaybackController } from "@/lib/workspace/video-playback-controller";
import { deriveFrameIndex, resolveVideoTimelineDurationMs } from "@/lib/annotations/video-time";
import { deriveInterpolationAt } from "@/lib/annotations/video-interpolation";
import { Video } from "lucide-react";

type VideoEngineProps = {
  video: { id: string; filename: string; description: string | null };
  readiness: SafeMediaReadiness;
  annotations: SafeVideoAnnotations;
};
type KeyframeChanges = { timestampMs?: number; geometry?: { kind: "BOUNDING_BOX"; x: number; y: number; width: number; height: number } };

/**
 * Same shape as `canvas-stage.tsx`'s private `getViewUrl` for
 * `GET /api/assets/{assetId}/view-url` -- a short-lived, object-scoped MinIO
 * presigned URL. Two guards, for two different problems:
 * - `cachedViewUrls` (TTL): re-visiting the same asset shortly after
 *   shouldn't re-request a presigned URL that's still valid.
 * - `inFlightViewUrls`: React 18 Strict Mode (development, intentionally
 *   left on) double-invokes every mount effect -- switching to a video asset
 *   (e.g. clicking it in the Assets tab) mounts a fresh `VideoEngine`, and
 *   without this its mount effect below fired this fetch twice, back-to-back,
 *   before either resolved. A caller that arrives mid-flight reuses that same
 *   pending request instead of starting a second one.
 */
const VIEW_URL_CACHE_MS = 4 * 60 * 1000;
const cachedViewUrls = new Map<string, { url: string; expiresAt: number }>();
const inFlightViewUrls = new Map<string, Promise<string>>();

async function getViewUrl(assetId: string): Promise<string> {
  const cached = cachedViewUrls.get(assetId);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const inFlight = inFlightViewUrls.get(assetId);
  if (inFlight) return inFlight;
  const request = (async () => {
    const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/view-url`, { credentials: "same-origin" });
    const payload = await response.json().catch(() => null) as { data?: { viewUrl?: unknown } } | null;
    if (!response.ok || typeof payload?.data?.viewUrl !== "string") throw new Error("unavailable");
    cachedViewUrls.set(assetId, { url: payload.data.viewUrl, expiresAt: Date.now() + VIEW_URL_CACHE_MS });
    return payload.data.viewUrl;
  })();
  inFlightViewUrls.set(assetId, request);
  try { return await request; } finally { inFlightViewUrls.delete(assetId); }
}

/**
 * Read-only Phase 018 VIDEO surface. Frame/track/keyframe mutations stay
 * behind their dedicated revision-guarded contract; this component never
 * falls through to ImageCanvas or exposes a storage location.
 */
export function VideoEngine({ video, readiness, annotations }: VideoEngineProps) {
  // The Video Asset's own fps, with the existing FR-016 fallback when it's
  // missing/unreliable -- computed once here instead of re-deriving the
  // same fallback inline at every call site (frame-index math, the
  // `onTimeUpdate`/`durationchange` handlers, and the rAF playback-sync
  // loop below all need the same value).
  const fps = readiness.video?.fps && readiness.video.fps > 0 ? readiness.video.fps : 30;
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [currentTime, setCurrentTime] = useState(0);
  // Last-resort duration fallback: read directly from the `<video>`
  // element's own `durationchange` event, which the browser fires as soon
  // as it knows the media's real length -- independent of whether the
  // server-side metadata-extraction job has populated `Asset.durationMs`/
  // `VideoAsset.totalFrames` yet. Without this, a video whose server
  // metadata is missing/zero (e.g. still processing) shows no duration at
  // all: the scrub bar's `max` collapses to `0` while its `value` keeps
  // growing, so the browser silently clamps the visible thumb to the start
  // for as long as playback runs, even though the video is actually
  // advancing normally.
  const [nativeDurationMs, setNativeDurationMs] = useState<number | null>(null);
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
  // The toolbar's "Create track" button (unlike drawing a box, which always
  // implies a keyframe) creates a shape with no geometry yet -- just an
  // identity. This tiny naming dialog is that flow's own confirm/cancel
  // gate, mirroring `pendingBox` above: nothing is created until "Create".
  const [showCreateTrackDialog, setShowCreateTrackDialog] = useState(false);
  const [newTrackName, setNewTrackName] = useState("");
  const [newTrackError, setNewTrackError] = useState<string | null>(null);
  const [newTrackSaving, setNewTrackSaving] = useState(false);
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
  // Store-backed, not derived from the `annotations` prop -- the prop is the
  // server-rendered snapshot and never refetches after a mutation. Every
  // create/update/delete below writes through `markSaved`/`removeTrack`/
  // `removeKeyframe`, so these two selectors are what make a track/keyframe
  // created this session show up immediately (frame overlay, toolbar,
  // timeline), with no page reload.
  const trackList = useVideoAnnotationStore((state) => state.trackList);
  const keyframeList = useVideoAnnotationStore((state) => state.keyframeList);
  const [drawDraft, setDrawDraft] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  // The single playback authority (spec FR-047, US9) -- every play/pause/
  // seek/frame-step in this component goes through this, never a bare
  // `videoRef.current.play()/.pause()/.currentTime =` call, so
  // `video-toolbar.tsx`/future consumers can read playback state from the
  // store instead of each touching `videoRef`.
  // Built inside an effect (not during render) -- React's rules of refs
  // disallow reading `videoRef.current` while rendering, and every consumer
  // of `playbackController` below only ever runs from an event handler or
  // another effect, both safely post-render.
  const playbackControllerRef = useRef<VideoPlaybackController | null>(null);
  useEffect(() => {
    playbackControllerRef.current = createVideoPlaybackController(() => videoRef.current);
  }, []);
  const playbackController = useMemo<VideoPlaybackController>(() => ({
    play: () => playbackControllerRef.current?.play(),
    pause: () => playbackControllerRef.current?.pause(),
    seekToTime: (ms) => playbackControllerRef.current?.seekToTime(ms),
    seekToFrame: (frame) => playbackControllerRef.current?.seekToFrame(frame),
    nextFrame: () => playbackControllerRef.current?.nextFrame(),
    previousFrame: () => playbackControllerRef.current?.previousFrame(),
  }), []);
  const setPlaybackSnapshot = useVideoAnnotationStore((state) => state.setPlaybackSnapshot);
  // Mirrored from the `<video>` element's own `play`/`pause` events (see the
  // `onPlay`/`onPause` handlers below), never assumed from which
  // `playbackController` method was last called -- so this button's icon
  // stays correct even if playback stops for a reason other than this
  // button (e.g. reaching the end of the video).
  const playbackState = useVideoAnnotationStore((state) => state.playbackState);

  useEffect(() => {
    let active = true;
    void getViewUrl(video.id)
      .then((url) => { if (active) { setViewUrl(url); setLoadState("ready"); } })
      .catch(() => { if (active) setLoadState("unavailable"); });
    return () => { active = false; };
  }, [video.id]);

  useEffect(() => {
    setSnapshot(annotations.tracks, annotations.keyframes);
  }, [annotations.keyframes, annotations.tracks, setSnapshot]);
  useEffect(() => () => { void Promise.all([...trackCoordinators.current.values()].map((coordinator) => coordinator.dispose())); }, []);

  // Seeds the playback-state slice's fps/duration once known, so
  // `playbackController`'s frame-stepping uses the Video Asset's actual fps
  // (spec FR-048) as soon as it's available, without waiting for a video
  // element event.
  useEffect(() => {
    setPlaybackSnapshot({ fps: readiness.video?.fps ?? null, durationMs: resolveVideoTimelineDurationMs({ totalFrames: readiness.video?.totalFrames ?? null, fps: readiness.video?.fps ?? null, durationMs: readiness.video?.durationMs ?? null }) });
  }, [readiness.video?.fps, readiness.video?.durationMs, readiness.video?.totalFrames, setPlaybackSnapshot]);

  // Continuous playhead sync while playing. The `<video>` element's own
  // `timeupdate` event (still wired below) fires too infrequently and
  // inconsistently across browsers -- as little as 4x/second, and not on a
  // fixed schedule -- to keep the scrub input and `VideoTimeline`'s playhead
  // visibly tracking playback; both read `currentTime`, so without this loop
  // they appear frozen near the start for the entire time the video is
  // playing. This mirrors exactly what `onTimeUpdate` already does, once per
  // animation frame, only for as long as `playbackState === "playing"` (the
  // same signal the Play/Pause button reads), and stops itself the instant
  // the store reflects a pause -- including the pause that already happens
  // automatically when the video reaches the end.
  useEffect(() => {
    if (playbackState !== "playing") return;
    let frameId: number;
    const tick = () => {
      const video = videoRef.current;
      if (video) {
        const seconds = video.currentTime;
        setCurrentTime(seconds);
        setPlaybackSnapshot({ currentTimeMs: seconds * 1000, currentFrame: Math.round((seconds * 1000) / (1000 / fps)) });
      }
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [playbackState, fps, setPlaybackSnapshot]);

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
      const keyframe = keyframeList.find((item) => item.id === id);
      if (!keyframe) return;
      if (keyframe.trackId !== selectedTrackId) {
        const nextTrack = trackList.find((item) => item.id === keyframe.trackId) ?? null;
        setSelectedTrackId(keyframe.trackId);
        setDraftName(nextTrack?.name ?? "");
        setDraftLabelId(nextTrack?.labelId ?? "");
        setDraftMode(nextTrack?.interpolationMode ?? "LINEAR");
        setDraftProperties(JSON.stringify(nextTrack?.properties ?? {}));
      }
      setDraftGeometry(keyframe.geometry);
      setDraftTimestampMs(keyframe.timestampMs);
      playbackController.pause();
      playbackController.seekToTime(keyframe.timestampMs);
      setCurrentTime(Math.max(0, keyframe.timestampMs / 1000));
    });
  }, [keyframeList, trackList, selectedTrackId, playbackController]);

  const selectedTrack = trackList.find((track) => track.id === selectedTrackId) ?? null;
  const trackKeyframes = useMemo(() => selectedTrack ? keyframeList.filter((keyframe) => keyframe.trackId === selectedTrack.id).sort((a, b) => a.timestampMs - b.timestampMs) : [], [keyframeList, selectedTrack]);
  // Frame-index equality, not a fixed millisecond epsilon: "the playhead is
  // on a keyframe" means the currently displayed video frame *is* that
  // keyframe's frame, which a raw ms-difference window can miss during real
  // playback (the rAF-driven `currentTime` above advances in ~16ms ticks
  // that don't reliably land inside a narrow epsilon around any given
  // keyframe's exact timestamp).
  const currentFrameIndex = deriveFrameIndex(currentTime * 1000, fps);
  const exactKeyframeAtTime = trackKeyframes.find((keyframe) => deriveFrameIndex(keyframe.timestampMs, fps) === currentFrameIndex);
  const selectedKeyframe = trackKeyframes.find((keyframe) => keyframe.id === selectedKeyframeId) ?? exactKeyframeAtTime ?? trackKeyframes.at(-1) ?? null;
  // A persisted overlay (editable, draggable/resizable) only draws when the
  // user explicitly selected a keyframe or the playhead sits exactly on one;
  // the `.at(-1)` fallback above exists only to keep the keyframe editor form
  // populated with something, and must never masquerade as "this is the
  // current frame's geometry" in the video overlay itself.
  const showsPersistedOverlay = Boolean(selectedKeyframeId && trackKeyframes.some((keyframe) => keyframe.id === selectedKeyframeId)) || Boolean(exactKeyframeAtTime);
  // A derived preview -- never persisted, never draggable -- fills the gap
  // when the playhead sits between two keyframes on the selected track.
  // Computed live from the selected track's own persisted keyframes at the
  // current playhead position (not `annotations.interpolation`, which is
  // only ever a single server-computed sample for whatever `fromMs`/`toMs`
  // happened to be requested at page load, not a value that tracks a
  // continuously advancing `currentTime` during playback) -- this is what
  // makes the box actually appear/track smoothly between keyframes while
  // the video plays, for whichever track is currently selected.
  const derivedPreview = !showsPersistedOverlay && selectedTrack
    ? deriveInterpolationAt(trackKeyframes, currentTime * 1000, selectedTrack.interpolationMode)
    : undefined;
  const seekTo = (timestampMs: number) => {
    playbackController.seekToTime(timestampMs);
    setCurrentTime(Math.max(0, timestampMs / 1000));
  };
  const chooseKeyframe = (id: string) => {
    const keyframe = trackKeyframes.find((item) => item.id === id);
    setSelectedKeyframeId(id);
    setDraftGeometry(keyframe?.geometry ?? null);
    setDraftTimestampMs(keyframe?.timestampMs ?? null);
  };
  const selectTrack = (trackId: string) => {
    const next = trackList.find((track) => track.id === trackId) ?? null;
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
  /** Opens the naming dialog -- `confirmCreateTrack`/`cancelCreateTrack` below are its only two exits. */
  const beginCreateTrack = () => {
    setNewTrackName(`Track ${trackList.length + 1}`);
    setNewTrackError(null);
    setShowCreateTrackDialog(true);
  };
  const cancelCreateTrack = () => {
    setShowCreateTrackDialog(false);
    setNewTrackName("");
    setNewTrackError(null);
  };
  /**
   * The only path that creates a track from the toolbar. Writes the result
   * into `useVideoAnnotationStore` via `markSaved` -- the same store
   * `video-properties-tabs.tsx`'s Tracks tab reads -- so the new track card
   * appears there with no reload, then requests that tab so it's the one
   * the user actually sees it in (see `requestedTab`'s doc comment in the
   * store).
   */
  const confirmCreateTrack = async () => {
    setNewTrackSaving(true);
    setNewTrackError(null);
    try {
      const name = newTrackName.trim() || `Track ${trackList.length + 1}`;
      const result = await createVideoTrack(video.id, { name, interpolationMode: "LINEAR" });
      useVideoAnnotationStore.getState().markSaved(result.track);
      useVideoAnnotationStore.getState().setRequestedTab("tracks");
      selectTrack(result.track.id);
      setDraftName(result.track.name ?? "");
      setDraftProperties(JSON.stringify(result.track.properties ?? {}));
      setShowCreateTrackDialog(false);
      setNewTrackName("");
    } catch { setNewTrackError("Track could not be created. Reload and try again."); }
    finally { setNewTrackSaving(false); }
  };
  /**
   * `VideoToolbar`'s "Add keyframe here" -- the only way, besides drawing a
   * new box (which always creates its own track), for a track/shape to grow
   * a *second* keyframe: adds one for the already-selected track at the
   * current playhead position.
   */
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
    // Pause-on-interaction-start (spec FR-049): dragging/resizing an
    // existing keyframe must never let the frame advance mid-gesture, or
    // the geometry being edited and the frame it gets saved against can
    // silently diverge. Never auto-resumes on completion -- there is no
    // `.play()` call anywhere in this gesture's `move`/`up` handlers below.
    playbackController.pause();
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
    playbackController.pause();
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
   * Dialog "OK" -- the only path that creates a bounding box. Every draw
   * gesture is a *new* shape, so this always creates a fresh
   * `VideoObjectTrack` -- it never reuses `selectedTrack`. (Adding another
   * position for an *existing* shape across time is a distinct action --
   * `VideoToolbar`'s "Add keyframe here", which explicitly targets the
   * selected track -- and is intentionally left alone.) Reusing the
   * selected track here was the root cause of a past bug: drawing box #2
   * silently relabeled box #1, because both ended up on one shared track.
   *
   * The user-typed Object ID is written into the new track's own
   * `properties` JSON (`{ objectId }`) -- that free-form column already
   * exists on every `VideoObjectTrack` row ("Metadata, model provenance,
   * confidence, notes, custom fields" per `prisma/schema.prisma`), so a
   * user-assigned shape identity never required a schema change. Name goes
   * into the track's own `name` column, matching `VideoToolbar`'s track
   * dropdown.
   */
  const confirmPendingBox = async () => {
    if (!pendingBox) return;
    setPendingBoxSaving(true);
    setPendingBoxError(null);
    try {
      const objectId = pendingBoxObjectId.trim();
      const created = await createVideoTrack(video.id, { name: pendingBoxName.trim() || `Track ${trackList.length + 1}`, interpolationMode: "LINEAR", properties: objectId ? { objectId } : undefined });
      const track = created.track;
      selectTrack(track.id);
      const coordinator = coordinatorFor(track);
      coordinator.schedule((revision) => createVideoKeyframe(track.id, { expectedTrackRevision: revision, timestampMs: pendingBox.timestampMs, geometry: pendingBox.geometry }).then((result) => {
        useVideoAnnotationStore.getState().markSaved(result.track, result.keyframe);
        // Selecting the new keyframe is what lets a user immediately see, on
        // the frame and in the properties panel's Tracks tab, which saved
        // shape this was -- labelled there by the objectId/name just entered.
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
    if (next) { setSelectedKeyframeId(next.id); playbackController.seekToTime(next.timestampMs); setCurrentTime(next.timestampMs / 1000); }
  };

  const timelineDurationMs = resolveVideoTimelineDurationMs(readiness.video) ?? nativeDurationMs;
  const saveStateLabel = selectedTrack ? (trackSaveStates[selectedTrack.id] ?? mutationState) : mutationState;
  return <section className="canvas-grid flex h-full min-h-[520px] min-w-0 flex-col overflow-hidden bg-zinc-950 p-3 text-zinc-100 lg:min-h-0">
    <header className="flex items-center justify-between gap-3 pb-2 text-xs text-zinc-400">
      <span className="inline-flex items-center gap-2"><VideoCamera size={16} weight="duotone" /> VIDEO · {video.filename}</span>
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
        {/* Renderer only (spec FR-045): no native `controls`, so the
           annotation overlay below is the only pointer-interaction surface
           for this area -- there is no native play/pause/seek-bar/
           fullscreen UI left for a click/drag/double-click to reach.
           Playback state itself is mirrored from this element's own
           `play`/`pause` events, the one authoritative signal for whether
           playback is actually active. */}
        <video ref={videoRef} className="max-h-full max-w-full" preload="metadata" src={viewUrl} onTimeUpdate={(event) => { const seconds = event.currentTarget.currentTime; setCurrentTime(seconds); setPlaybackSnapshot({ currentTimeMs: seconds * 1000, currentFrame: Math.round((seconds * 1000) / (1000 / fps)) }); }} onDurationChange={(event) => { const duration = event.currentTarget.duration; setNativeDurationMs(Number.isFinite(duration) && duration > 0 ? duration * 1000 : null); }} onPlay={() => setPlaybackSnapshot({ playbackState: "playing" })} onPause={() => setPlaybackSnapshot({ playbackState: "paused" })} />
        {drawDraft ? <div aria-label="Drawing new keyframe" className="pointer-events-none absolute border-2 border-dashed border-sky-400" style={{ left: `${drawDraft.x * 100}%`, top: `${drawDraft.y * 100}%`, width: `${drawDraft.width * 100}%`, height: `${drawDraft.height * 100}%` }} /> : null}
        {pendingBox ? <div aria-label="Unsaved drawn box, pending the create-annotation dialog" className="pointer-events-none absolute border-2 border-dashed border-amber-400" style={{ left: `${pendingBox.geometry.x * 100}%`, top: `${pendingBox.geometry.y * 100}%`, width: `${pendingBox.geometry.width * 100}%`, height: `${pendingBox.geometry.height * 100}%` }} /> : null}
        {selectedKeyframe && showsPersistedOverlay ? (() => {
          const geometry = draftGeometry ?? selectedKeyframe.geometry;
          const resizeCursor: Record<"nw" | "ne" | "sw" | "se", string> = { nw: "cursor-nw-resize", ne: "cursor-ne-resize", sw: "cursor-sw-resize", se: "cursor-se-resize" };
          // Preserves the objectId a user typed into the create-annotation
          // dialog (stored on the Track's own `properties.objectId`, see
          // `confirmPendingBox`) as a tag anchored to the box's top-left
          // corner, so it stays identifiable on the frame after saving. The
          // tag/border color distinguishes shapes by label (falling back to
          // the previous fixed sky-blue when none is assigned) -- the tag's
          // text is always the objectId, never the label.
          const objectId = typeof selectedTrack?.properties.objectId === "string" && selectedTrack.properties.objectId ? selectedTrack.properties.objectId : null;
          const labelColor = selectedTrack?.label?.color ?? "#38bdf8";
          return <div aria-label="Selected video keyframe" className="absolute border-2" style={{ left: `${geometry.x * 100}%`, top: `${geometry.y * 100}%`, width: `${geometry.width * 100}%`, height: `${geometry.height * 100}%`, borderColor: labelColor }}>
            {objectId ? <span className="absolute -top-5 left-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold text-white" style={{ backgroundColor: labelColor }}>{objectId}</span> : null}
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
            <input value={pendingBoxName} onChange={(event) => setPendingBoxName(event.target.value)} placeholder={selectedTrack ? (selectedTrack.name ?? "Track name") : `Track ${trackList.length + 1}`} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-zinc-100 outline-none focus:border-sky-500" />
          </label>
          {pendingBoxError ? <p role="alert" className="mt-2 text-rose-300">{pendingBoxError}</p> : null}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={cancelPendingBox} disabled={pendingBoxSaving} className="rounded-lg border border-zinc-700 px-3 py-1.5 font-semibold text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">Cancel</button>
            <button type="button" onClick={() => void confirmPendingBox()} disabled={pendingBoxSaving} className="rounded-lg bg-sky-600 px-3 py-1.5 font-semibold text-white hover:bg-sky-500 disabled:opacity-50">{pendingBoxSaving ? "Saving…" : "OK"}</button>
          </div>
        </div>
      </div> : null}
      {showCreateTrackDialog ? <div role="dialog" aria-modal="true" aria-label="New track" className="absolute inset-0 grid place-items-center bg-black/60 p-4">
        <div className="w-full max-w-xs rounded-xl border border-zinc-700 bg-zinc-900 p-4 text-xs text-zinc-200 shadow-xl">
          <h3 className="text-sm font-bold text-white">New track</h3>
          <p className="mt-1 text-[11px] leading-4 text-zinc-400">A track is a shape/object identity with no position yet -- draw a box on the frame afterward, or add keyframes to it from the Tracks tab.</p>
          <label className="mt-3 block">Name
            <input autoFocus value={newTrackName} onChange={(event) => setNewTrackName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void confirmCreateTrack(); } }} placeholder={`Track ${trackList.length + 1}`} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-zinc-100 outline-none focus:border-sky-500" />
          </label>
          {newTrackError ? <p role="alert" className="mt-2 text-rose-300">{newTrackError}</p> : null}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={cancelCreateTrack} disabled={newTrackSaving} className="rounded-lg border border-zinc-700 px-3 py-1.5 font-semibold text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">Cancel</button>
            <button type="button" onClick={() => void confirmCreateTrack()} disabled={newTrackSaving} className="rounded-lg bg-sky-600 px-3 py-1.5 font-semibold text-white hover:bg-sky-500 disabled:opacity-50">{newTrackSaving ? "Creating…" : "Create"}</button>
          </div>
        </div>
      </div> : null}
    </div>
    {/* The transport/timeline zone: scrub + frame/keyframe stepping,
       annotation ticks, and track lifecycle actions all live in one
       `VideoToolbar` call -- it owns no state itself, only what's handed
       down here. Everything else (track/keyframe field editors, details,
       temporal labels) lives in the collapsed drawer below so it never
       competes with the frame for height. */}
    <VideoToolbar
      playbackState={playbackState}
      playbackDisabled={loadState !== "ready"}
      onTogglePlayback={() => { if (playbackState === "playing") playbackController.pause(); else playbackController.play(); }}
      onPreviousFrame={() => { playbackController.previousFrame(); if (videoRef.current) setCurrentTime(videoRef.current.currentTime); }}
      onNextFrame={() => { playbackController.nextFrame(); if (videoRef.current) setCurrentTime(videoRef.current.currentTime); }}
      currentTimeMs={currentTime * 1000}
      durationMs={timelineDurationMs}
      onSeek={seekTo}
      hasTrackKeyframes={trackKeyframes.length > 0}
      onPreviousKeyframe={() => navigateKeyframe(-1)}
      onNextKeyframe={() => navigateKeyframe(1)}
      annotations={{ ...annotations, keyframes: keyframeList }}
      selectedKeyframeId={selectedKeyframeId}
      mutationState={mutationState}
      onSelectKeyframe={chooseKeyframe}
      onSelectDerived={(item) => { if (item.trackId !== selectedTrackId) selectTrack(item.trackId); seekTo(item.timestampMs); }}
      tracks={trackList}
      selectedTrackId={selectedTrackId}
      onSelectTrack={selectTrack}
      onCreateTrack={beginCreateTrack}
      onAddKeyframeHere={() => void addKeyframe()}
      onSaveTrack={() => void updateTrack()}
      onDeleteTrack={() => void removeTrack()}
      canAddKeyframe={Boolean(selectedTrack)}
      canSaveTrack={Boolean(selectedTrack)}
      canDeleteTrack={Boolean(selectedTrack)}
      actionError={actionError}
    />
    {/* Collapsed by default so field editors, the summary panel, and
       temporal labels never shrink the frame; opening it doesn't remount
       anything, so in-flight drafts/autosave state are untouched. */}
    <details className="mt-2 flex-none rounded-lg border border-zinc-800 bg-zinc-900/60 text-xs text-zinc-300">
      <summary className="cursor-pointer select-none px-3 py-2 font-semibold text-zinc-300 hover:text-white">
        Track, keyframe &amp; label details
        <span className="ml-2 font-normal text-zinc-500">{trackList.length} tracks · {keyframeList.length} keyframes · {annotations.temporalLabels.length} labels</span>
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
      </div>
    </details>
  </section>;
}
