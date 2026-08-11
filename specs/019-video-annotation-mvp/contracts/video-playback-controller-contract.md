# Video Playback Controller & Interaction-Ownership Contract

This is a component-boundary contract, not an HTTP API contract. It governs
`apps/web/src/components/workspace/video-engine.tsx`,
`video-toolbar.tsx`, `video-timeline.tsx`, and
`apps/web/src/lib/workspace/video-playback-controller.ts`. It exists because
spec User Story 9 (FR-045–FR-051) requires the native `<video>` element, the
annotation overlay, and the timeline/toolbar to have non-overlapping,
structurally enforced ownership of pointer interaction and playback — not a
convention each gesture handler has to re-implement.

## The three surfaces

| Surface | Owns | Never does |
|---|---|---|
| `<video>` element | decode, render, buffer, `currentTime`, `duration`, `loadedmetadata`, playback state | Expose native `controls`; be a direct pointer target for annotation gestures; be clicked/dragged/touched to play/pause/seek/fullscreen |
| Annotation overlay (the frame wrapper `<div>` in `video-engine.tsx`, positioned above the `<video>`) | create bounding box/polygon/circle/point/polyline; select/drag/resize a shape; edit polygon/polyline vertices; drag a track keyframe's geometry | Trigger playback; seek the video; rely on `stopPropagation()` as its only defense against the video element receiving the same pointer event |
| Timeline/toolbar (`video-timeline.tsx`, `video-toolbar.tsx`) | play, pause, previous/next frame, seek/scrub, current-frame/fps/duration display | Create, move, or delete an annotation as a side effect of any playback action |

## The playback controller

`video-playback-controller.ts` exports one factory bound to `video-engine.tsx`'s
existing `videoRef`:

```ts
type VideoPlaybackController = {
  play: () => void;
  pause: () => void;
  seekToTime: (ms: number) => void;
  seekToFrame: (frame: number) => void;
  nextFrame: () => void;
  previousFrame: () => void;
};

function createVideoPlaybackController(
  videoRef: RefObject<HTMLVideoElement>,
  store: typeof useVideoAnnotationStore,
): VideoPlaybackController;
```

It is the **only** code that reads or writes `videoRef.current.play()`,
`.pause()`, or `.currentTime`. Every call updates the store's playback slice
(`currentTimeMs`, `currentFrame`, `playbackState`, `fps`, `durationMs` —
see `data-model.md`) so `video-toolbar.tsx` and `video-timeline.tsx` render
from that slice instead of reading `videoRef` themselves.

`nextFrame()`/`previousFrame()` step by exactly `1 / fps` seconds (the
existing FR-016 fallback rule applies when fps is missing/unreliable — never
an arbitrary fixed millisecond constant) and perform this exact sequence as
one unit: pause if playing → update `video.currentTime` → update the store's
`currentFrame` → the visible-annotations/derived-interpolation computation
(already driven by `currentTime` in `video-engine.tsx`) recomputes → the
timeline playhead (already driven by the same state) re-renders.

## The pause-on-interaction-start rule

Every annotation-gesture entry point (`beginBoxDraw`, `beginGeometryDrag`,
shape selection, and future polygon/circle/point/polyline create/vertex-edit
handlers) calls `controller.pause()` first, before doing anything else, if
`playbackState === "playing"`. Completing the gesture never calls
`controller.play()` — the absence of an auto-resume call is the contract, not
an omission to fix later.

## The existing-track invariant (reaffirmed, not modified)

"Existing track → Add keyframe here" continues to use
`video-annotation-client.ts`'s existing `addKeyframeHere`/`createVideoKeyframe`
call against the already-selected track's `expectedTrackRevision`
(FR-008/FR-022). This contract does not change that call, its request shape,
or its revision domain — it only guarantees the *pointer gesture* that
triggers it (a toolbar button, not a frame draw) never falls through this
contract's ownership rules to accidentally toggle playback or seek.

## Non-goals

- No new `<video>`-alternative dependency (Video.js, Plyr, or similar) —
  see spec Explicit non-goals.
- No new Prisma model, API route, or revision domain.
- No change to `useVideoAnnotationStore`'s existing fields
  (`tool`, `selectedKeyframeId`, `tracks`, `keyframes`, `requestedTab`,
  `mutationState`, etc.) — the playback slice is additive only.
