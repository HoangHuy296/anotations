# Tasks: Video Annotation MVP

**Input**: Design documents from `/specs/019-video-annotation-mvp/`.

## Phase 1: Setup

- [X] T001 Audit `prisma/schema.prisma` for VideoObjectTrack, VideoAsset, Annotation, Label, enum, index, and relation definitions
- [X] T002 Audit Phase 017 annotation services, revision errors, permissions, concealment policy, workspace reads, and API conventions in `apps/web/src/lib/` and `specs/017-annotation-api-foundation/`
- [X] T003 [P] Record migration/backfill requirements for missing track revision, annotation type, interpolation mode, and keyframe timestamp uniqueness in `specs/019-video-annotation-mvp/research.md`
- [X] T004 [P] Verify private VIDEO view-capability and direct-MinIO browser flow in `apps/web/src/lib/storage/` and existing workspace tests
- [X] T005 [P] Verify controlled Compose prerequisites and package test commands in `specs/019-video-annotation-mvp/quickstart.md`

## Phase 2: Foundational

- [X] T006 Define safe track, keyframe, temporal-label, interpolation, and conflict DTOs in `apps/web/src/types/video-annotation.ts`
- [X] T007 Define strict Zod schemas for lifecycle requests, normalized BOUNDING_BOX geometry, timestamps, intervals, revisions, and bounded properties in `apps/web/src/lib/validation/video-annotation.ts`
- [X] T008 [P] Define stable safe error codes for revision conflicts, unsupported modality, duplicate timestamps, invalid ranges, and bounded requests in `apps/web/src/lib/annotations/video-errors.ts`
- [X] T009 Implement server-only VIDEO Asset, track, keyframe, temporal-label, and same-Dataset Label authorization/concealment helpers in `apps/web/src/lib/annotations/video-authorization.ts`
- [X] T010 Implement safe DTO projections excluding storage, provider, credential, queue, lock, and raw Prisma fields in `apps/web/src/lib/annotations/video-projection.ts`
- [X] T011 Implement timestamp validation and deterministic display frameIndex derivation for reliable fps in `apps/web/src/lib/annotations/video-time.ts`
- [X] T012 Implement deterministic linear interpolation and boundary policy in `apps/web/src/lib/annotations/video-interpolation.ts`
- [X] T013 Define bounded tracks/keyframes/temporal-label read limits and pagination or time-window parameters in `apps/web/src/lib/annotations/video-limits.ts`
- [X] T014 Add foundational geometry, time, interpolation, projection, and limit tests in `apps/web/tests/annotation-api/video-foundation.test.ts`
- [X] T015 Apply the approved additive Prisma migration/model/index changes in `prisma/schema.prisma` and `prisma/migrations/` after the green live-data audit

## Phase 3: User Story 1 — Inspect a private video (Priority: P1)

**Goal**: Safely read and play a VIDEO Asset with bounded tracks, keyframes, temporal labels, and derived interpolation.

**Independent Test**: Normal login owner/member opens a private VIDEO Asset, loads direct MinIO bytes, sees safe read DTOs, and foreign/malformed requests are concealed.

- [X] T016 [P] [US1] Add authenticated owner/member/ADMIN/foreign/unknown/malformed/cross-Dataset read tests in `apps/web/tests/auth-ownership/video-annotation-read.test.ts`
- [X] T017 [P] [US1] Add empty-read, bounded-query, safe frameIndex, interpolation, and redaction tests in `apps/web/tests/annotations/video-read-model.test.ts`
- [X] T018 [P] [US1] Add direct-MinIO capability, playback, seek, timeline, and no-proxy workspace tests in `apps/web/tests/workspace/video-engine-read.test.ts`
- [X] T019 [US1] Implement shared server-only bounded Video annotation read service in `apps/web/src/lib/annotations/video-read-service.ts`
- [X] T020 [US1] Implement thin authenticated GET /api/assets/[assetId]/video-annotations adapter in `apps/web/src/app/api/assets/[assetId]/video-annotations/route.ts`
- [X] T021 [US1] Wire modality selection and safe Video read DTOs through the shared workspace route in `apps/web/src/components/workspace/workspace-engine.tsx` and `apps/web/src/app/(app)/workspace/[datasetId]/[assetId]/page.tsx`
- [X] T022 [US1] Extend Video playback, seek, safe metadata, persisted resources, and bounded timeline rendering in `apps/web/src/components/workspace/video-engine.tsx`
- [X] T023 [US1] Add safe Video details, track/keyframe lists, temporal-label list, and bounded timeline components in `apps/web/src/components/workspace/video-details-panel.tsx` and `apps/web/src/components/workspace/video-timeline.tsx`

