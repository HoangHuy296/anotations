---
description: "Task list for Phase 029 — Modality-Specific Datasets"
---

# Tasks: Phase 029 — Modality-Specific Datasets

**Input**: `specs/029-modality-specific-datasets/` (spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md, implementation-review.md)

**Generated**: 2026-10-05, against commit `e8f0955` (Phase 029 candidate). Items already present in that commit are marked `[X]`; this file does not claim they are release-verified (G5 is OPEN per `verification/mvp-modality-card-status-20261005.md`).

**Tests**: Requested by spec §10 / quickstart.md, so test tasks are included.

## Format: `[ID] [P?] [Story] Description`

## HARD GATES (AGENTS.md + spec §11 + implementation-review §11)

Tasks tagged **[GATE]** MUST NOT be executed without explicit, scoped user approval. Implementing agents stop at each one and report.

- **G-SQL**: Custom Phase 029 trigger SQL / receipt fields / counter (new SQL approval, not inherited).
- **G-MIG**: Applying any migration to the shared dev DB (`annotationplatformdev-postgres-1`) or regenerating the Prisma client from an unapplied schema. Never rewrite existing migrations or `.env*`.
- **G-DATA**: Any historical backfill/assignment/EMPTY resolution against real Datasets (approved IDs only; 66 historical duplicate Assets and MIXED data stay untouched).
- **G-DEPLOY**: Rebuilding/restarting `annotationplatformdev-*` containers (would 500 on `Dataset.modality` until G-MIG is done).
- No new npm packages. Tests run only against disposable DB/storage.

---

## Phase 1: Setup

- [X] T001 Point `.specify/feature.json` at the 029 feature
- [X] T002 Spec, plan, research, data-model, contracts, quickstart authored in `specs/029-modality-specific-datasets/`
- [ ] T003 Update `docs/architecture.md`, `docs/job-system.md` and `AGENTS.md` ("Asset.modality selects the workspace engine") to state Dataset.modality selects the engine (spec §1 requires an explicit edit; AGENTS.md edit needs user sign-off)

---

## Phase 2: Foundational (blocks all stories)

- [X] T004 Add nullable `Dataset.modality`, `modalityContentRevision`, `modalityResolvedAt`, resolver attribution to `prisma/schema.prisma`
- [X] T005 [P] Pure compatibility/classification contracts and `dataset-modality` subpath export in `packages/domain/src/`
- [X] T006 Candidate migration SQL kept as a proposal in `specs/proposals/phase029-modality/` (not in `prisma/migrations/`)
- [ ] T007 **[GATE G-SQL]** Obtain approval for triggers/counter/receipt SQL and resolver-FK `Restrict` behaviour (implementation-review §11 items 1–2)
- [ ] T008 **[GATE G-MIG]** Resolve the migration-candidate provenance gap (SHA `abf72fd2…` → `13f0e977…`, no diff record) at release review; record the decision in `verification/`
- [ ] T009 **[GATE G-MIG]** Apply migration to a *disposable* database and prove apply/rollback/replay; then, only with approval, to shared dev DB

**Checkpoint**: Schema exists in an applied, reviewed migration. Until then the committed code cannot run against the dev DB (P2022).

---

## Phase 3: US1 — Explicit modality at Dataset creation (P1)

**Goal**: Every new Dataset has a required, immutable modality chosen by the user.
**Independent test**: Create four empty Datasets (IMAGE/VIDEO/AUDIO/TEXT); missing/invalid modality is rejected; PATCH cannot change it.

