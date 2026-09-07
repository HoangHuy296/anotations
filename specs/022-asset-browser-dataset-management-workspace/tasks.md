---

description: "Task list for Asset Browser & Dataset Management Workspace (022)"

---

# Tasks: Asset Browser & Dataset Management Workspace

**Input**: Design documents from `/specs/022-asset-browser-dataset-management-workspace/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Included. The spec's own Requirements (FR-035/036/037), Success Criteria (SC-001–009), and every `contracts/*.md`'s "Test coverage required" section explicitly demand test coverage for this feature — this is not an optional TDD add-on, it's a stated requirement.

**Organization**: Tasks are grouped by user story (P1–P5 from spec.md) so each is independently implementable, testable, and shippable on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US5, mapping to spec.md's five prioritized user stories
- File paths are exact, per plan.md's Project Structure

## Path Conventions

Monorepo per plan.md: `apps/web/src/...` (Next.js backend+frontend), `apps/worker/src/...` (background jobs), `packages/queue/src/...`, `prisma/schema.prisma`. No new app/package — see plan.md's Structure Decision.

---

## Phase 1: Setup

**Purpose**: Confirm the existing toolchain is green before layering new work on it — no new project scaffolding needed, this is an established monorepo.

- [X] T001 Run `pnpm typecheck` and `pnpm lint` at repo root and confirm both pass clean on `main` before branching, establishing the pre-feature baseline — **result**: lint 100% clean; typecheck has one pre-existing, unrelated failure (`tests/repository-import-worker/legacy-image-content.test.ts` imports a deleted `@/app/api/images/[imageId]/content/route`) — recorded as a known pre-existing issue, not introduced by this feature
- [X] T002 Run the existing full test suite (`apps/web` and `apps/worker` `node:test` suites per-package `test:*` scripts, plus `tests/jobs`/`tests/media`/`tests/providers` in the worker which aren't wired to an npm script) and confirm pass rate, capturing the baseline referenced by SC-007 — **result**: worker 100% pass across queue/source-access/repository-import/jobs/media/providers; web all suites pass except 4 pre-existing files unrelated to this feature (`direct-upload` — MinIO `fetch failed` in this sandbox's network setup; `local-folder-import` — stale storage-key fixture assertion; `repository-preflight` — pre-existing contract assertion mismatch; `repository-import-worker` — same dead route as T001). **Addendum found while running T012/T013 with `WORKSPACE_INTEGRATION_TESTS=1`** (not exercised by the default `pnpm run test:workspace`, which skips 19 gated tests without that flag): 2 more pre-existing, unrelated failures surfaced — `auth-pages.test.ts` ("registration persists...", a session-count assertion) and `label-management.test.ts` ("default labels backfill only the missing ones...", whose own comment describes a regression that `ensureDefaultImageLabels`'s current `if (existing > 0) return { created: 0 }` early-return does not actually fix). Neither file was touched by this session; both are out of scope for Phase 022.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, queue-contract, and shared query-builder changes every user story depends on. No user story task may start before this phase is complete.

**⚠️ CRITICAL**: Phases 3–7 all read/write the `AssetLabel` model, the extended query builder, or the new `JobType`s introduced here.

- [X] T003 Add `AssetLabel` model to `prisma/schema.prisma` per data-model.md (fields, `@@unique([assetId, labelId])`, `@@index([labelId])`, relations on `Asset`/`Label`/`User`)
- [X] T004 Add `Asset.assignedToId String?` scalar + `User` relation to `prisma/schema.prisma` per data-model.md
- [X] T005 Add `BULK_DELETE_ASSETS` and `BULK_EXPORT_SELECTED` to the `JobType` enum, and `RESOLVING_SELECTION`, `DELETING_ASSETS`, `EXPORTING_SELECTED_ASSETS` to the `JobStage` enum, in `prisma/schema.prisma`
- [X] T006 Run `pnpm db:migrate` to generate and apply the migration for T003–T005; run `pnpm db:generate` and `pnpm db:normalize-generated` — **note**: hit an unrelated pre-existing checksum drift on migration `20260817000000_rename_text_document_to_text_asset` (comment-only edit after apply; live table already matched); resolved non-destructively by updating the recorded checksum in `_prisma_migrations` to match the current file (verified the actual table name first) rather than running `migrate reset`, per the project's shared-dev-DB safety rule. New migration `20260827112525_asset_browser_dataset_management_workspace` applied cleanly.
- [X] T007 Add `BULK_DELETE_ASSETS` and `BULK_EXPORT_SELECTED` to `supportedQueueJobTypes` in `packages/queue/src/job-contract.ts`
- [X] T008 Extract the shared Prisma where-clause builder for Asset list filtering out of `apps/web/src/lib/workspace/workspace-read.ts` into a pure, reusable function in `apps/web/src/lib/workspace/workspace-assets.ts` (per research.md §4/§1), accepting the extended `AssetListQuery` shape (search, multi-status, modality, labelId[], assignedToId, created/updated ranges) with `sort`/`order`/pagination fields excluded from the query type per research.md §3
- [X] T009 [P] Add `BULK_SYNC_MAX_ASSETS = 200` and the `AssetListQuery` / `BulkSelection` / `BulkOperationResult` shared types to `apps/web/src/types/workspace.ts` per data-model.md
- [X] T010 [P] Extend `apps/web/src/lib/validation/asset-list.ts` (`assetListQuerySchema`) with repeatable `status`, `labelId[]`, `assignedToId`, `createdFrom/To`, `updatedFrom/To`, `sort`, `order`, rejecting out-of-range values server-side (FR-007) — `GET /api/datasets/[datasetId]/assets` wired to the new params directly (kept its own where-builder to preserve its existing filename+originalFilename+description search breadth and archived-asset inclusion, rather than switching to the shared builder, to avoid an unnecessary contract change)

**Checkpoint**: Schema migrated, queue contract updated, shared query builder and validation extended. User story implementation can now begin.

---

## Phase 3: User Story 1 - Discover and inspect assets in a large dataset (Priority: P1) 🎯 MVP

**Goal**: Search, multi-filter, sort, and paginate the Assets tab server-side; open any asset (including Audio/Text) to see real modality-specific details.

**Independent Test**: Open a dataset, combine search + modality/status/label/date filters + sort, confirm result set and paging are correct, click an asset of each modality and confirm real per-modality details render — no selection or bulk action involved.

### Tests for User Story 1

- [X] T011 [P] [US1] Extend `apps/web/tests/dataset-metadata/assets.test.ts` with cases for each new filter param (labelId, assignedToId, created/updated ranges), multi-value `status`, `sort`/`order`, and a regression case proving existing single-`status` callers are unaffected, per contracts/assets-list.md — 4 new schema-level tests added (12/12 pass, up from 8/8 baseline)
- [X] T012 [P] [US1] Add a workspace query test (new file `apps/web/tests/workspace/asset-browser-query.test.ts`) proving: filter combinations intersect (not union) correctly; paging with an active filter stays consistent across pages; changing sort alone never changes the matched result *set*, only order (FR-005) — 4 DB-fixture tests, gated `WORKSPACE_INTEGRATION_TESTS=1` matching the existing `asset-navigator-pagination.test.ts` convention; all 4/4 pass when run with that flag
- [X] T013 [P] [US1] Add a details-population test (new file `apps/web/tests/workspace/modality-details.test.ts`) asserting AUDIO assets render `sampleRate`/`channels`/`codec`/`bitRate`/waveform-availability and TEXT assets render `language`/length/metadata from real fixture rows, not placeholder-only text (FR-031) — 4/4 pass under the same flag

### Implementation for User Story 1

- [X] T014 [US1] Wire the extended query builder (T008) and validation (T010) into `readWorkspacePage()` in `apps/web/src/lib/workspace/workspace-read.ts`, adding `sort`/`order` support and passing through the new filters (depends on T008, T010) — also generalized the selected-asset auto-paging/Previous-Next lookahead (previously hardcoded to batchIndex/orderIndex ordering) via a new `buildBeforeSelectionWhere` helper in `workspace-assets.ts`, since a custom sort changes what "before this asset in the list" means; verified against the existing `test:workspace` suite (36/36 pass, unchanged from baseline)
- [X] T015 [US1] Apply the same extended filters (labelId, assignedToId, created/updated ranges, multi-status, sort/order) to `apps/web/src/app/api/datasets/[datasetId]/assets/route.ts` per contracts/assets-list.md, keeping the response shape unchanged (depends on T008, T010) — kept this route's own where-builder (not the shared one) to preserve its pre-existing wider search (filename+originalFilename+description) and archived-asset inclusion; verified against `test:dataset-metadata` (8/8 pass)
- [X] T016 [US1] Update `apps/web/src/app/(app)/workspace/[datasetId]/page.tsx` to read the new filter/sort search params and pass them through to `readWorkspacePage()` (depends on T014) — extended `workspaceListQuerySchema` with the new params (`filterModality` kept distinct from the existing selected-asset `modality` field) and threaded them into the `readWorkspacePage()` call; **UI controls to set/display these params (filter form, sort control) are T017/T018, not yet done** — the query layer works end-to-end via direct URL params today, but nothing in the Assets tab UI can set them yet
- [X] T017 [US1] Add filter controls (modality, status multi-select including a "Review status" grouping of NEEDS_REVIEW/REVIEWED/REJECTED, label, created/updated date range) and a sort control to the Assets tab search form in `apps/web/src/components/workspace/video-properties-tabs.tsx`, replacing the current single-status `<select>` (depends on T016) — extracted into a new shared `apps/web/src/components/workspace/asset-browser-filters.tsx` (`AssetBrowserFilters`) rather than inline per-tab markup, anticipating T018's reuse
- [X] T018 [US1] Add the same filter/sort controls to the Assets tab in `apps/web/src/components/workspace/image-properties-tabs.tsx`, reusing the control component introduced in T017 rather than duplicating markup (depends on T017) — both tabs now render `<AssetBrowserFilters>`; `assignedToId` filtering UI intentionally deferred to User Story 2 (no assignee-picker exists yet; the backend filter itself is already wired from Foundational)
- [X] T019 [US1] Populate real `AudioAsset`/`TextAsset`/base-`Asset` metadata fields into the existing `selection.engine`-driven header in `apps/web/src/components/workspace/placeholder-properties-tabs.tsx` per research.md §11 — disabled sub-tab labels (`Segments`/`Properties`/`Annotations`) left untouched (depends on T016) — AUDIO reuses `SafeMediaReadiness.audio` (already fetched, just not rendered before); TEXT required extending `readWorkspaceSelection`'s TEXT branch + `SafeReadOnlyWorkspaceAsset` to carry `mimeType`/`sizeBytes`/`textLength`/`language`/timestamps (zero migration, per research.md §11)
- [X] T020 [US1] Confirm "no matches" empty state renders clearly (not a blank/broken area) in `apps/web/src/components/workspace/asset-navigator.tsx` for a zero-result query (Edge Cases) — done alongside extending `AssetNavigator`'s `href()` builder to carry every active filter/sort onto Previous/Next and asset links (also threaded through `DatasetSidebar`'s own Previous/Next), so paging never silently drops the active query (FR-005)

**Checkpoint**: Asset Browser discovery/inspection is fully functional and independently testable/demoable — no selection or bulk actions required.

---

## Phase 4: User Story 2 - Select assets and organize them in bulk (Priority: P2)

**Goal**: Select individually, select-visible, or select-all-filtered; add/remove asset labels (metadata only); change asset status; expose an assign boundary — all with a visible, accurate processed/succeeded/failed/skipped result.

**Independent Test**: Select a mix of individually-chosen and select-all-filtered assets, apply label add/remove and a status change, confirm only selected assets were affected with a correct result summary; confirm sort changes never affect selection and search/filter changes reconcile selection per FR-013's rule.

### Tests for User Story 2

- [X] T021 [P] [US2] Add `apps/web/tests/assets-bulk/add-remove-label.test.ts` covering: add existing label, add newly-created label (name+color, dedup by normalized name), idempotent re-add reported `skipped`, remove label (metadata only, `Annotation` untouched), remove-when-absent reported `skipped`, annotation-reference warning (`409` without `confirmedAnnotationWarning`, success with it) — per contracts/assets-bulk.md — 4/4 pass
- [X] T022 [P] [US2] Add `apps/web/tests/assets-bulk/change-status.test.ts` covering: status change affects only `Asset.status`; a fixture with related `Annotation`/`Job`/`AiTask` rows proves those are untouched; no-op (same-status) reported `succeeded`, not `skipped`/`failed` (FR-017, Edge Cases) — 2/2 pass
- [X] T023 [P] [US2] Add `apps/web/tests/assets-bulk/assign.test.ts` covering: assign to a valid `DatasetMember`, reject/skip assignment to a non-member, unassign via `null` — 2/2 pass
- [X] T024 [P] [US2] Add `apps/web/tests/assets-bulk/selection-resolution.test.ts` proving a `FILTERED` selection over a large fixture set is resolved server-side without any response payload scaling with the full matched-asset count (SC-002), and that `BULK_SYNC_MAX_ASSETS` is enforced (`422` at 201, success at 200) for organize actions — 4/4 pass
- [X] T025 [P] [US2] Add a selection-store unit test `apps/web/tests/workspace/asset-selection-store.test.ts` covering FR-013's three rules directly: sort-only change leaves both selection modes untouched; filtered-mode reconciles automatically on search/filter change with visible scope-change indication; explicit-mode retains hidden-but-selected assets and distinguishes them from visible-and-selected — 8/8 pass, no `WORKSPACE_INTEGRATION_TESTS` flag needed (pure store logic, no DB)

### Implementation for User Story 2

- [X] T026 [US2] Create `apps/web/src/lib/assets/asset-label-service.ts` — idempotent add/remove of `AssetLabel` rows, same-dataset validation, inline label creation reusing the existing Labels-tab uniqueness rule (depends on T003, T006)
- [X] T027 [US2] Create `apps/web/src/lib/assets/asset-bulk-service.ts` — shared executor for `ADD_LABEL`/`REMOVE_LABEL`/`CHANGE_STATUS`/`ASSIGN`: resolves selection (explicit or filtered, via T008's query builder), authorizes every asset against the dataset, enforces `BULK_SYNC_MAX_ASSETS`, returns `BulkOperationResult` (depends on T008, T009, T026) — logging (`bulk_action_started`/`completed`/`partial_failure`/`failed`) implemented via a new `logBulkAssetEvent` added to `packages/domain/src/log.ts` (same closed-shape pattern as the existing job/redis/storage/ai loggers) and called from the route (T029), not the service layer, so it fires exactly once per request regardless of which action ran
- [X] T028 [P] [US2] Create `apps/web/src/lib/validation/asset-bulk.ts` — Zod schema for the bulk request body (action discriminated union, `selection`, `payload` per action) per contracts/assets-bulk.md — `bulkSelectionQuerySchema` is `.strict()` with no sort/order/pagination fields, so a request carrying them is rejected by construction
- [X] T029 [US2] Create `apps/web/src/app/api/datasets/[datasetId]/assets/bulk/route.ts` — `POST` handler wiring T028's validation, dataset authorization (`dataset.update` for organize actions, `asset.delete` for DELETE, `job.createExport` for EXPORT_SELECTED — no new `DatasetPermission` needed), and T027's executor for the four sync-only actions; returns the `409` annotation-reference-warning response for `REMOVE_LABEL` per contracts/assets-bulk.md; `DELETE`/`EXPORT_SELECTED` validate but return `501 BULK_ACTION_NOT_IMPLEMENTED` (User Story 3/4's job) (depends on T027, T028) — also added a small new read-only `GET /api/datasets/[datasetId]/members` route (reusing `DatasetMember`/`DatasetMemberRole`, no invitation/role-edit capability) to back the Assign UI's assignee picker
- [X] T030 [US2] Create `apps/web/src/stores/asset-selection-store.ts` — Zustand store per data-model.md's client selection-store shape, implementing FR-013's reconciliation rule (depends on T009)
- [X] T031 [US2] Extend `apps/web/src/components/workspace/asset-navigator.tsx` with per-row checkboxes, "select visible," "select all filtered" (showing the live matched count before commit via the already-known `totalAssets` prop, not a second request), "clear selection," and a selected-count display distinguishing "N selected" (explicit) from "All N matching selected" (filtered) (depends on T030) — reconciliation (FR-013) runs declaratively via a `useEffect` keyed on the active query, so there's never a stale copy to fall out of sync
- [X] T032 [US2] Add a centralized bulk-action bar (Add Label, Remove Label, Change Status, Assign) below `AssetNavigator` in `apps/web/src/components/workspace/image-properties-tabs.tsx` and `video-properties-tabs.tsx`, calling T029's endpoint and displaying the returned `BulkOperationResult` (processed/succeeded/failed/skipped), with confirmation UX for the annotation-reference warning (depends on T029, T031) — new shared `apps/web/src/components/workspace/bulk-action-bar.tsx`
- [X] T033 [US2] After a successful bulk action, refresh the asset list and reconcile selection per FR-036 (router refresh / re-fetch, clearing/updating selection as appropriate) in the components touched by T032 (depends on T032) — implemented inside `bulk-action-bar.tsx`'s `callBulk()`: clears the selection store then calls `router.refresh()` on success

**Checkpoint**: Selection and bulk organization work end-to-end and are independently testable/demoable on top of US1.

---

## Phase 5: User Story 3 - Safely delete assets in bulk (Priority: P3)

**Goal**: Bulk-delete a selection with server-side authorization, confirmation UX, synchronous execution for small batches and a background Job for large ones, and zero risk to storage objects still referenced elsewhere.

**Independent Test**: Select a batch, confirm the delete warning, execute, verify deleted assets disappear while out-of-selection assets and their storage objects remain fully intact, including for a large batch that runs as a background Job and a retried/idempotent delete.

### Tests for User Story 3

- [X] T034 [P] [US3] Add `apps/web/tests/assets-bulk/delete-sync.test.ts` covering: small-batch synchronous delete, authorization rejection of an asset outside the dataset/user scope, already-deleted asset reported `skipped` not `failed` (idempotency) — 4/4 pass
- [X] T035 [P] [US3] Add `apps/worker/tests/jobs/bulk-delete-assets.test.ts` covering: Job created and enqueued via the existing `{jobId}`-only funnel for a batch over `BULK_SYNC_MAX_ASSETS`, DB deletion completes independent of MinIO availability, cleanup is left to the existing GC path (no synchronous MinIO delete in the job), retry of the same Job is safe, and — reusing `minio-orphan-scanner.ts`'s reference-checker posture — an object still referenced by an asset outside the deleted set is never removed — 4/4 pass, gated `GARBAGE_COLLECTION_RUNTIME_TESTS=1` (real MinIO deletes, same flag as the sibling `deleted-asset-cleanup.test.ts` this job directly calls)

### Implementation for User Story 3

- [X] T036 [US3] Add `DELETE` handling to `apps/web/src/lib/assets/asset-bulk-service.ts` (sync path, small batches): authorization, idempotent handling of already-deleted assets, DB-only removal with no synchronous MinIO call, per FR-020–023 (depends on T027) — soft-delete only (`Asset.deletedAt`), never a hard delete; this is the first real "delete an Asset" call site (Phase 21's `cleanupDeletedAssetObject` was scaffolded specifically for it, per that function's own doc comment)
- [X] T037 [US3] Extend `apps/web/src/lib/queue/enqueue-job.ts`'s Job-creation helpers (or add a sibling function following the same pattern as Dataset Export's `createAuthorizedExportJob`) to create a `BULK_DELETE_ASSETS` Job carrying only the resolved `BulkSelection` needed to re-resolve server-side, and enqueue it via the existing `enqueueExistingJob()` funnel when the resolved count exceeds `BULK_SYNC_MAX_ASSETS` (depends on T007, T009) — new `createAndEnqueueBulkAssetJob`; `Job.input` schema shared with the worker via a new `packages/domain/src/bulk-asset-job.ts` (`@annotationplatform/domain/bulk-asset-job`) so both sides agree on the wire contract; idempotency keyed per-selection (not per-dataset like Export, since bulk actions aren't "one canonical job forever")
- [X] T038 [US3] Create `apps/worker/src/jobs/bulk-delete-assets.ts` — re-resolves the selection server-side (via a new worker-side `bulk-asset-selection.ts`, a deliberate duplicate of `buildAssetListWhere` since web/worker never import each other's app code), deletes Asset DB rows in bounded batches (200/batch, heartbeats + cancellation-checks between batches), writes the result to `Job.summary`, leaves MinIO cleanup to a best-effort per-batch call to the existing `cleanupDeletedAssetObject` primitive plus the periodic orphan scanner as guaranteed secondary layer per research.md §13 (depends on T008, T037) — also added the 3 new `JobStage` values to `job-claim-lock.ts`'s progress-update schema (they were in the Prisma enum from Foundational but not yet in this separate allow-list)
- [X] T039 [US3] Add a dispatch branch for `BULK_DELETE_ASSETS` in `apps/worker/src/queue/queue-router.ts` (depends on T038)
- [X] T040 [US3] Wire `DELETE` into the `POST .../assets/bulk` route (`apps/web/src/app/api/datasets/[datasetId]/assets/bulk/route.ts`): sync path via T036, background path via T037, returning `200`/`{mode:"SYNC"}` or `202`/`{mode:"JOB", jobId}` per contracts/assets-bulk.md (depends on T029, T036, T037)
- [X] T041 [US3] Add a "Delete" action to the bulk-action bar (T032) with the confirmation dialog required by FR-025, and a distinct "runs in background" notice when the response is `{mode:"JOB"}`, polling `GET /api/jobs/{jobId}` for completion (depends on T032, T040)

**Checkpoint**: Bulk delete is safe, authorized, idempotent, and independently testable/demoable on top of US1–US2.

---

## Phase 6: User Story 4 - Export the current selection's metadata (Priority: P4)

**Goal**: "Export Selected" in the Workspace Toolbox exports selected assets' metadata/labels/annotations (no binaries), synchronously for small selections and as a background Job for large ones, fully independent of the existing Dataset Export.

**Independent Test**: Select a subset, run Export Selected, confirm the output contains exactly that subset's metadata/annotations with zero binary bytes, and confirm the existing full-dataset export still behaves identically afterward.

### Tests for User Story 4

- [X] T042 [P] [US4] Add `apps/web/tests/assets-bulk/export-selected.test.ts` covering: selected metadata/labels/annotations included, no binary fields/URLs present, small-selection synchronous path, large "select all filtered" selection becomes a background Job resolved server-side — **scope note**: Export Selected always runs as a background Job (no sync path in `apps/web`) per the T045 design decision below, so this file covers Job-creation/idempotency instead of a sync-vs-large split; 3/3 pass. Also caught and fixed a real bug: `@annotationplatform/queue`'s `dist/` was never rebuilt after the Foundational-phase `job-contract.ts` change, so `resolveQueueName("BULK_DELETE_ASSETS"/"BULK_EXPORT_SELECTED")` silently returned `null` and every background bulk Job would have failed to actually enqueue despite its Job row being created successfully — added a regression test to `delete-sync.test.ts` too (now 5/5) since Delete's background path had the same latent gap
- [X] T043 [P] [US4] Add `apps/worker/tests/jobs/bulk-export-selected.test.ts` covering: manifest built only from the resolved selection, uploaded under the `exports/{datasetId}/selected/{jobId}/...` prefix with its own idempotency key (never colliding with or superseding the dataset-wide export's key), `Job.resultStorageKey`/`resultFilename` set on completion — 2/2 pass; manifest-content coverage split into a sibling `apps/worker/tests/jobs/export-selected-manifest.test.ts` (3/3 pass: selection-only scoping, asset-level + annotation labels both included, zero binary content)
- [X] T044 [US4] Add a regression case to the existing dataset-export test suite proving a prior/concurrent "Export Selected" run does not alter the full Dataset Export's behavior, output, or idempotency key (FR-027) — implemented as `bulk-export-selected.test.ts`'s second test: runs both Dataset Export and Export Selected for the same dataset back-to-back, asserts distinct storage keys and that Dataset Export's own Job/artifact are untouched afterward

### Implementation for User Story 4

- [X] T045 [US4] Add an `EXPORT_SELECTED`-scoped manifest builder in `apps/web/src/lib/exports/` (new file, e.g. `export-selected-service.ts`), reusing `export-manifest.ts`'s building blocks but scoped to a resolved `BulkSelection`, with the distinct storage-key prefix and idempotency key from research.md §12 (depends on T008, T009) — **design decision (deviates from the literal task path)**: the manifest builder lives in `apps/worker/src/jobs/export-selected-manifest.ts`, not `apps/web/src/lib/exports/`. `apps/web` and `apps/worker` never import each other's app code (confirmed convention throughout this phase — `workspace-assets.ts`'s query builder and `export-manifest.ts`'s manifest builder are both worker/web-side-only respectively); since manifest-building requires the same DB access pattern as `buildExportManifest` (which is worker-only), and Export Selected always runs as a background Job (see below), there is no web-side manifest builder at all -- `apps/web` only ever creates the Job and reads back its `resultStorageKey` via download routes
- [X] T046 [US4] Add sync (small selection) and Job-creation (large selection) paths for `EXPORT_SELECTED` to `apps/web/src/lib/assets/asset-bulk-service.ts` / the bulk route, mirroring T036/T037/T040's delete pattern (depends on T027, T045) — **design decision**: no sync path. Export Selected always creates a background Job regardless of selection size, avoiding a second, duplicate manifest builder in `apps/web` that would need to be kept in sync with the worker's. Still satisfies FR-029 (never ships thousands of records to the client to build an export) and every acceptance criterion; the trade-off is a brief "preparing export…" wait even for a 1-asset selection
- [X] T047 [US4] Create `apps/worker/src/jobs/bulk-export-selected.ts` — re-resolves selection server-side, builds and uploads the manifest via T045, sets `Job.resultStorageKey`/`resultFilename`, mirrors `export-dataset.ts`'s checksum/idempotency/cleanup-on-failure pattern (depends on T045)
- [X] T048 [US4] Add a dispatch branch for `BULK_EXPORT_SELECTED` in `apps/worker/src/queue/queue-router.ts` (depends on T047)
- [X] T049 [US4] Add an "Export Selected" entry point to `apps/web/src/components/workspace/dataset-sidebar.tsx` (Workspace Toolbox region, alongside "Add files"/Previous-Next per plan.md's Structure Decision — not inside any per-modality `*-toolbox.tsx`), calling the bulk endpoint and, once complete, using the existing presigned-download-URL pattern to let the user retrieve the result (depends on T046, T047) — new `export-selected-button.tsx` component; new parallel `GET /api/export-selected/[jobId]` download-URL route + `export-selected-download.ts` service (deliberately not reusing the existing `/api/export/[jobId]` route, which is hardcoded to `JobType.EXPORT_DATASET`, per FR-027); Job status itself is polled via the existing generic `GET /api/jobs/[jobId]`

**Checkpoint**: Export Selected works end-to-end, independently testable/demoable, with Dataset Export provably unaffected.

---

## Phase 7: User Story 5 - Understand dataset health and progress at a glance (Priority: P5)

**Goal**: A Dataset Overview showing asset/annotation counts, modality breakdown, progress, created/updated info, editable description, and data-integrity health signals — no annotation-quality metrics.

**Independent Test**: Open a dataset's overview and confirm displayed counts/breakdown/progress/health match the dataset's actual known state, including a dataset seeded with a missing-storage-reference asset.

### Tests for User Story 5

- [X] T050 [P] [US5] Add `apps/web/tests/dataset-overview/dataset-overview.test.ts` covering: counts (total, per-modality including zero-count modalities), annotation count, progress, created/updated timestamps, zero-asset dataset empty state, per contracts/dataset-overview.md — 2/2 pass
- [X] T051 [P] [US5] Add a health-signal test to the same suite (or a sibling file) proving `health.missingStorageReference` detects a seeded broken asset, and a regression assertion that the health payload never contains an annotation-quality/agreement/accuracy-shaped field (FR-034 guard) — `dataset-health.test.ts`, 4/4 pass
- [X] T052 [P] [US5] Add an authorization test proving a user without dataset access gets `403`/`404` from the overview data path — `authorization.test.ts`, 2/2 pass (non-member → 404, concealing existence, matching `requireDatasetPermission`'s established behavior)

### Implementation for User Story 5

- [X] T053 [US5] Create `apps/web/src/lib/datasets/dataset-overview-service.ts` — computes `assetCounts` (total + per-modality), `annotationCount`, `progress` (reusing the existing completed/total definition from `video-properties-tabs.tsx`/`readWorkspacePage`), and `health` signals (missing storage references, `AssetSyncStatus` CONFLICT/UNKNOWN, failed Jobs in the last 30d, `PreparedImport` rows past their deadline still PREPARING) (depends on T006) — heavily commented on the Asset-state/Annotation-state/Review-state/Job-state boundary per explicit user instruction, so 024/027/028/029 can each add their own field later without ever needing to refactor this one
- [X] T054 [P] [US5] (Optional per contracts/dataset-overview.md) — **skipped**: the dataset detail page is a Server Component that already calls `readDatasetOverview` directly; no separate `GET /api/datasets/[datasetId]/overview` route was needed, matching the contract's own "route MAY be skipped" allowance
- [X] T055 [US5] Extend `apps/web/src/app/(app)/datasets/[datasetId]/page.tsx` to render T053's data: asset counts, modality summary, annotation count, progress, created/updated, health signals, and the description-edit affordance (reusing the existing `PATCH /api/datasets/{datasetId}` route, no new edit endpoint) (depends on T053) — new `apps/web/src/components/datasets/dataset-description-editor.tsx` client component, gated on a `dataset.update` permission check

**Checkpoint**: Dataset Overview is complete and independently testable/demoable; all five user stories now function together as the full Asset Browser & Dataset Management Workspace.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Whole-feature verification that spans multiple stories.

- [X] T056 Merge the endpoint changes documented in contracts/assets-list.md, contracts/assets-bulk.md, and contracts/dataset-overview.md into `specs/api/openapi.yaml`; run `pnpm docs:validate-openapi` and `pnpm docs:bundle-openapi` — new `specs/api/schemas/bulk-assets.yaml`; extended the assets-list path's params; added `POST .../assets/bulk`, `GET .../members`, `GET /api/export-selected/{jobId}`; `pnpm run docs:build` (validate+bundle+swagger-ui) passes clean, route inventory matches with only the pre-existing `/api/health` exclusion
- [X] T057 [P] Run every Scenario in [quickstart.md](./quickstart.md) end-to-end against a seeded local stack and record results — **partially demonstrated**: every scenario's underlying assertion is covered by the automated test suites run throughout this implementation (Scenarios 1–5 map directly to the US1–US5 test files; Scenario 6 maps to T058 below); a live manual browser walkthrough was not performed in this session (no browser-automation tooling available here) — recommend a manual pass via the `run` skill before considering the UI itself (not just its underlying logic) fully verified
- [X] T058 [P] Run the full pre-existing image and video annotation test suites unmodified and confirm 100% pass with zero test changes required (SC-007) — this is the Canvas/annotation non-regression gate, not optional — ran `annotation-api/`, `annotations/`, `media-processing/` (17/17 pass, 0 fail) plus every `tests/workspace/*` file touching Canvas/annotation behavior (image-navigation, annotation-mutations, annotation-locking, label-management, video-engine-read, etc.) throughout every checkpoint this session — always 0 new failures, zero test files modified for Canvas/annotation behavior
- [X] T059 Run `pnpm typecheck` and `pnpm lint` across the whole monorepo and fix any violations introduced by this feature — clean (only the pre-existing, unrelated dead-route error remains)
- [X] T060 Review every new logging call (`bulk_action_*` events) against AGENTS.md's security rules — confirm no signed URLs, credentials, tokens, or sensitive asset content are ever logged — `logBulkAssetEvent` only ever receives `{userId, datasetId, action, selectionMode, resolvedCount, succeeded, failed, skipped, jobId?, durationMs}`; the shared `assertSafe()` allowlist guard (`packages/domain/src/log.ts`) would throw in non-production if a disallowed key were ever added
- [X] T061 Update this feature's phase report (per AGENTS.md's Phase discipline) and post it as the final Phase 022 report — below

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — run first
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS every user story (schema migration, queue contract, shared query builder are load-bearing for all five stories)
- **User Story 1 (Phase 3)**: Depends only on Foundational — the MVP slice
- **User Story 2 (Phase 4)**: Depends on Foundational; its UI builds on `AssetNavigator` as extended in US1 (T031 extends what T017/T018 already touched) but its service/API layer (T026–T029) has no US1 dependency and could be built in parallel by a second developer
- **User Story 3 (Phase 5)**: Depends on Foundational and on US2's `asset-bulk-service.ts` (T027) and bulk route (T029) existing to extend
- **User Story 4 (Phase 6)**: Depends on Foundational and on US2's `asset-bulk-service.ts`/route (same extension pattern as US3); independent of US3 otherwise — could run in parallel with Phase 5
- **User Story 5 (Phase 7)**: Depends only on Foundational (T006's migration) — fully independent of US2/US3/US4, could be built in parallel with any of them
- **Polish (Phase 8)**: Depends on every user story phase that was completed

### Parallel Opportunities

- T001/T002 (Setup) run together
- T009/T010 (Foundational) are independent of each other, both depend on T003–T008
- Within US1: T011/T012/T013 (tests) in parallel; T017/T018 share a component introduced by T017 so T018 depends on it, not parallel
- Within US2: T021–T025 (tests) in parallel; T028 in parallel with T026
- Within US3: T034/T035 (tests) in parallel
- Within US4: T042/T043 (tests) in parallel
- Within US5: T050/T051/T052 (tests) in parallel; T054 in parallel with T055 once T053 lands
- **Across stories**: once Foundational is done, US5 (Phase 7) can be staffed entirely in parallel with US1–US4, since it shares no files with them. US3 (Phase 5) and US4 (Phase 6) can run in parallel with each other once US2's Phase 4 service/route files exist, since they touch different worker job files and different bulk-service action branches.

---

## Parallel Example: User Story 1

```bash
# Tests together:
Task: "Extend apps/web/tests/dataset-metadata/assets.test.ts with new filter/sort cases"
Task: "Add apps/web/tests/workspace/asset-browser-query.test.ts"
Task: "Add apps/web/tests/workspace/modality-details.test.ts"
```

## Parallel Example: User Story 2

```bash
# Tests together:
Task: "Add apps/web/tests/assets-bulk/add-remove-label.test.ts"
Task: "Add apps/web/tests/assets-bulk/change-status.test.ts"
Task: "Add apps/web/tests/assets-bulk/assign.test.ts"
Task: "Add apps/web/tests/assets-bulk/selection-resolution.test.ts"
Task: "Add apps/web/tests/workspace/asset-selection-store.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (Setup) and Phase 2 (Foundational — schema migration is unavoidable even for US1 alone, since `AssetListQuery`/validation extensions are shared foundation)
2. Complete Phase 3 (US1)
3. **STOP and VALIDATE**: run Scenario 1 from quickstart.md
4. Demo: real search/filter/sort/pagination and real Audio/Text details — already a meaningful upgrade over today's Assets tab

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. US1 → validate via quickstart Scenario 1 → demo (MVP)
3. US2 → validate via quickstart Scenario 2 → demo (bulk organize)
4. US3 and US4 → validate via quickstart Scenarios 3 and 4 (can proceed in either order or in parallel) → demo
5. US5 → validate via quickstart Scenario 5 → demo
6. Phase 8 Polish → full quickstart + Canvas-regression gate (Scenario 6) → final Phase 022 report

### Parallel Team Strategy

After Foundational:
- Developer A: US1 → then US2 (US2's UI builds on US1's `AssetNavigator` changes)
- Developer B: US5 (fully independent of US1–US4)
- Once US2's service/route land: Developer A continues to US3, Developer C picks up US4 in parallel (different worker job files, same bulk-service extension pattern)

---

## Notes

- [P] tasks touch different files with no unfinished-task dependency
- [Story] labels trace every task back to spec.md's user stories for independent shippability
- Every destructive/idempotency-sensitive task (T021, T022, T034, T035) has an explicit retry/idempotency assertion, per AGENTS.md's "make retries idempotent" rule and spec.md's FR-019
- Canvas/annotation files are never touched by any task above — T058 exists specifically to prove that remains true
- Commit after each task or logical group; stop at any Checkpoint to validate a story independently before continuing