## Phase 4: User Story 2 — Create and edit an object track (Priority: P1)

**Goal**: Create, edit, relabel, delete tracks, and persist bounding-box keyframes using VideoObjectTrack.revision.

**Independent Test**: Authenticated HTTP creates a track and keyframes, edits and deletes them, and proves atomic ownership and revision behavior.

- [X] T024 [P] [US2] Add track lifecycle contract tests in `apps/web/tests/annotations/video-track-contract.test.ts`
- [X] T025 [P] [US2] Add keyframe lifecycle, geometry, timestamp, duplicate, and delete tests in `apps/web/tests/annotations/video-keyframe-contract.test.ts`
- [X] T026 [P] [US2] Add owner/member/foreign/non-member/cross-Asset/cross-Dataset/no-side-effect HTTP tests in `apps/web/tests/auth-ownership/video-track-keyframe.test.ts`
- [X] T027 [P] [US2] Add atomic rollback and stale track-revision races in `apps/web/tests/annotations/video-track-race.test.ts` (existing race-test file; task named `video-track-revision-race.test.ts`, but this file already covers the same scope and is the ledger's recognized evidence source, so it was extended rather than duplicated)
- [X] T028 [US2] Implement atomic track create/update/relabel/delete service and controlled keyframe deletion in `apps/web/src/lib/annotations/video-track-service.ts`
- [X] T029 [US2] Implement atomic keyframe create/update/delete service using only expected track revision in `apps/web/src/lib/annotations/video-keyframe-service.ts`
- [X] T030 [US2] Implement thin track route adapters in `apps/web/src/app/api/assets/[assetId]/video-object-tracks/route.ts` and `apps/web/src/app/api/video-object-tracks/[trackId]/route.ts`
- [X] T031 [US2] Implement thin keyframe route adapters in `apps/web/src/app/api/video-object-tracks/[trackId]/keyframes/route.ts` and `apps/web/src/app/api/video-keyframes/[annotationId]/route.ts`
- [X] T032 [US2] Add typed browser clients and revision-aware mutation state in `apps/web/src/lib/workspace/video-annotation-client.ts` and `apps/web/src/stores/video-annotation-store.ts`
- [X] T033 [US2] Add track creation, selection, bounding-box draw/move/resize, timestamp update, and delete controls in `apps/web/src/components/workspace/video-engine.tsx` and `apps/web/src/components/workspace/video-toolbar.tsx`

## Phase 5: User Story 3 — Derive and commit interpolation (Priority: P1)

**Goal**: Display deterministic interpolation and explicitly persist a new keyframe from an interpolated position.

**Independent Test**: Two keyframes produce expected intermediate geometry; Add Keyframe Here creates one durable row and reload preserves it.

- [X] T034 [P] [US3] Add interpolation endpoint, boundary, disabled-mode, and no-persisted-row tests in `apps/web/tests/annotations/video-interpolation.test.ts`
- [X] T035 [P] [US3] Add authenticated Add Keyframe Here and duplicate timestamp tests in `apps/web/tests/annotations/video-interpolation-http.test.ts`
- [X] T036 [P] [US3] Add workspace tests distinguishing persisted, derived, draft, saved, and conflict states in `apps/web/tests/workspace/video-interpolation.vitest.spec.ts` (project has no DOM-rendering test harness -- no jsdom/`@testing-library/react`, and AGENTS.md requires explicit permission before adding one -- so this follows the established sibling pattern, `video-autosave.vitest.spec.ts`/`video-temporal-boundary.vitest.spec.ts`, of exercising the pure display-state logic and Zustand store directly rather than a rendered `.tsx` tree)
- [X] T037 [US3] Integrate interpolation into the bounded read service and safe projection in `apps/web/src/lib/annotations/video-read-service.ts` and `apps/web/src/lib/annotations/video-interpolation.ts`
- [X] T038 [US3] Implement Add Keyframe Here with active expected track revision in `apps/web/src/lib/annotations/video-keyframe-service.ts` and `apps/web/src/lib/workspace/video-annotation-client.ts`
- [X] T039 [US3] Render persisted markers, derived overlays, exact timestamp selection, and bounded intervals in `apps/web/src/components/workspace/video-timeline.tsx` and `apps/web/src/components/workspace/video-engine.tsx`

## Phase 6: User Story 4 — Create and edit temporal labels (Priority: P2)

**Goal**: Persist EVENT, SCENE, and SHOT_BOUNDARY intervals using independent Annotation.revision values.

**Independent Test**: Authenticated HTTP creates, edits, relabels, deletes, and reloads each approved temporal type with duration and Label validation.

- [X] T040 [P] [US4] Add temporal-label create/update/move/resize/relabel/delete contract tests in `apps/web/tests/annotations/video-temporal-label-contract.test.ts`
- [X] T041 [P] [US4] Add temporal-label revision race and independent-label tests in `apps/web/tests/annotations/video-temporal-label-revision.test.ts`
- [ ] T042 [P] [US4] Add temporal authorization, cross-Dataset Label, non-VIDEO, malformed, unknown, and no-side-effect tests in `apps/web/tests/auth-ownership/video-temporal-label.test.ts`
- [X] T043 [US4] Implement atomic temporal-label service using Annotation revision and VideoAsset duration checks in `apps/web/src/lib/annotations/video-temporal-label-service.ts`
- [X] T044 [US4] Implement thin temporal-label route adapters in `apps/web/src/app/api/assets/[assetId]/temporal-labels/route.ts` and `apps/web/src/app/api/temporal-labels/[annotationId]/route.ts`
- [ ] T045 [US4] Add timeline temporal segments, draggable boundaries, selection, relabel, and delete UI in `apps/web/src/components/workspace/video-temporal-labels.tsx` and `apps/web/src/components/workspace/video-timeline.tsx`

## Phase 7: User Story 5 — Recover safely from concurrent edits (Priority: P1)

**Goal**: Make track/keyframe and temporal-label conflicts visible without silently overwriting newer state.

**Independent Test**: Concurrent writes yield exactly one winner per revision domain, preserve local drafts, and never force-retry stale writes.

- [ ] T046 [P] [US5] Add concurrent keyframe/track metadata/delete races in `apps/web/tests/annotations/video-concurrency.test.ts`
- [ ] T047 [P] [US5] Add independent Track A/Track B and temporal-label concurrency tests in `apps/web/tests/annotations/video-independent-concurrency.test.ts`
- [ ] T048 [P] [US5] Add stale conflict, concealment, and response-redaction tests in `apps/web/tests/auth-ownership/video-conflict.test.ts`
- [ ] T049 [US5] Implement shared conflict mapping and guarded-write reconciliation in `apps/web/src/lib/annotations/video-conflicts.ts` and existing video mutation services
- [ ] T050 [US5] Add conflict, reload-server-state, preserve-local-draft, and no-force-retry UI in `apps/web/src/components/workspace/save-conflict-panel.tsx` and `apps/web/src/components/workspace/video-engine.tsx`
- [ ] T051 [US5] Add stale-response protection and independent revision state in `apps/web/src/stores/video-annotation-store.ts`

## Phase 8: User Story 6 — Autosave and navigate (Priority: P2)

**Goal**: Autosave per durable resource, flush navigation, and reload state.

**Independent Test**: Edit a track and temporal label, wait for autosave, navigate/reload, and verify persistence and conflict indicators.

- [ ] T052 [P] [US6] Add 1.5-second autosave, one-in-flight, later-edit, navigation-flush, and reload tests in `apps/web/tests/workspace/video-autosave.test.tsx`
- [ ] T053 [P] [US6] Add autosave authorization, stale conflict, and no-side-effect HTTP tests in `apps/web/tests/auth-ownership/video-autosave.test.ts`
- [ ] T054 [US6] Implement per-resource autosave and navigation flush in `apps/web/src/lib/workspace/video-autosave.ts`
- [ ] T055 [US6] Integrate autosave statuses, conflict, error, and reload reconciliation in `apps/web/src/stores/video-annotation-store.ts` and `apps/web/src/components/workspace/video-engine.tsx`
- [ ] T056 [US6] Add previous/next keyframe navigation and bounded timeline window/pagination in `apps/web/src/components/workspace/video-timeline.tsx` and `apps/web/src/lib/annotations/video-read-service.ts`

## Phase 9: Polish and cross-cutting validation

- [ ] T057 [P] Add HTTP, event, UI, Prisma projection, and safe-error redaction audit in `apps/web/tests/annotations/video-redaction.test.ts`
- [ ] T058 [P] Add regressions for Image Phase 017 revision, Audio, repository/local-folder isolation, no manual Job, and exact queue payload in `apps/web/tests/regression/video-phase-regressions.test.ts`
- [ ] T059 [P] Add long-video bounded-read and timeline DOM-size tests in `apps/web/tests/workspace/video-bounded-read.test.tsx`
- [ ] T060 Run Prisma validate/generate, web typecheck/lint/build, worker typecheck/build, focused Phase 019 tests, existing workspace/import/queue regressions, and `git diff --check`; record exact results in `specs/019-video-annotation-mvp/quickstart.md`
- [ ] T061 Complete architecture/scope audit and record normal Compose restoration, migration status, redaction, authorization, and known limitations in `specs/019-video-annotation-mvp/quickstart.md`

## Phase 10: User Story 7 — Shared workspace engine/content registry (Priority: P1)

**Goal**: Build one registry, keyed by `WorkspaceSelection.engine`, holding
each engine's component and its `DatasetSidebar` toolbox, `PropertiesPanel`
tabs, and status-field specifications. `WorkspaceEngine`, `DatasetSidebar`,
`PropertiesPanel`, and the shared status surface (`workspace-header.tsx`)
each read from it instead of independently branching on `engine`. This is
the mechanism a long-term multi-modal platform needs: a future fifth
modality becomes one registry entry, not four file edits. Maps to `plan.md`
Phase 4 / spec FR-041–FR-044.

**Independent Test**: Add one synthetic registry entry (stub Engine
component, toolbox, tabs, status fields). Confirm `WorkspaceEngine`,
`DatasetSidebar`, `PropertiesPanel`, and the shared status surface each
render it correctly with zero changes to their own source beyond the
registry lookup already wired in. Remove the entry and confirm IMAGE/VIDEO/
AUDIO/TEXT behavior is unchanged; IMAGE's own registry-sourced content must
match its pre-registry behavior exactly.

- [X] T062 [P] [US7] Add a registry unit test proving a synthetic fifth entry renders correctly across all four consuming lookups and that removing it removes the modality cleanly, in `apps/web/tests/workspace/workspace-engine-registry.vitest.spec.ts`
- [X] T063 [P] [US7] Add a structural boundary test asserting `workspace-engine.tsx`, `dataset-sidebar.tsx`, `properties-panel.tsx`, and `workspace-header.tsx` each contain at most one `workspaceEngineRegistry[...]` lookup and no independent `switch`/`if` keyed on `engine`/`asset.modality` beyond it, in `apps/web/tests/workspace/workspace-shell-boundary.test.ts` (source-text assertions via `node:test` + `node:fs`, matching this repo's no-jsdom convention — no rendering harness is added)
- [X] T064 [US7] Define `WorkspaceEngineRegistryEntry` (`Component`, `toolbox`, `tabs`, `statusFields`) and the `Record<WorkspaceSelection["engine"], WorkspaceEngineRegistryEntry>` type in `apps/web/src/lib/workspace/workspace-engine-registry.ts`, per `contracts/workspace-shell-contract.md`
- [X] T065 [US7] Add the IMAGE registry entry reproducing current IMAGE toolbox (select/pan/bounding-box/polygon/circle/point/polyline)/tabs (Details/Labels/Shapes/Assets)/status fields (zoom, connection) exactly, in `apps/web/src/lib/workspace/workspace-engine-registry.ts`
- [X] T066 [US7] Add VIDEO/AUDIO/TEXT registry entries with their Engine component references and placeholder toolbox/tabs/status-field content (real VIDEO content is added in Phase 11; AUDIO/TEXT stay read-only placeholders), in `apps/web/src/lib/workspace/workspace-engine-registry.ts`
- [X] T067 [US7] Refactor `workspace-engine.tsx` to render `workspaceEngineRegistry[selection.engine].Component` instead of its inline `switch`, preserving the existing "no asset selected" fallback
- [X] T068 [US7] Refactor `dataset-sidebar.tsx` to render `workspaceEngineRegistry[engine].toolbox` instead of its hard-coded IMAGE-only tool buttons, with IMAGE's rendered output unchanged; dataset/asset navigation and open-directory controls stay outside the registry lookup
- [X] T069 [US7] Refactor `properties-panel.tsx` to accept `WorkspaceSelection` (or an equivalent discriminated prop) and render `workspaceEngineRegistry[engine].tabs` instead of its IMAGE-only `image` prop and hard-coded tabs, with IMAGE's rendered output unchanged
- [X] T070 [US7] Refactor `workspace-header.tsx` into the shared status surface: keep the existing save/dirty/conflict display, and render `workspaceEngineRegistry[engine].statusFields` instead of the hard-coded "Image" badge, with IMAGE's rendered output unchanged
- [X] T071 [US7] Update `apps/web/src/app/(app)/workspace/[datasetId]/page.tsx` prop wiring only if `DatasetSidebar`/`PropertiesPanel` prop names changed in T068–T070; the page must keep composing the same four regions in the same order
- [X] T072 [US7] Re-run the full existing IMAGE workspace test suite unchanged and confirm it stays green as the regression baseline; record the exact result in `specs/019-video-annotation-mvp/quickstart.md`
- [X] T073 [US7] Run web typecheck/lint/build and `git diff --check`; record exact results in `specs/019-video-annotation-mvp/quickstart.md`

## Phase 11: User Story 8 — Relocate VIDEO controls into the shared shell (Priority: P1)

**Goal**: Depends on Phase 10's registry. Replace VIDEO's placeholder
registry entry (T066) with its real toolbox/tabs/status content, so
`VideoEngine` is trimmed to rendering/interaction only and `DatasetSidebar`/
`PropertiesPanel`/the shared status surface show VIDEO's track toolbar,
Video Details, temporal-label list, and save state through the registry-
driven rendering Phase 10 already built. No VIDEO API route, DTO, or revision
domain (FR-005–FR-030) changes. Maps to `plan.md` Phase 5 / spec FR-032–FR-040.

**Independent Test**: Open an IMAGE Asset, then a VIDEO Asset, in the same
Dataset session. `DatasetSidebar`/`PropertiesPanel`/the shared status surface
keep the same component identity while only their registry-sourced content
and `WorkspaceEngine`'s child change; `VideoEngine` no longer renders track
toolbar, Video Details, temporal-label, or save-state chrome.

- [ ] T074 [P] [US8] Extend `workspace-shell-content.vitest.spec.ts` (or add `apps/web/tests/workspace/workspace-shell-video-content.vitest.spec.ts`) asserting VIDEO's registry entry now matches spec FR-035–FR-037 content (toolbox includes track create/select/save/delete + Add Keyframe Here + temporal-segment + playback; tabs include Video Details/Tracks/Labels/Shapes/Properties/Assets; status fields include current frame/timestamp/playback speed/latency), replacing Phase 10's placeholder assertions
- [ ] T075 [P] [US8] Extend `workspace-shell-boundary.test.ts` asserting `video-engine.tsx` no longer imports `VideoToolbar`, `VideoDetailsPanel`, or `VideoTemporalLabels`
- [ ] T076 [US8] Replace VIDEO's placeholder toolbox in `workspace-engine-registry.ts` with real content, and move `VideoToolbar` (track create/select/save/delete, Add Keyframe Here) rendering into `dataset-sidebar.tsx`'s registry-driven toolbox output, preserving the existing autosave-coordinator wiring currently in `video-engine.tsx`
- [ ] T077 [US8] Reconcile VIDEO PropertiesPanel with the shared PropertiesPanel architecture by using the existing `video-properties-tabs.tsx` implementation as the VIDEO-specific content body (already wired via `workspace-engine-registry.ts`'s `Tabs` entry); preserve the currently implemented VIDEO tabs and behavior, add or integrate any newly required VIDEO-specific panel content (e.g. temporal labels) through `video-properties-tabs.tsx` rather than introducing a second standalone VIDEO sidebar, do not duplicate the VIDEO PropertiesPanel implementation, and do not move currently unrendered components (`VideoDetailsPanel`, `VideoTemporalLabels`) into the active render path unless explicitly required by the corresponding functional requirement
- [X] T078 [US8] Wire PropertiesPanel's VIDEO Shapes/Tracks row selection to seek the player, highlight the shape, select the track, and load properties via `useVideoAnnotationStore`, replacing the equivalent logic currently inline in `video-engine.tsx`
- [ ] T079 [US8] Replace VIDEO's placeholder status fields in `workspace-engine-registry.ts` with current frame, timestamp, playback speed, and latency, sourced from state currently read inside `video-engine.tsx`
- [ ] T080 [US8] Trim `video-engine.tsx` to playback, canvas overlay, timeline, and drag/resize interaction only; delete the now-relocated inline `VideoToolbar`, `VideoDetailsPanel`, `VideoTemporalLabels`, and save-state footer JSX (depends on T076–T079 having taken over that rendering)
- [ ] T081 [US8] Update `apps/web/src/app/(app)/workspace/[datasetId]/page.tsx` prop wiring only if required by T076–T080; the page must keep composing the same four regions in the same order
- [ ] T082 [US8] Re-run the full existing IMAGE workspace test suite unchanged and confirm it stays green as the regression baseline; record the exact result in `specs/019-video-annotation-mvp/quickstart.md`
- [ ] T083 [US8] Re-run the existing VIDEO track/keyframe/temporal-label HTTP and race tests unchanged and confirm they stay green, proving FR-005–FR-030 were not altered by the relocation; record the exact result in `specs/019-video-annotation-mvp/quickstart.md`
- [ ] T084 [US8] Run Prisma validate/generate (no schema change expected), web typecheck/lint/build, and `git diff --check`; record exact results in `specs/019-video-annotation-mvp/quickstart.md`

## Phase 12: User Story 9 — Interaction ownership separates rendering, annotation editing, and playback control (Priority: P1)

**Goal**: Separate three surfaces that already exist inside `video-engine.tsx`
by pointer/playback ownership: the native `<video>` element becomes
renderer-only (no `controls`, never a direct pointer target for annotation
gestures), the annotation overlay owns every annotation pointer gesture in
every tool mode, and the timeline/toolbar owns playback/frame navigation
exclusively through one new playback controller. Independent of US7/US8's
completion state — this touches `video-engine.tsx`'s pointer-event wiring and
the `<video>` element's attributes regardless of whether the shared-shell
relocation has finished. No VIDEO API route, DTO, revision domain, Prisma
model, or npm dependency changes. Maps to `plan.md` Phase 6 / spec
FR-045–FR-051.

**Independent Test**: While playback is active, press-and-drag to draw a
bounding box; assert playback pauses at drag start, the frame does not
advance during the drag, the keyframe saves against that exact frame, and
playback does not resume on its own. Assert clicking/double-clicking/
touch-tapping the video surface never toggles native play/pause or triggers
native fullscreen, and that dragging the timeline never creates or edits an
annotation. Assert "Existing track → Add keyframe here" still creates exactly
one keyframe on the existing `VideoObjectTrack`, never a new track.

- [X] T085 [P] [US9] Add `video-playback-controller.ts` unit tests proving one single source of truth (`currentTimeMs`/`currentFrame`/`playbackState`/`fps`/`durationMs`), `play`/`pause`/`seekToTime`/`seekToFrame`/`nextFrame`/`previousFrame` behavior, and fps-derived one-frame stepping (not a fixed millisecond constant, with the existing FR-016 fallback when fps is missing/unreliable) in `apps/web/tests/workspace/video-playback-controller.vitest.spec.ts`
- [X] T086 [P] [US9] Add interaction-ownership tests proving clicking/double-clicking/dragging/touching the video surface never toggles native play/pause or triggers native fullscreen; drawing/selecting/dragging/resizing a shape never seeks or toggles playback; beginning an annotation interaction pauses active playback and completing it leaves playback paused with no auto-resume; and mouse/touch input follow identical ownership rules, in `apps/web/tests/workspace/video-interaction-ownership.vitest.spec.ts` (pure logic/store assertions, matching this repo's no-jsdom convention per T036/T063)
- [X] T087 [P] [US9] Extend `apps/web/tests/workspace/workspace-shell-boundary.test.ts` (or add `apps/web/tests/workspace/video-timeline-ownership.test.ts`) asserting `video-toolbar.tsx` and `video-timeline.tsx` contain no direct `videoRef`/`.currentTime`/`.play()`/`.pause()` access (source-text assertions, matching T063's pattern), and that timeline seek/scrub updates `currentFrame` without creating, moving, or deleting an annotation
- [X] T088 [US9] Add the additive playback-state slice (`currentTimeMs`, `currentFrame`, `playbackState`, `fps`, `durationMs`) and its setters to `apps/web/src/stores/video-annotation-store.ts` without altering any existing field, action, or consumer (`tool`, `selectedKeyframeId`, `tracks`, `keyframes`, `requestedTab`, `mutationState`, etc.)
- [X] T089 [US9] Implement `apps/web/src/lib/workspace/video-playback-controller.ts` (`play`, `pause`, `seekToTime`, `seekToFrame`, `nextFrame`, `previousFrame`) bound to `video-engine.tsx`'s existing `videoRef`, writing every result into T088's store slice; `nextFrame`/`previousFrame` step by `1 / fps` seconds with the FR-016 fallback, per `contracts/video-playback-controller-contract.md`
- [X] T090 [US9] Remove the `<video>` element's `controls` attribute and make the existing annotation-overlay frame wrapper the pointer target for every tool mode (not only `"box"`) in `apps/web/src/components/workspace/video-engine.tsx`
- [X] T091 [US9] Add the pause-on-interaction-start guard to `beginBoxDraw`, `beginGeometryDrag`, and shape selection — call `controller.pause()` first when `playbackState === "playing"` — and confirm no code path calls `controller.play()` on interaction completion, in `apps/web/src/components/workspace/video-engine.tsx`
- [X] T092 [US9] Route `apps/web/src/components/workspace/video-toolbar.tsx`'s play/pause/previous-frame/next-frame controls through the T089 controller (passed down as callback props from `video-engine.tsx`, matching its existing callback-prop pattern) instead of any direct `videoRef`/`currentTime` access
- [X] T093 [US9] Route `apps/web/src/components/workspace/video-timeline.tsx`'s seek/scrub through the T089 controller's `seekToTime`, replacing any direct `videoRef` access, while confirming the timeline still never creates or modifies an annotation
- [X] T094 [US9] Replace the hardcoded `1/30` previous/next-frame step in `video-engine.tsx` with the T089 controller's fps-derived `nextFrame`/`previousFrame`, and confirm the six-step navigation sequence (pause if needed → update `video.currentTime` → update store `currentFrame` → recompute visible annotations/derived interpolation → update the timeline playhead) runs as one unit
- [X] T095 [US9] Verify "Existing track → Add keyframe here" (`video-toolbar.tsx`'s Add Keyframe Here control) is unaffected by T088–T094 — it must still target the already-selected track's `expectedTrackRevision` (FR-008/FR-022) and never create a new `VideoObjectTrack`; this is a confirmation checkpoint, not new implementation, and any regression found must be fixed before T096
- [ ] T096 [US9] Re-run the full existing VIDEO track/keyframe/temporal-label HTTP and race suites unchanged; confirm FR-005–FR-030/FR-008/FR-022 stay green; record the exact result in `specs/019-video-annotation-mvp/quickstart.md`
- [X] T097 [US9] Re-run the full existing IMAGE workspace UI/autosave/conflict suite unchanged as the regression baseline; record the exact result in `specs/019-video-annotation-mvp/quickstart.md`
- [X] T098 [US9] Run web typecheck/lint/build, `git diff --check`, and confirm no new `package.json` dependency was introduced (spec Explicit non-goals); record exact results in `specs/019-video-annotation-mvp/quickstart.md`

## Dependencies and execution order

- Setup T001–T005 precedes foundational T006–T015.
- Foundational work blocks all stories.
- US1 (T016–T023) is the read-only MVP; US2 and US3 depend on its read model.
- US4 can run after foundational services and in parallel with US2/US3.
- US5 depends on mutation services from US2 and US4; US6 depends on US5.
- T057–T061 require all selected stories and regressions.
- US7 (T062–T073) depends only on US1–US3's rendered UI existing (it does —
  `video-engine.tsx` already renders `VideoToolbar`/`VideoDetailsPanel`/
  `VideoTemporalLabels`/an inline save-state footer today). It does NOT
  depend on US4's open items (T042, T045), US5 (T046–T051), US6 (T052–T056),
  or Polish (T057–T061) — those remain independently open and are unaffected
  by building a registry around already-built UI.
- US8 (T074–T084) depends on US7's registry (T064–T070) existing; it does not
  depend on US4–US6/Polish either, for the same reason.
- US9 (T085–T098) depends only on US1–US3's rendered `video-engine.tsx`/
  `video-toolbar.tsx`/`video-timeline.tsx`/`useVideoAnnotationStore` existing
  (they do). It does NOT depend on US4–US6/Polish, or on US7/US8 having
  finished relocating VIDEO's UI into the shared shell registry — T090–T094
  touch `video-engine.tsx`'s pointer-event wiring and the `<video>` element
  directly, and remain valid whether that relocation is complete or still
  in progress, since neither changes which element owns which pointer
  events. T095 exists specifically to catch any regression if T076–T080 (US8)
  already relocated the Add Keyframe Here control by the time US9 runs.

## Parallel opportunities

- T003–T005; T008 and T010–T014; T016–T018; T024–T027; T034–T036; T040–T042; T046–T048; T052–T053/T057–T059; T062–T063; T074–T075; and T085–T087 are parallelizable within their dependency boundaries.

## MVP and implementation strategy

1. Complete setup and foundational tasks, including the migration gate.
2. Complete US1 and validate safe private-video inspection.
3. Stop for a demonstrable read-only MVP if desired.
4. Add US2, US3, US4, US5, and US6 incrementally, validating each checkpoint.
5. Finish cross-cutting redaction, regressions, builds, and scope audit.
6. US7 (shared workspace registry) can be scheduled any time after US1–US3 —
   it does not require US4–US6/Polish to close first. It should land before
   US8, since US8 relocates VIDEO's UI into the registry US7 builds, and
   before any fifth modality engine is proposed, since FR-040/FR-044 depend
   on the registry already existing.
7. US8 (relocate VIDEO controls) follows US7 directly; it is the same
   relocation the earlier single-story plan described, now expressed as
   registry-entry edits instead of ad hoc per-component branching.
8. US9 (interaction ownership) can be scheduled any time after US1–US3 close,
   independently of US4–US8/Polish — it is a correctness fix to pointer/
   playback ownership inside the existing VIDEO surfaces, not new rendered
   UI. Scheduling it before US8 finishes is safe (T095 exists to catch the
   one place they could interact — the Add Keyframe Here control's location);
   scheduling it after is equally safe.

All tasks use the required checkbox/ID format, include concrete paths, and story tasks carry the appropriate [USn] label.