- [X] T010 [US1] Require `modality` on `POST /api/datasets`, `/api/datasets/from-repository`, `/api/imports/local-folder` (Zod in `apps/web/src/lib/validation/`)
- [X] T011 [US1] `ModalityCard` on `/datasets/imports` and `/datasets/local-folder`; append mode shows parent modality fixed
- [X] T012 [P] [US1] `ClassEntry` component + `lib/imports/recommended-classes.ts` boundary (returns `none`)
- [X] T013 [US1] CLOSED 2026-10-05: PATCH `/api/datasets/[datasetId]` returns `409 DATASET_MODALITY_IMMUTABLE` when the body contains `modality` (presence dominates value). Verified by focused disposable run `verification/focused-runs/20261005T082805Z-c1585901` (9/9 PASS; cleanup + independent cleanup PASS; focused-disposable-test, not G3/G5 evidence) via `web:test:dataset-patch-route` (`apps/web/tests/dataset-metadata/dataset-patch-route.test.ts`). Also fixed pre-existing Dataset PATCH metadata-loss defect (`apps/web/src/lib/validation/dataset.ts`: update schema no longer inherits create-time `metadata` default; proof run `…T082449Z-7152eed7` FAILED 3/9 as characterization, earlier `…T080604Z`/`…T081722Z` kept as FAILED harness/test-topology runs)
- [X] T014 [US1] CORRECTION of earlier "NOT FOUND": modality is ALREADY in both idempotency identities — repository: `creationRequestHash` includes `modality` (`apps/web/src/lib/repository-import/types.ts`, asserted by `tests/repository-import-request/acceptance-service.test.ts`); folder: `createPreparation` treats a modality change under a reused key as `IDEMPOTENCY_KEY_CONFLICT` (`prepare-local-folder-import.ts`). Remaining: (a) modality-idempotency portion VERIFIED: `apps/web/tests/local-folder-import/prepare-modality-idempotency.test.ts` 4/4 PASS in focused disposable run `verification/focused-runs/20261005T083827Z-12a06674` via `web:test:local-folder-modality-idempotency` (cleanup + independent cleanup PASS); Redis/queue state is not asserted by that test (DB counts only); (b) the normalized-confirmed-taxonomy half is UNBLOCKED (T015 closed 2026-10-05; its taxonomy-identity behavior is exercised by `verify:confirmed-taxonomy-creation` PASS `focused-runs/20261005T101254Z-b148440d`, disposable only, not G3/G5); T014 CLOSED 2026-10-05 after explicit assessment against its acceptance (modality and normalized taxonomy in both idempotency identities; replay/conflict/no-class behavior verified in disposable runs `…T083827Z-12a06674` and `…T101254Z-b148440d`; not G3/G5). CAVEAT preserved: Redis/queue state is not asserted by these tests (database counts only)
- [X] T015 [US1] CLOSED 2026-10-05 (disposable verification only; not G3/G5; no shared-dev migration/regeneration authorized). Contract as resolved: optional strict `confirmedClasses: string[]` 0..100 (101 → 400 before side effects); absent/[] = none; normalized duplicate → 400; `normalizeLabelName` unchanged; identity = sorted normalized set; Labels `modality = Dataset.modality`, `scope = OBJECT`; deterministic bounded color from the 24 presets; `POST /api/datasets` stays non-idempotent; folder identity in nullable `PreparedImport.creationRequestHash` (NULL for no-class). Evidence: `verify:confirmed-taxonomy-creation` PASS `focused-runs/20261005T101254Z-b148440d` (earlier FAILED `…T101135Z-15df4e63` preserved: test-helper defect); `compat:prepared-import-creation-request-hash` PASS `…T095654Z-7aeb542a`; migration-25 rehearsal PASS `…T090512Z-7478b8a9`; UI vitest 70/70 PASS `…T142520Z-89ad53a6` (earlier FAILED `…T102702Z-4f5e22ab`, `…T141451Z-af4119c4` and orphaned `…T142448Z-6f068c7e` preserved: infra findings). Migration 25 remains a PROPOSAL (`specs/proposals/phase029-modality/…`), not in `prisma/migrations`, not applied to shared dev. DOM visual error rendering is out of T015 scope. See `verification/closure-matrix-20261005.md`
- [ ] T016 [P] [US1] PARTIAL, per evidence: `specs/api/schemas/dataset.yaml` (create request: required `modality`, `confirmedClasses` 0..100) and `schemas/import-repository.yaml` (repository import and local-folder start: `modality`, `confirmedClasses`) are updated and the resolution route documents `DATASET_MODALITY_IMMUTABLE`/UNRESOLVED. NOT evidenced: `pnpm docs:validate-openapi` has not been run this phase; `specs/api/dist/openapi.bundle.yaml` has no `confirmedClasses` (stale/unbundled); `PATCH /api/datasets/{datasetId}` 409 `DATASET_MODALITY_IMMUTABLE` (T013 behavior) is not found in the OpenAPI source. Remaining: document the PATCH 409, run `docs:validate-openapi`, rebuild the bundle only if approved

