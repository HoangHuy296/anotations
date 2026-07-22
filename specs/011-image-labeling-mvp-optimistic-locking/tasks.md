# Tasks: Image Labeling MVP and Optimistic Locking

**Input**: Design documents from `/specs/011-image-labeling-mvp-optimistic-locking/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Required. Use the existing Node/tsx test runner and controlled Compose PostgreSQL/MinIO only where a real authorized view capability is needed. Tests must use normal opaque-cookie sessions; do not add a JWT, auth bypass, mocked database, mocked MinIO, or mocked Redis for integration claims.

**Scope guard**: No Prisma schema or migration change; no new dependency; no raw SQL; no binary in PostgreSQL; no browser credential, session credential, JWT, storage key, or provider-token exposure; no Redis/BullMQ workspace state; no worker work; and no modality-specific workspace route.

## Phase 1: Setup and scope controls

**Purpose**: Establish a focused test entry point and prevent Feature 011 from weakening locked auth/annotation boundaries.

- [X] T001 Record Feature 011 scope, explicit no-JWT/no-migration/no-new-dependency constraints, and Phase 010 dependency in `specs/011-image-labeling-mvp-optimistic-locking/plan.md`
- [X] T002 [P] Add focused auth/workspace test discovery without a dependency in `apps/web/package.json`
- [X] T003 [P] Add shared non-secret workspace/auth fixture helpers for users, Dataset members, IMAGE Assets, labels, annotations, and opaque HTTP login in `apps/web/tests/workspace/helpers.ts`
- [X] T004 [P] Add Feature 011 test commands and expected non-secret runtime prerequisites in `specs/011-image-labeling-mvp-optimistic-locking/quickstart.md`

---

## Phase 2: Foundational contracts and guarded read/write boundaries

**Purpose**: Build the shared primitives that block every public auth page and image workspace story.

**⚠️ CRITICAL**: Complete this phase before any user-story implementation.

- [X] T005 Define safe internal return-target validation and default authenticated destination helpers in `apps/web/src/lib/auth-redirect.ts`
- [X] T006 [P] Define strict normalized bounding-box, annotation mutation, Asset-description mutation, and conflict schemas in `apps/web/src/lib/validation/image-workspace.ts`
- [X] T007 [P] Define safe image workspace DTOs, version/revision DTOs, and browser-only save-state types in `apps/web/src/types/image-workspace.ts`
- [X] T008 Implement one server-only authorized workspace read service for Dataset-scoped IMAGE Asset, labels, annotations, description/revision, and stable list/page metadata in `apps/web/src/lib/workspace/image-workspace.ts`
- [X] T009 Implement server-only guarded mutation services for geometry-only update, label-only update, versioned delete, and Asset-description update in `apps/web/src/lib/workspace/image-mutations.ts`
- [X] T010 Apply safe return-target redirect policy for protected page requests while retaining safe API `401` behavior in `apps/web/src/proxy.ts`
- [X] T011 [P] Write unit tests for return-target validation, normalized geometry bounds, and no-JWT/no-browser-credential rules in `apps/web/tests/workspace/foundation.test.ts`
- [X] T012 [P] Write PostgreSQL integration tests for cross-Dataset concealment, guarded revision mutations, and denial/no-side-effect behavior in `apps/web/tests/workspace/workspace-authorization.test.ts`

**Checkpoint**: Public pages can safely derive internal returns, and every workspace read/write has one actor/Dataset/Asset/Label/version boundary before UI interaction begins.

---

## Phase 3: User Story 0 - Register and sign in safely (Priority: P1)

**Goal**: A visitor uses public registration/login pages backed solely by the existing opaque HTTP-only cookie session and reaches a safe protected destination.

**Independent Test**: A visitor registers or logs in through UI pages, receives no browser-readable credential, reaches an internal protected destination, logs out, and is redirected to login afterwards.

### Tests for User Story 0

- [X] T013 [P] [US0] Write authenticated HTTP/page-flow tests for registration, login, duplicate/invalid credentials, logout, expired/revoked session, and safe return targets in `apps/web/tests/workspace/auth-pages.test.ts`
- [X] T014 [P] [US0] Write proxy redirect regression tests proving protected pages go to login while APIs retain safe `401` responses in `apps/web/tests/workspace/proxy-auth-redirect.test.ts`
- [X] T015 [P] [US0] Write response/browser-state redaction tests proving login and registration expose no password, opaque session value, hash, refresh credential, or JWT in `apps/web/tests/workspace/auth-redaction.test.ts`

### Implementation for User Story 0

- [X] T016 [US0] Implement reusable accessible login/registration form behavior, pending state, safe errors, and internal return handling in `apps/web/src/components/auth/credentials-form.tsx`
- [X] T017 [P] [US0] Implement the public login page using the existing login endpoint and active-session redirect in `apps/web/src/app/(auth)/login/page.tsx`
- [X] T018 [P] [US0] Implement the public registration page using the existing signup endpoint and active-session redirect in `apps/web/src/app/(auth)/register/page.tsx`
- [X] T019 [US0] Integrate protected-page redirect, login/register redirect, and logout regression behavior without changing existing AuthSession APIs in `apps/web/src/proxy.ts`, `apps/web/src/app/(auth)/login/page.tsx`, and `apps/web/src/app/(auth)/register/page.tsx`

**Checkpoint**: Registration/login UI is independently usable and preserves the opaque cookie/PostgreSQL session architecture.

---

## Phase 4: User Story 1 - Open and annotate an image (Priority: P1) 🎯 MVP

**Goal**: An authorized annotator opens an IMAGE Asset and creates, selects, relabels, moves, resizes, and deletes normalized manual bounding boxes.

**Independent Test**: An authorized user opens a real IMAGE Asset through an authorized view capability, draws a labeled box, reloads, then verifies geometry and metadata behavior after edit/delete.

### Tests for User Story 1

- [X] T020 [P] [US1] Write guarded create/geometry/relabel/delete integration tests proving geometry-only and label-only mutation isolation in `apps/web/tests/workspace/annotation-mutations.test.ts`
- [X] T021 [P] [US1] Write IMAGE-only workspace/read/view-capability authorization tests with real controlled MinIO in `apps/web/tests/workspace/image-workspace-http.test.ts`
- [X] T022 [P] [US1] Write normalized coordinate conversion and zero/out-of-bound box unit tests in `apps/web/tests/workspace/geometry.test.ts`

### Implementation for User Story 1

- [X] T023 [US1] Extend safe workspace page loading for selected IMAGE Asset, labels, annotations, description, revisions, and page metadata through the authorized read service in `apps/web/src/app/(app)/workspace/[datasetId]/page.tsx`
- [X] T024 [US1] Replace broad annotation action inputs with create, geometry-only, label-only, and versioned-delete server actions that call guarded services in `apps/web/src/app/(app)/workspace/[datasetId]/actions.ts`
- [X] T025 [US1] Extend workspace annotation types/store with safe persisted annotation id, version, label, geometry, and selected-state handling in `apps/web/src/types/annotation.ts` and `apps/web/src/stores/annotation-store.ts`
- [X] T026 [US1] Implement authorized image view-capability loading and safe load/expiry/unavailable UI state in `apps/web/src/components/workspace/annotation-canvas.tsx`
- [X] T027 [US1] Implement Konva IMAGE-layer bounding-box rendering, ghost draw, selection, drag-end geometry update, transform-end resize update, and explicit delete selection behavior in `apps/web/src/components/workspace/canvas-stage.tsx`
- [X] T028 [US1] Update select/pan/box/delete controls and active-label affordance without adding future geometry tools in `apps/web/src/components/workspace/toolbar.tsx`

**Checkpoint**: The first complete image-labeling loop works with real image preview, one canonical bounding-box type, and safe durable annotation operations.

---

## Phase 5: User Story 2 - Work accurately at any viewport (Priority: P1)

**Goal**: Pan, zoom, and selection are intuitive while all persisted annotation coordinates remain normalized to the original image.

**Independent Test**: A box rendered at multiple zoom/pan states remains aligned; after move/resize it reloads in the same original-image-relative location.

### Tests for User Story 2

- [X] T029 [P] [US2] Write viewport-to-normalized and normalized-to-viewport round-trip tests across fit, zoom, and pan states in `apps/web/tests/workspace/viewport-geometry.test.ts`
- [X] T030 [P] [US2] Write selection synchronization and viewport-no-persistence regression tests in `apps/web/tests/workspace/canvas-selection.test.ts`

### Implementation for User Story 2

- [X] T031 [US2] Extract reusable original-image coordinate conversion, clamping, and non-zero box helpers in `apps/web/src/lib/workspace/geometry.ts`
- [X] T032 [US2] Apply the geometry helpers to Konva pointer, drag, transformer, fit, pan, zoom, and selected-overlay behavior in `apps/web/src/components/workspace/canvas-stage.tsx`
- [X] T033 [US2] Synchronize canvas and Shapes selection state without persisting pan/zoom in `apps/web/src/stores/annotation-store.ts` and `apps/web/src/components/workspace/properties-panel.tsx`

**Checkpoint**: Viewport changes never affect canonical stored geometry, and canvas/sidebar selection stays synchronized.

---

## Phase 6: User Story 3 - Save safely during concurrent work (Priority: P1)

**Goal**: Autosave begins after 1.5 seconds of inactivity and stale saves cannot overwrite a newer annotation or description.

**Independent Test**: Two authenticated sessions edit the same annotation and then the same description; first save wins, second stale save is `409`, no newer data is overwritten, and the stale local draft remains recoverable.

### Tests for User Story 3

- [X] T034 [P] [US3] Write concurrent Annotation revision tests for geometry, relabel, delete-versus-edit, conflict response shape, and no-side-effect guarantees in `apps/web/tests/workspace/annotation-locking.test.ts`
- [X] T035 [P] [US3] Write concurrent Asset description revision tests and denial/no-overwrite assertions in `apps/web/tests/workspace/description-locking.test.ts`
- [X] T036 [P] [US3] Write autosave delay/reset, success-version replacement, failed-save, and local-conflict-draft UI tests in `apps/web/tests/workspace/autosave-state.test.ts`

### Implementation for User Story 3

- [X] T037 [US3] Implement versioned Asset-description server action and safe `409` conflict DTO in `apps/web/src/app/(app)/workspace/[datasetId]/actions.ts`
- [X] T038 [US3] Implement per-resource 1.5-second autosave scheduler, pending/saving/saved/failed/conflict state, timer cleanup, and no automatic stale retry in `apps/web/src/stores/annotation-store.ts`
- [X] T039 [US3] Implement conflict banner/dialog with explicit reload, discard, and reconcile entry points that retain local drafts in `apps/web/src/components/workspace/save-conflict-panel.tsx`
- [X] T040 [US3] Add description form and save-state feedback integrated with selected image revision in `apps/web/src/components/workspace/properties-panel.tsx`
- [X] T041 [US3] Connect canvas geometry/relabel/delete interaction boundaries to autosave and returned current versions in `apps/web/src/components/workspace/canvas-stage.tsx` and `apps/web/src/components/workspace/annotation-canvas.tsx`

**Checkpoint**: Stale autosaves cannot overwrite newer server state, and users have an explicit recovery path for local drafts.

---

## Phase 7: User Story 4 - Manage labels, shapes, and image navigation (Priority: P2)

**Goal**: Users manage safe label taxonomy and shape assignment while browsing all Dataset image results in batches of 100.

**Independent Test**: An authorized manager establishes default labels and manages unreferenced labels; an annotator relabels through Shapes; a Dataset with 250 images supports full-Dataset search and stable 100-item paging.

### Tests for User Story 4

- [X] T042 [P] [US4] Write default-label idempotency, custom-label normalization, referenced-label delete refusal, and role-matrix tests in `apps/web/tests/workspace/label-management.test.ts`
- [X] T043 [P] [US4] Write Shapes list selection/relabel/delete synchronization tests in `apps/web/tests/workspace/shapes-panel.test.ts`
- [X] T044 [P] [US4] Write 250-Asset full-Dataset case-insensitive search, stable order, 100-item pagination, previous/next, and status/batch tests in `apps/web/tests/workspace/image-navigation.test.ts`

### Implementation for User Story 4

- [X] T045 [US4] Implement authorized idempotent default-label establishment and referenced-label delete guard in `apps/web/src/lib/workspace/label-management.ts`
- [X] T046 [US4] Extend Dataset label actions/routes to use the label-management guard while retaining existing normalized-name and `label.manage` rules in `apps/web/src/app/(app)/labels/actions.ts` and `apps/web/src/app/api/labels/[labelId]/route.ts`
- [X] T047 [US4] Replace the placeholder properties panel with Description, Labels, Shapes, and Images tab content and synchronized selected-shape controls in `apps/web/src/components/workspace/properties-panel.tsx`
- [X] T048 [US4] Implement full-Dataset IMAGE search, stable batch/order pagination, and safe page metadata in `apps/web/src/lib/workspace/image-workspace.ts` and `apps/web/src/app/(app)/workspace/[datasetId]/page.tsx`
- [X] T049 [US4] Implement images sidebar search/paging/status/batch display and previous/next navigation that respects pending edits in `apps/web/src/components/workspace/dataset-sidebar.tsx` and `apps/web/src/components/workspace/workspace-header.tsx`

**Checkpoint**: Taxonomy, Shapes, and Images views are Dataset-scoped, role-safe, and usable with large image collections.

---

## Phase 8: Polish and cross-cutting validation

**Purpose**: Prove Feature 011 matches every contract without expanding into future geometry, review, source-connection, or worker phases.

- [X] T050 [P] Audit all Feature 011 browser responses, form state, return paths, image view capability handling, and errors for password/session/JWT/storage/provider/private-key/binary leakage in `apps/web/src/app/(auth)/`, `apps/web/src/components/auth/`, and `apps/web/src/components/workspace/`
- [X] T051 [P] Audit mutations and stores for no pointer-loop persistence, no viewport persistence, no Redis/BullMQ use, and no ordinary-edit/review privilege crossover in `apps/web/src/components/workspace/`, `apps/web/src/stores/annotation-store.ts`, and `apps/web/src/app/(app)/workspace/[datasetId]/actions.ts`
- [X] T052 Run focused auth/workspace tests, existing auth-ownership tests, web lint/typecheck/build, and controlled Compose image-view smoke test; record exact non-secret results in `specs/011-image-labeling-mvp-optimistic-locking/quickstart.md`
- [X] T053 Confirm no new dependency, Prisma schema/migration/generated-client change, public worker route, binary database field, modality-specific workspace route, or SourceConnection/Gitea feature was introduced in `apps/web/package.json`, `prisma/`, `apps/web/src/`, and `apps/worker/src/`
- [X] T054 Update Feature 011 contracts and completion record with final auth/UI/locking behavior and known limitations in `specs/011-image-labeling-mvp-optimistic-locking/contracts/` and `specs/011-image-labeling-mvp-optimistic-locking/quickstart.md`

---

## Dependencies and execution order

```text
Setup → Foundation
            ├── US0: public auth entry
            └── US1: image annotation → US2: viewport accuracy → US3: optimistic autosave
                                                          └──────→ US4: labels/shapes/navigation
                                                                       ↓
                                                                    Polish
