# Implementation Plan: Video Annotation MVP

**Branch**: `019-video-annotation-mvp` | **Date**: 2026-07-29 | **Spec**: [spec.md](./spec.md)
**Update**: 2026-08-07 — adds the Shared Multi-modal Workspace Architecture
refactor as two ordered stories: User Story 7 (a shared workspace
engine/content registry, FR-041–FR-044) precedes User Story 8 (relocating
VIDEO's UI into that registry, FR-032–FR-040), so the product's long-term
multi-modal goal is served by one lookup mechanism rather than four
components each independently branching on `engine`. Correction: an earlier version of
this note claimed Phase 0–3 were fully complete per `tasks.md`; that was
inaccurate. As of this update, `tasks.md` shows US1–US3 (T001–T039) and most
of US4 (T040, T041, T043, T044) checked, but T042 and T045 (US4), all of
T046–T051 (US5), all of T052–T056 (US6), and all of T057–T061 (Polish) remain
open. The track/keyframe/temporal-label services, routes, and revision
contracts this refactor relocates UI around (FR-005–FR-030) are implemented
and exercised by passing tests regardless — the open items above are
additional race/autosave/redaction/regression *test coverage* and a small
amount of dedicated conflict-mapping code (`video-conflicts.ts`, T049, does
not exist yet; its behavior currently lives inline in `video-engine.tsx` and
`video-autosave.ts`), not missing US1–US3 functionality. This phase does not
close any of those open tasks; it only relocates existing rendered UI.
**Update**: 2026-08-11 — adds Phase 6, Interaction ownership (User Story 9,
FR-045–FR-051). Independent of and does not block on Phase 4/5's completion
state: Phase 6 touches `video-engine.tsx`'s pointer-event wiring and the
`<video>` element's attributes regardless of whether the track
toolbar/details/temporal-label UI has finished relocating into the shared
shell registry. It also corrects a Project Structure omission — VIDEO's
`PropertiesPanel` tabs already render from a dedicated
`video-properties-tabs.tsx` registry entry (not inline in `video-engine.tsx`
as earlier Phase 5 text assumed); Phase 6 does not depend on reconciling the
rest of that drift and does not attempt to.

## Summary

Implement revision-guarded manual VIDEO annotation on the existing shared
workspace. Reuse `VideoObjectTrack` and `Annotation`, add only the minimal
approved track revision/metadata schema support if the audit proves it is
missing, expose bounded safe read and mutation contracts, derive linear
bounding-box interpolation without persistence, and add a timeline-driven
Video engine with conflict-aware autosave. Manual mutations remain synchronous
PostgreSQL transactions and create no Jobs or queue deliveries.

In addition, correct the shared workspace shell so `WorkspaceEngine` is the
only component that decides layout by `asset.modality`. Today `DatasetSidebar`
and `PropertiesPanel` are hard-coded to IMAGE only, and `VideoEngine` embeds
its own track toolbar, Video Details, temporal-label list, and save-state
footer instead of using those shared surfaces. Rather than teach each of
those components its own independent `engine` branch (which would still
require editing four files for every future modality), Phase 4 first builds
one shared registry — keyed by `WorkspaceSelection.engine` — holding each
engine's component and content specifications; `WorkspaceEngine`,
`DatasetSidebar`, `PropertiesPanel`, and the shared status surface all read
from it. Phase 5 then relocates VIDEO's existing UI into that registry's
VIDEO entry. Every VIDEO API route, DTO, and revision domain (FR-005–FR-030)
stays unchanged throughout. IMAGE behavior is the regression baseline.

## Technical Context

**Language/Version**: TypeScript 5.x, Next.js App Router, React 19, Node.js 22  
**Primary Dependencies**: Prisma, PostgreSQL, Zod, existing React workspace components, react-konva where already used  
**Storage**: PostgreSQL for metadata/revisions; private MinIO for video bytes; Redis/BullMQ transport only for existing background workflows  
**Testing**: Existing Node test runner/Vitest suites, authenticated HTTP integration tests, workspace UI tests, Prisma validation, web/worker builds  
**Target Platform**: Linux Docker Compose runtime and modern desktop browsers  
**Project Type**: Next.js web application plus private worker  
**Performance Goals**: Bounded annotation responses and timeline DOM; smooth seek/overlay rendering for normal fixtures; no unbounded complete video annotation graph  
**Constraints**: Opaque-cookie auth; concealed authorization; no browser provider access; no binary proxy; exact `{ jobId }` queue payload; no manual-edit Job side effects; schema changes require separate approval  
**Scale/Scope**: One VIDEO Asset at a time, bounded tracks/keyframes/temporal labels, long-video reads via pagination or time windows; IMAGE/VIDEO/AUDIO/TEXT shared workspace remains intact; `DatasetSidebar`, `PropertiesPanel`, and the shared status surface become genuinely shared (one component branching on `WorkspaceSelection.engine`), and `WorkspaceEngine` remains the sole component switching on `asset.modality`

## Constitution Check

*GATE: Must pass before research and again after design.*

- **I. Architecture** — PASS. Uses the existing Next.js boundary, shared
  workspace route, and private worker; no public worker endpoint.
- **II. Durable state/retry lineage** — PASS. PostgreSQL owns annotation state;
  manual edits create no Job; existing BullMQ data remains `{ jobId }`.
- **III. Canonical annotation/workspace state** — PASS. Geometry remains
  canonical, revision domains are explicit, and `Asset.modality` selects the
  engine. `WorkspaceEngine` stays the only component switching on modality —
  via the shared registry (FR-041–FR-044), not an inline `switch` per
  component; `DatasetSidebar`/`PropertiesPanel`/the shared status surface stay
  single shared components that read the same registry, per spec FR-032–
  FR-040. No `ImageSidebar`/`VideoPropertiesPanel`/etc. variant is introduced.
- **IV. Private storage/security** — PASS. Video is private MinIO with a
  short-lived capability; DTOs exclude storage and credentials.
- **V. Validation/testing/phase discipline** — PASS with migration gate.
  Zod, authenticated tests, rollback/race evidence, and build validation are
  required. Any additive schema change needs explicit approval before coding.

**Post-design re-check (Phase 6, US9)** — PASS. No Prisma model, migration,
API route, revision domain, or npm dependency is added; `video-playback-
controller.ts` and the `useVideoAnnotationStore` playback slice are
client-only additions consumed exclusively by existing VIDEO components
(`video-engine.tsx`, `video-toolbar.tsx`, `video-timeline.tsx`). No public
worker endpoint is touched.

## Phase 0 — Research and audit

1. Audit the current Prisma `VideoObjectTrack`, `Annotation`, `VideoAsset`,
   `Label`, and exact enum/index definitions.
2. Audit Phase 017 annotation service, revision conflict/error mapping,
   permission matrix, concealment policy, workspace read DTOs, and route naming.
3. Confirm whether track `revision`, `annotationType`, `interpolationMode`, and
   `(trackId, timestampMs)` uniqueness/indexes can be added safely. Record
   existing-row backfill/default behavior and obtain migration approval only if
   required.
4. Confirm video view-capability and direct-MinIO browser flow, bounded media
   metadata, and current Video workspace read-only components.
5. Resolve the exact bounded read strategy: pagination or timestamp window.

## Phase 1 — Design and contracts

1. Define safe DTOs for Video Asset, track, keyframe, temporal label, derived
   interpolation, revisions, and conflict states.
2. Define strict Zod schemas for track lifecycle, keyframe lifecycle,
   temporal-label lifecycle, timestamps, normalized bounding boxes, and bounded
   custom properties.
3. Define one canonical server-side service for authorization, concealment,
   validation, transaction boundaries, revision checks, and projections.
4. Define and test the fixed API route adapters documented in
   `contracts/video-annotation-api.md` as thin wrappers over that service.
5. Define interpolation behavior for boundaries, occlusion, incompatible or
   deleted keyframes, exact timestamps, unreliable fps, and disabled mode.
6. Define timeline/UI state and autosave conflict behavior without duplicating
   server authorization logic.

## Phase 2 — Implementation slices

1. Add approved minimal track schema support and constraints only after the
   migration gate passes; preserve existing data and Phase 017 semantics.
2. Implement the shared Video annotation read service and safe DTO projection.
3. Implement atomic track lifecycle and track revision guard.
4. Implement atomic keyframe lifecycle using the track revision only.
5. Implement temporal-label lifecycle using Annotation revision only.
6. Implement shared interpolation derivation and bounded read/pagination or
   time-window behavior.
7. Connect thin authenticated route adapters and typed browser clients.
8. Extend the Video engine: playback, timeline, track/keyframe controls,
   temporal labels, interpolation preview, bounded rendering, and conflict UI.
9. Add per-resource autosave, navigation flush, reload reconciliation, and no
   forced stale retry.

## Phase 3 — Verification and closure

1. Run unit geometry/time/interpolation/projection tests.
2. Run authenticated owner/member/foreign/malformed/cross-Dataset HTTP tests.
3. Run revision races, rollback, duplicate timestamp, track deletion, and
   independent-resource concurrency tests.
4. Run Video workspace UI tests and long-video bounded-read tests.
5. Run Phase 017 image, audio, import, local-folder, and queue regressions.
6. Run Prisma validate/generate, web typecheck/lint/build, worker checks, and
   `git diff --check`.
7. Audit redaction, no-side-effect behavior, architecture, scope, and normal
   Compose restoration. Update `quickstart.md` and task evidence only from
   executed results.

## Phase 4 — Shared workspace registry (FR-041–FR-044, US7)

Precedes Phase 5. The product goal is a scalable, long-term multi-modal
platform, not a fixed four-engine special case — see spec User Story 7. This
phase builds the single lookup mechanism Phase 5 (and every future modality)
consumes, instead of teaching `DatasetSidebar`/`PropertiesPanel`/the status
surface their own independent `engine` branching.

### 4.0 Research and audit

1. Confirm `WorkspaceSelection.engine` (`src/types/workspace.ts`) is the
   correct, closed registry key — it already discriminates IMAGE/VIDEO/
   AUDIO/TEXT for `WorkspaceEngine` and needs no widening for this phase.
2. Confirm the minimal registry entry shape needed to describe today's IMAGE
   behavior exactly: an Engine component reference, a toolbox specification
   (the tool buttons `dataset-sidebar.tsx` currently hard-codes), a tabs
   specification (the tab list `properties-panel.tsx` currently hard-codes),
   and a status-fields specification (what `workspace-header.tsx` currently
   hard-codes as "Image" plus zoom/connection).
3. Confirm this stays a plain in-repo TypeScript module — no runtime/dynamic
   plugin loading, no database-backed registry, no admin UI — per spec Known
   limitations.

### 4.1 Design and contracts

1. Define `WorkspaceEngineRegistryEntry` and the registry map's type in
   `contracts/workspace-shell-contract.md`, keyed by `WorkspaceSelection.engine`.
2. Design the registry so VIDEO/AUDIO/TEXT entries can be added with
   placeholder/minimal toolbox and tabs content in this phase, then filled in
   by Phase 5 (VIDEO) without changing the entry's shape.
3. Design `WorkspaceEngine`, `DatasetSidebar`, `PropertiesPanel`, and the
   status surface's registry-consumption points so each becomes "look up
   `registry[selection.engine]`, render its fields" with no residual
   independent branching left over for Phase 5 to work around.

### 4.2 Implementation slices

1. Implement `apps/web/src/lib/workspace/workspace-engine-registry.ts`
   exporting the typed registry map.
2. Add the IMAGE entry first, reproducing current IMAGE toolbox/tabs/status
   content exactly (Engine: the existing image canvas component already
   rendered by `workspace-engine.tsx`'s IMAGE branch).
3. Add VIDEO/AUDIO/TEXT entries with their Engine component references and
   placeholder toolbox/tabs/status content (AUDIO/TEXT stay read-only
   placeholders per spec; VIDEO's real toolbox/tabs content is Phase 5's job).
4. Refactor `workspace-engine.tsx` to render `registry[selection.engine].Component`
   instead of its inline `switch`, preserving the existing "no asset
   selected" fallback.
5. Refactor `dataset-sidebar.tsx`, `properties-panel.tsx`, and
   `workspace-header.tsx` to read their engine-specific content from the
   registry entry instead of any hard-coded IMAGE-only content, with IMAGE's
   rendered output unchanged.

### 4.3 Verification and closure

1. Add a registry test proving a synthetic fifth entry renders correctly
   across all four shared surfaces with only the registry module edited, and
   that removing it removes the modality from all four surfaces (SC-011).
2. Add a test proving IMAGE's registry-sourced toolbox/tabs/status content
   matches pre-registry IMAGE behavior exactly (SC-012).
3. Re-run the existing IMAGE workspace suite unchanged; confirm green.
4. Run web typecheck/lint/build and `git diff --check`; record results in
   `quickstart.md`.

## Phase 5 — Relocate VIDEO controls into the shared shell (FR-032–FR-040, US8)

Depends on Phase 4's registry existing. Phases 0–3 above are substantially
complete — US1–US3 (T001–T039) are `[X]`, migration
`20260729000000_add_video_track_revision_contract` is applied, and the
track/keyframe/temporal-label UI this phase relocates already renders from
`video-engine.tsx` today. US4's T042/T045, all of US5 (T046–T051), all of US6
(T052–T056), and Polish (T057–T061) remain open in `tasks.md` — this phase
does not depend on them and must not close them; it only relocates
already-rendered UI into the registry entries Phase 4 created.

### 5.0 Research and audit

1. Confirm Phase 4's registry is in place and `workspace-engine.tsx`,
   `dataset-sidebar.tsx`, `properties-panel.tsx`, and `workspace-header.tsx`
   already read their content from it (with VIDEO/AUDIO/TEXT still holding
   placeholder toolbox/tabs content from Phase 4).
2. **Current implementation audit**: The VIDEO workspace does not currently
   render `VideoDetailsPanel` or `VideoTemporalLabels` directly from
   `video-engine.tsx`. The current VIDEO Properties Panel implementation is
   `apps/web/src/components/workspace/video-properties-tabs.tsx` — this
   component owns the current VIDEO right-panel tabs and renders the
   currently implemented VIDEO details, tracks, labels, shapes, description,
   assets, and related content. `VideoDetailsPanel` and `VideoTemporalLabels`
   may exist as imported/exported components, but they are not part of the
   currently rendered VIDEO workspace path. Future VIDEO PropertiesPanel work
   must extend/reconcile `video-properties-tabs.tsx` rather than assume that
   `VideoDetailsPanel` or `VideoTemporalLabels` are currently rendered by
   `video-engine.tsx`. `video-engine.tsx`'s only remaining inline surface to
   relocate is `VideoToolbar` and its inline save-state footer.
3. Confirm the exact click-to-seek contract for PropertiesPanel VIDEO
   Shapes/Tracks rows against `useVideoAnnotationStore` and `videoRef`, since
   that state currently lives inside `video-engine.tsx`.

### 5.1 Design and contracts

1. Define VIDEO's real registry entry content (toolbox: track create/select/
   save/delete, Add Keyframe Here, temporal-segment, playback tools; tabs:
   Video Details/Tracks/Labels/Shapes/Properties/Assets; status fields:
   current frame, timestamp, playback speed, latency) replacing Phase 4's
   VIDEO placeholder, in `contracts/workspace-shell-contract.md`.
2. Define how cross-component VIDEO interaction state (selected track,
   selected keyframe, seek-to-timestamp) is shared between `DatasetSidebar`/
   `PropertiesPanel` and `VideoEngine` once the toolbar and details move out
   of `VideoEngine` — via `useVideoAnnotationStore`, not new prop drilling
   through the page or the registry itself (the registry carries static
   content specifications, not live interaction state).
3. IMAGE's registry entry (from Phase 4) is the unchanged correctness
   baseline throughout this phase.

### 5.2 Implementation slices

1. Replace VIDEO's placeholder toolbox in the Phase 4 registry with its real
   content, rendered by `dataset-sidebar.tsx`'s existing registry-driven
   toolbox — no new branching logic in `dataset-sidebar.tsx` itself.
2. Replace VIDEO's placeholder tabs in the registry with Video Details/
   Tracks/Labels/Shapes/Properties/Assets, rendered by `properties-panel.tsx`'s
   existing registry-driven tab shell, sourced from `VideoDetailsPanel`'s and
   `VideoTemporalLabels`' existing logic.
3. Wire PropertiesPanel's VIDEO Shapes/Tracks row selection to seek the
   player, highlight the shape, select the track, and load properties via
   `useVideoAnnotationStore`, replacing the equivalent logic currently inline
   in `video-engine.tsx`.
4. Move `VideoToolbar` rendering (track create/select/save/delete, Add
   Keyframe Here) from `video-engine.tsx` into the registry-driven VIDEO
   toolbox from step 1, preserving the existing autosave-coordinator wiring.
5. Replace VIDEO's placeholder status fields in the registry with current
   frame, timestamp, playback speed, and latency, rendered by the status
   surface's existing registry-driven display, replacing `video-engine.tsx`'s
   inline footer.
6. Trim `video-engine.tsx` down to playback, canvas overlay, timeline, and
   direct-manipulation (drag/resize) surfaces only; delete the now-dead
   inline toolbar/details/temporal-label/footer JSX it previously owned.
7. Update the page component (`app/(app)/workspace/[datasetId]/page.tsx`) only
   if prop names change; it must keep composing the same four regions in the
   same order.

### 5.3 Verification and closure

1. Add/extend workspace UI tests asserting `DatasetSidebar`/`PropertiesPanel`/
   the status surface render the same component instance across an IMAGE→
   VIDEO navigation, and that `VideoEngine`'s rendered output contains no
   toolbar/details/temporal-label/save-state elements.
2. Re-run the full existing IMAGE workspace UI/autosave/conflict test suite
   unchanged and confirm it stays green (regression baseline).
3. Re-run the VIDEO track/keyframe/temporal-label HTTP and race tests
   unchanged and confirm they stay green (proves FR-005–FR-030 untouched).
4. Run web typecheck/lint/build and `git diff --check`.
5. Record executed results in `quickstart.md`; do not record unexecuted
   claims.

## Phase 6 — Interaction ownership (FR-045–FR-051, US9)

Independent of Phase 4/5's completion state (see Update note above). The
native `<video>` element, the annotation overlay, and the timeline/toolbar
already exist as three separate surfaces inside `video-engine.tsx`; this
phase is about which one owns which pointer/playback behavior, not about
introducing new rendering surfaces or a new video provider (spec Explicit
non-goals).

### 6.0 Research and audit

1. Audit `video-engine.tsx`'s current `<video>` element: it renders with the
   native `controls` attribute and sits directly under
   `onPointerDown={beginBoxDraw}`, which only intercepts pointer events when
   `tool === "box"`. For every other tool (`select` and friends), a pointer
   press on the frame currently reaches the native video element unguarded —
   this is the concrete violation FR-045/FR-046 close.
2. Audit `beginGeometryDrag`, `beginBoxDraw`, and the resize/move handle divs
   already rendered above the video (`"Move keyframe"`,
   `"Resize keyframe {corner}"`) — these already sit in front of the video in
   stacking order and already use `pointerdown`/pointer capture
   (`setPointerCapture`) for drag, confirming the overlay-ownership pattern
   FR-046 requires already exists for editing; it needs to be extended to
   cover every interaction path, not invented from scratch.
3. Audit `video-toolbar.tsx` and `video-timeline.tsx` for their existing
   play/pause/frame-step/seek controls and confirm which of them currently
   call `videoRef.current.play()/.pause()/.currentTime = ...` directly versus
   which already go through `video-engine.tsx`'s handlers
   (`seekTo`, `navigateKeyframe`, the frame-step buttons using a hardcoded
   `1/30` step — the concrete violation FR-048 closes, since it assumes 30fps
   instead of the Video Asset's actual fps).
4. Confirm `useVideoAnnotationStore` (`stores/video-annotation-store.ts`) as
   the existing single-store pattern for VIDEO-only client state (it already
   holds `tool`, `selectedKeyframeId`, `tracks`, `keyframes`, `requestedTab`);
   confirm it is the correct place to add a playback-state slice rather than
   introducing a second store.
5. Confirm the Video Asset's fps is already available to `video-engine.tsx`
   via `readiness.video?.fps` (or the equivalent safe-readiness field) for
   deterministic one-frame stepping.

### 6.1 Design and contracts

1. Define the interaction-ownership boundary and the shared playback
   controller's method surface in
   `contracts/video-playback-controller-contract.md`: the `<video>` element
   is renderer-only (no `controls` attribute, not a direct pointer target for
   annotation gestures); one playback controller (`play`, `pause`,
   `seekToTime`, `seekToFrame`, `nextFrame`, `previousFrame`) is the only
   thing that touches `videoRef.current` for playback purposes; the
   annotation overlay owns every annotation pointer gesture; the timeline
   owns seek/scrub only.
2. Extend `useVideoAnnotationStore` with an additive playback-state slice —
   `currentTimeMs`, `currentFrame`, `playbackState` ("paused" | "playing"),
   `fps`, `durationMs` — and playback actions that update it, without
   changing any existing field, action, or consumer (`tool`,
   `selectedKeyframeId`, `tracks`, `keyframes`, `requestedTab`,
   `mutationState`, etc. stay untouched). This is the "single source of
   truth" FR-047 requires.
3. Design a small `apps/web/src/lib/workspace/video-playback-controller.ts`
   module — a thin wrapper bound to `video-engine.tsx`'s existing `videoRef`
   — exposing `play()/pause()/seekToTime()/seekToFrame()/nextFrame()/
   previousFrame()`, each of which mutates `videoRef.current` and then writes
   the resulting snapshot into the store slice from step 2. `video-toolbar.tsx`
   and `video-timeline.tsx` call only this controller (via props/callbacks
   from `video-engine.tsx`, matching their existing callback-prop pattern) —
   neither touches `videoRef` directly, closing FR-047's "no annotation
   component calls `video.play()`/`.pause()` directly" requirement without
   adding prop-drilling through the shared shell registry.
4. Design frame-step math as `1 / fps` seconds (falling back to the existing
   safe default only when fps is missing/unreliable, per spec FR-016's
   existing fallback rule) — replacing the current hardcoded `1/30` step —
   and define the six-step frame-navigation sequence from spec FR-048 (pause
   if needed → update `video.currentTime` → update store `currentFrame` →
   recompute visible annotations/derived interpolation → update the timeline
   playhead) as one function, not scattered across button handlers.
5. Design the "begin annotation interaction" hook point: every entry to
   `beginBoxDraw`, `beginGeometryDrag`, shape selection, and (once
   polygon/circle/point/polyline exist) their create/vertex-edit gestures
   calls the controller's `pause()` first if `playbackState === "playing"`,
   before doing anything else — one shared guard, not one per gesture.
6. Design removal of the native `controls` attribute and confirm the overlay
   div (already the outer wrapper per 6.0.1) becomes the sole pointer target
   for the video area in every tool mode, not just `"box"` — clicking/
   dragging/touching that area always reaches the overlay's pointer handlers
   first; the video element itself needs no `pointer-events: none` since it
   no longer has interactive `controls` to suppress, but its z-order stays
   below the overlay.

### 6.2 Implementation slices

1. Add the playback-state slice and actions to `useVideoAnnotationStore`.
2. Add `video-playback-controller.ts` and wire it into `video-engine.tsx`
   against the existing `videoRef`.
3. Remove the `<video>` element's `controls` attribute; confirm the existing
   overlay wrapper div receives pointer events for every tool mode (not only
   `"box"`) by routing selection/drag/resize entry points through it.
4. Replace `video-toolbar.tsx`'s and `video-timeline.tsx`'s direct
   `videoRef`/`currentTime` manipulation (if any) with calls to the
   controller passed down from `video-engine.tsx`.
5. Replace the hardcoded `1/30` previous/next-frame step with the
   fps-derived one-frame step and the unified six-step navigation sequence
   from 6.1.4.
6. Add the pause-on-interaction-start guard to `beginBoxDraw` and
   `beginGeometryDrag`; confirm no code path auto-resumes playback after an
   interaction completes (spec FR-049 — the absence of a resume call is the
   implementation, not a new function).
7. Confirm "Existing track → Add keyframe here" (already implemented per
   FR-008/FR-022) is untouched by this phase: it must keep using the
   existing track and its `expectedTrackRevision` guard, never a new
   `VideoObjectTrack` (FR-051 reaffirms, does not change, this behavior).

### 6.3 Verification and closure

1. Add/extend `video-engine`/`video-toolbar`/`video-timeline` UI tests
   proving the 18 acceptance-test statements enumerated in
   `quickstart.md`'s "Planned validation — interaction ownership" section
   (native-control absence, no play/pause/seek leakage from annotation
   gestures, pause-on-interaction-start/no-auto-resume, timeline-only
   playback with no annotation side effects, exact one-frame stepping,
   mouse/touch parity, and the existing-track keyframe invariant).
2. Re-run the full existing VIDEO track/keyframe/temporal-label HTTP and
   race suites unchanged; confirm FR-005–FR-030/FR-008/FR-022 stay green
   (this phase does not touch those routes/services).
3. Re-run the full existing IMAGE workspace UI/autosave/conflict suite
   unchanged (regression baseline, unaffected by a VIDEO-only change).
4. Run web typecheck/lint/build, `git diff --check`, and confirm no new
   `package.json` dependency was introduced (spec Explicit non-goals).
5. Record executed results in `quickstart.md`; do not record unexecuted
   claims.

## Project Structure

### Documentation

```text
specs/019-video-annotation-mvp/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/video-annotation-api.md
├── contracts/workspace-shell-contract.md          # new: shared-shell registry contract
├── contracts/video-playback-controller-contract.md # new (Phase 6/US9): interaction-ownership boundary
└── checklists/requirements.md
```

### Source code

```text
apps/web/src/
├── app/(app)/workspace/[datasetId]/                 # shared route; datasetId only —
│                                                     #   selected asset is a query param
├── app/api/assets/[assetId]/video-annotations/      # thin read adapter
├── app/api/assets/[assetId]/video-object-tracks/    # thin track adapter
├── app/api/video-object-tracks/[trackId]/           # track mutation adapter
├── app/api/video-object-tracks/[trackId]/keyframes/ # keyframe create adapter
├── app/api/video-keyframes/[annotationId]/          # keyframe update/delete
├── app/api/assets/[assetId]/temporal-labels/        # temporal create adapter
├── app/api/temporal-labels/[annotationId]/         # temporal update/delete
├── src/lib/annotations/                             # shared service/projection (unchanged)
├── src/lib/validation/                              # Zod contracts (unchanged)
├── src/lib/workspace/                               # interpolation/read model (unchanged)
├── src/lib/workspace/workspace-engine-registry.ts   # new (Phase 4/US7): engine → {Component, toolbox, tabs, statusFields}
├── src/types/workspace.ts                           # WorkspaceSelection union (registry key)
├── src/components/workspace/workspace-engine.tsx    # unchanged sole render point; now reads the registry
├── src/components/workspace/dataset-sidebar.tsx     # generalized: toolbox sourced from the registry
├── src/components/workspace/properties-panel.tsx    # generalized: tabs sourced from the registry
├── src/components/workspace/workspace-header.tsx    # generalized: status fields sourced from the registry
├── src/components/workspace/video-engine.tsx        # trimmed (Phase 5/US8): playback/canvas/timeline only;
│                                                     #   Phase 6/US9: <video> loses `controls`, wires the
│                                                     #   playback controller, pause-on-interaction-start guard
├── src/components/workspace/video-toolbar.tsx        # rendered via the VIDEO registry entry now;
│                                                     #   Phase 6/US9: calls the playback controller, not videoRef
├── src/components/workspace/video-timeline.tsx       # Phase 6/US9: calls the playback controller for seek only
├── src/components/workspace/video-details-panel.tsx  # rendered via the VIDEO registry entry now
├── src/components/workspace/video-temporal-labels.tsx # rendered via the VIDEO registry entry now
├── src/components/workspace/video-properties-tabs.tsx # existing VIDEO PropertiesPanel tabs registry entry
│                                                     #   (Project Structure correction, see plan.md Update note)
├── src/stores/video-annotation-store.ts             # Phase 6/US9: additive playback-state slice
└── src/lib/workspace/video-playback-controller.ts   # new (Phase 6/US9): single play/pause/seek/frame-step authority
apps/web/tests/
├── annotations/video-annotation*.test.ts            # unchanged (data/API layer)
├── workspace/video*.test.tsx                        # extended for shell relocation and interaction ownership
├── workspace/image*.test.tsx                        # regression baseline, unchanged
└── auth-ownership/video-annotation*.test.ts          # unchanged (data/API layer)
```

**Structure Decision**: Keep the existing Next.js App Router and shared
workspace. Route handlers remain thin; server-only annotation services,
validation, projections, and interpolation live under `apps/web/src/lib`.
The private worker is not extended for manual annotation mutations. The
Phase 4 shell refactor only moves where existing VIDEO components render
(from inside `video-engine.tsx` into `dataset-sidebar.tsx`/`properties-panel.tsx`/
`workspace-header.tsx`); it does not move or rename `video-toolbar.tsx`,
`video-details-panel.tsx`, or `video-temporal-labels.tsx` themselves unless a
file move turns out to be the smaller diff during implementation.

## Complexity Tracking

| Potential exception | Why needed | Simpler alternative rejected because |
|---|---|---|
| Minimal additive `VideoObjectTrack` migration | Current model lacks the track revision and interpolation metadata required for atomic keyframe locking | Reusing `Annotation.revision` would couple unrelated keyframes and violate the approved two-domain concurrency contract |
| Bounded timeline query (pagination or time window) | Long videos cannot safely render an unbounded annotation graph | Loading every keyframe/label would create unpredictable response size and DOM cost |
| Widen `properties-panel.tsx`'s prop type from IMAGE-only `image` to a `WorkspaceSelection`-shaped discriminant | The panel cannot render Video Details/Tracks/Shapes tabs while its own type signature only accepts an image asset | Adding a second `VideoPropertiesPanel` component would recreate exactly the duplicate-shared-component problem FR-034 forbids |
| Generalize `workspace-header.tsx` into the shared status surface rather than introduce a new bottom-mounted `WorkspaceStatusBar` file | Reusing the existing header keeps one save-state source of truth (`useAnnotationStore`) and avoids a second component racing to show save state | A brand-new always-bottom status bar would duplicate `workspace-header.tsx`'s save/conflict logic instead of extending it, and gains nothing IMAGE doesn't already have today |
| A shared workspace registry module (`workspace-engine-registry.ts`), added as its own phase before the VIDEO relocation | Without it, `DatasetSidebar`/`PropertiesPanel`/the status surface would each need their own independent `engine` branching, and a fifth modality would require editing four files instead of one — FR-040 would be true only by convention | Skipping straight to per-component `switch` branches (the original Phase 4 draft) works for four known modalities but re-forks exactly the layout logic FR-034 forbids the moment a fifth is added; the registry is the one-time cost that makes FR-040 structurally true |
| A dedicated `video-playback-controller.ts` module, plus an additive playback-state slice on the existing `useVideoAnnotationStore` | FR-047 requires one single source of truth for current frame/time/playback state/fps/duration, reachable from `video-toolbar.tsx`, `video-timeline.tsx`, and every annotation-gesture entry point in `video-engine.tsx`; scattering `videoRef.current.play()/.pause()`/`currentTime=` calls across those three files is exactly what FR-047 forbids | Storing the DOM `videoRef` itself inside the Zustand store was rejected (couples global client state to a component-owned ref/SSR lifecycle); a second, separate playback store was rejected as an unnecessary second source of truth alongside the existing VIDEO store |