---

## Phase 4: US2 — Ingestion cannot publish mismatched content (P1)

**Goal**: Zero mismatched Asset commits for resolved Datasets on every writer path.
**Independent test**: Spoofed extension/MIME and ambiguous media never publish; valid-then-incompatible import keeps valid Assets and ends failed/incomplete with correct counts.

- [X] T017 [US2] Guards on direct, prepared, folder and repository publication; `ASSET_MODALITY_MISMATCH` / `DATASET_MODALITY_UNRESOLVED` codes
- [ ] T018 [US2] Audit every Asset writer against spec §3.2 inventory (create/upsert/nested/reparent/restore, dormant `persistDatasetImport`); re-run production-code search; record results — OPEN / VERIFICATION PENDING (not closed by existing implementation). Prepared: offline writer-inventory source-scan test (6/6 offline) and `verification/writer-inventory.md`; both are static evidence, not a guarded run. Dormant `persistDatasetImport` (no callers) intentionally unmodified
- [ ] T019 [US2] VERIFIED for the four replay paths in disposable runs (not G3/G5; limitation kept): outer upload replay, in-transaction concurrent duplicate, prepared completed-item replay (unchanged / unresolved parent / changed parent) and mismatched publish incl. M24 trigger bypass: `verify:ingestion-replay-summary` PASS 12/12 `focused-runs/20261005T151306Z-8ef5d532` (chain through M25, disposable); repository reconciliation reuse ×4 modalities: `worker:test:ingestion-replay-reuse` PASS 4/4 `…T151630Z-444947ca` (M24 plan). Assertions are Asset/subtype row counts, not only status codes. LIMITATIONS: providers were an in-memory object store behind a module-load stub (real capability signing/byte verification/publish/commit ran; real MinIO and HTTP upload did not); unresolved/changed-parent guards were proven by fault injection because M24 makes those parent states unreachable by real rows; T019 does not close T018 or T021. Item stays open only for the T018 audit/other acceptance items
- [X] T020 [US2] VERIFIED in disposable runs (not G3/G5): mixed batch (2 accepted, 1 rejected by wrong bytes, 1 unprocessed) → 409 `IMPORT_INCOMPLETE` with exact counts, Job FAILED, PreparedImport not COMMITTED, published Assets preserved, no Asset for the rejected item, retry cannot publish it without verified bytes, stable rejection event, replayed commit identical; fully completed control → COMPLETED, `unprocessed` 0, replay creates nothing. Evidence: `verify:ingestion-replay-summary` PASS 12/12 `focused-runs/20261005T151306Z-8ef5d532` (tests 11, 12). Earlier M24-only run `…T150248Z-87f15204` FAILED 11/12 (test 12: tracked client needs migration 25's column) and is preserved as an environment/plan finding. Same stub/fault-injection limitations as T019
- [ ] T021 [P] [US2] PARTIAL (g4-upload-publisher, g4-modality-boundary, g5-modality-routing tests exist; spoofed MIME/ambiguous/old-job cases not confirmed): integration tests per implementation-review §10 (spoofed MIME/ext, ambiguous containers, source identity change, queued old jobs) in `apps/web/tests/` and `apps/worker/tests/` — OPEN (unchanged; no run covers spoofed MIME/ambiguous containers/source identity change/queued old jobs)
- [ ] T022 [US2] Document fail-closed limitation for ambiguous synchronous formats (implementation-review §11 item 4 needs user confirmation) — OPEN (unchanged, separated)

---

## Phase 5: US3 — Dataset-driven workspace engine (P2)

**Goal**: `/workspace/[datasetId]` picks the engine from Dataset.modality only.
**Independent test**: Four empty Datasets render their own engine; wrong-modality Asset in query/client state cannot override; COMPLETED → visualization, others → workspace.

- [X] T023 [US3] Server-side Dataset load and engine dispatch from Dataset.modality; unresolved/EMPTY/MIXED states
- [X] T024 [US3] Modality-resolution route (code present; authorisation model needs T027 review)
- [ ] T025 [US3] Validate selected Asset datasetId/modality/state and fail closed on mismatch; preserve flush-before-navigation and revisions
- [ ] T026 [P] [US3] Workspace tests: four empty shells, stale/foreign Asset in query, lifecycle destinations, reopened-viewer guard
- [ ] T027 [US3] PARTIAL (`canResolveEmptyDataset` owner/admin check + `DATASET_NOT_EMPTY` exist in `apps/web/src/lib/datasets/modality.ts`; MANAGER-denied, audit event and concurrent-insert tests not confirmed): verify EMPTY resolution is owner/system-admin only (MANAGER denied), idempotent, audited, and rejects if an Asset was inserted concurrently
- [ ] T028 [US3] Separate UI discrepancy: `dataset-row-actions.tsx` still uses centered `showModal()`; implement anchored panel only as its own approved change

---

## Phase 6: US4 — Historical data resolution (P3) — all **[GATE G-DATA]**

- [ ] T029 [US4] Fresh read-only dry run (select-only Prisma): classify all Assets incl. archived/deleted; record candidate ID, proposed modality, counter
- [ ] T030 [US4] Remediate 523 unverified source assets / 22 missing subtypes before affected backfill
- [ ] T031 [US4] Per-candidate Serializable assignment with fence/counter protocol for approved IDs only
- [ ] T032 [US4] MIXED stays null/blocked; no split/move/delete/relabel (separate future approval)

---

## Phase 7: US5 — DB backstop and release validation (P3)

- [ ] T033 [US5] **[GATE G-SQL]** Install triggers/fence in a new reviewed migration; direct-DB tests: null rejected, non-null immutable (even with zero Assets), all-Asset equality incl. reparent/restore
- [ ] T034 [US5] Two-connection race tests (publish vs assignment, empty-resolution vs insert, reparent both directions, deadlock/serialization retry)
- [ ] T035 [US5] Final composite FK / NOT NULL only after all history resolved; otherwise stop at nullable and report blocked
- [ ] T036 [US5] Regression: Phases 022–028 + visualization suites per quickstart.md (`pnpm db:validate typecheck lint docs:validate-openapi build` and web/worker suites)
- [ ] T037 [US5] **[GATE G-DEPLOY]** Coordinated web+worker+realtime rebuild with migration already applied; browser/a11y smoke on disposable fixtures
- [ ] T038 [US5] Rollback/evidence report; note G5 remains OPEN until the `localhost:9000` probe interception and independent cleanup receipt generator/verifier (status note, defects 1–2) are fixed and re-run

---

## Dependencies

T004–T006 (done) → T007–T009 (gates) → US1 T013–T016 ∥ US2 T018–T022 → US3 T025–T028 → US4 (needs T033 protocol design + G-DATA) → US5 T033–T038.
US1, US2, US3 code tasks that don't need a live DB can proceed now using disposable DB; everything touching the shared dev DB or deploy waits on gates.

## Parallel opportunities

T012/T016 (US1), T021 (US2), T026 (US3) touch separate files and can run together.

## Suggested next step

MVP of remaining work: **T013, T014, T018–T021, T025–T027** (no gate required, disposable DB only). Ask the user to decide T015 and the G-SQL/G-MIG approvals before anything else.