```

### Phase dependencies

- Setup (T001–T004) precedes Foundation.
- Foundation (T005–T012) blocks all feature stories.
- US0 can proceed after Foundation and is independently releasable.
- US1 is the annotation MVP after Foundation.
- US2 depends on US1 canvas primitives.
- US3 depends on US1 durable annotation mutation contracts and applies to the canvas from US2.
- US4 depends on safe workspace reads and uses selected-shape/autosave state from US1–US3.
- Polish begins only after all desired stories are complete.

### Parallel opportunities

- T002–T004 and T005–T007 can proceed in parallel by file.
- T011–T012 can proceed in parallel after T005–T010 contracts are settled.
- Within US0: T013–T015, then T017–T018, can proceed in parallel.
- Within US1: T020–T022 can proceed in parallel; T025 and T026 can start together after T023–T024; T027 then integrates them.
- Within US2: T029–T030 can proceed in parallel.
- Within US3: T034–T036 can proceed in parallel.
- Within US4: T042–T044 can proceed in parallel.
- T050–T051 can proceed in parallel after all feature stories.

## Implementation strategy

### MVP first

1. Complete Setup and Foundation.
2. Complete US0 to make the existing auth API usable from public pages.
3. Complete US1 to deliver the first durable image bounding-box labeling loop.
4. Validate auth and annotation MVP independently before adding viewport, autosave, or management work.

### Incremental delivery

1. US0 adds UI only over the existing opaque cookie session.
2. US1 adds canonical box creation/edit/delete on real authorized images.
3. US2 proves viewport correctness without persistent transform state.
4. US3 makes every asynchronous edit conflict-safe.
5. US4 makes the loop practical for labels and large image collections.
6. Polish verifies architecture/security/no-side-effect boundaries.

## Format validation

- All 54 tasks use the required checkbox, sequential task ID, exact path, and story label for user-story tasks.
- Tests are included because the Feature 011 specification explicitly requires measurable integration, authorization, stale-write, and no-side-effect evidence.
- No task authorizes schema, migration, dependency, JWT, raw SQL, worker, queue, SourceConnection, or future-geometry work.
