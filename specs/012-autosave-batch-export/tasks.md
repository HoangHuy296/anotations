# Tasks: Autosave, Batch Navigation, and Dataset Export

**Input**: Design documents from `/specs/012-autosave-batch-export/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), and [contracts/](./contracts/)

**Tests**: Required. The specification requires unit, HTTP authorization, worker, controlled Redis/BullMQ, PostgreSQL, and MinIO integration evidence. Write focused tests first and do not mark an integration task complete until it has actually run against the controlled dependencies.

**Non-negotiable constraints**:

- No `schema.prisma` change, migration, new dependency, raw SQL, ExportJob table, public worker route, or modality-specific workspace route.
- PostgreSQL is canonical for revisions and Job state. Redis/BullMQ transports only `{ jobId }` and is never browser-visible state.
- Export artifacts are private MinIO bytes; PostgreSQL stores metadata only. Browser responses/manifests never expose credentials, provider tokens, private storage keys/URLs, raw Job input/state/result/event data, queue internals, or binary data. The sole allowed URL exception is an authorized short-lived object-scoped download capability; it must not expose bucket/key/provider configuration or be persisted/logged.
- Full queue integration must require configured passworded loopback Redis with a dedicated non-zero DB and prefix. It must not fall back to unauthenticated `localhost:6379` or disturb the normal queue namespace.

## Phase 1: Setup and Test Harness

**Purpose**: Establish focused, real-dependency test scaffolding and validation helpers without changing the schema or runtime architecture.

- [X] T001 [P] Extend shared authorized workspace fixture and cleanup helpers in `apps/web/tests/workspace/helpers.ts` for two-session revision-conflict, 250-Asset, and Dataset-member test data.
- [X] T002 [P] Extend controlled queue/HTTP fixture helpers in `apps/web/tests/job-queue/helpers.ts` to require the existing safe Redis test configuration and redact all secret-bearing configuration from failures.
- [X] T003 [P] Add private worker export fixture helpers for Job, Dataset metadata, and deterministic MinIO object cleanup in `apps/worker/tests/queue/helpers.ts`.
- [X] T004 Record the Phase 012 no-schema/no-migration/no-new-dependency boundary and controlled-runtime prerequisites in `specs/012-autosave-batch-export/quickstart.md`.

**Checkpoint**: Test harness can create authorized isolated data and controlled queue/storage fixtures without printing credentials or using mocks for final integration evidence.

---

## Phase 2: Foundational Contracts and Guards

**Purpose**: Define the common validation, safe projection, and authorization primitives that block all Phase 012 stories.

- [X] T005 [P] Add strict export request/configuration and safe export response Zod schemas in `apps/web/src/lib/validation/export.ts` using JSON format/schema version only and rejecting unknown input.
- [X] T006 [P] Extend workspace list-query validation for bounded filename query, repeated/multi-status filters, page, and selected asset in `apps/web/src/lib/validation/image-workspace.ts`.
- [X] T007 [P] Add server-only safe export DTO and manifest type definitions in `apps/web/src/lib/exports/types.ts` without private storage location or raw Job fields.
- [X] T008 Add Dataset-scoped export authorization and type eligibility helpers in `apps/web/src/lib/exports/authorization.ts`, reusing current session and `job.createExport` permissions without trusting browser ownership fields.
- [X] T009 Add foundational schema/authorization/redaction regression coverage in `apps/web/tests/job-queue/export-foundation.test.ts` for malformed input, non-member concealment, forbidden known-member access, and no side effect.

**Checkpoint**: All inputs and browser DTOs are strictly bounded; no story may bypass the existing effective Dataset permission model.

---

## Phase 3: User Story 1 — Preserve Annotation Work While Navigating (Priority: P1) 🎯 MVP

**Goal**: A labeling user gets truthful 1.5-second autosave and conflict feedback, and cannot lose a pending draft when navigating.

**Independent Test**: Change annotation geometry and Asset description, wait 1.5 seconds, reload to observe durable values/revisions; make a second-session stale edit and verify it conflicts without overwriting or dropping the local draft.

### Tests for User Story 1

- [X] T010 [P] [US1] Add debounce, replacement-timer, save-state, and awaited-flush unit tests in `apps/web/tests/workspace/autosave-state.test.ts`.
- [X] T011 [P] [US1] Add two-session annotation stale-revision/no-overwrite regression cases in `apps/web/tests/workspace/annotation-locking.test.ts`.
- [X] T012 [P] [US1] Add Asset-description revision conflict and reload-persistence cases in `apps/web/tests/workspace/description-locking.test.ts`.
- [X] T013 [P] [US1] Add navigation-with-pending-save, failed-save, and conflict-draft retention coverage in `apps/web/tests/workspace/image-navigation.test.ts`.

### Implementation for User Story 1

- [X] T014 [US1] Add per-resource dirty draft tracking and an awaited, idempotent `flushAutosave` operation to `apps/web/src/stores/annotation-store.ts`; preserve local drafts on failed/conflict result.
- [X] T015 [US1] Wire semantic annotation action-end mutations to the 1.5-second scheduler in `apps/web/src/components/workspace/annotation-canvas.tsx` without scheduling during pan, zoom, pointer-move, or transform-preview loops.
- [X] T016 [US1] Wire description edit scheduling, flush outcome handling, and current returned Asset revision updates in `apps/web/src/components/workspace/properties-panel.tsx`.
- [X] T017 [US1] Update guarded mutation outcome handling in `apps/web/src/app/(app)/workspace/[datasetId]/actions.ts` and `apps/web/src/lib/workspace/image-mutations.ts` so every success returns the current revision and every stale/unauthorized/missing mutation has no partial write.
- [X] T018 [US1] Implement explicit reload/discard/reconcile actions that preserve conflict drafts in `apps/web/src/components/workspace/save-conflict-panel.tsx`.
- [X] T019 [US1] Add save-state and navigation guard integration to `apps/web/src/components/workspace/dataset-sidebar.tsx` so previous/next waits for flush and blocks automatic discard on error/conflict.
- [X] T020 [US1] Surface aggregate dirty/saving/saved/error/conflict state without exposing draft contents in `apps/web/src/components/workspace/workspace-header.tsx`.
- [X] T021 [US1] Run and record the focused workspace autosave/conflict suite in `apps/web/tests/workspace/autosave-state.test.ts`, `apps/web/tests/workspace/annotation-locking.test.ts`, `apps/web/tests/workspace/description-locking.test.ts`, and `apps/web/tests/workspace/image-navigation.test.ts`.

**Checkpoint**: Autosave begins at 1.5 seconds idle; reload shows saved data; stale saves cannot overwrite; pending drafts are flushed or explicitly resolved before navigation.

---

## Phase 4: User Story 2 — Find and Work Through the Right Batch (Priority: P1)

**Goal**: A Dataset member searches and filters the complete authorized Asset list, sees progress, and navigates previous/next inside the active filtered order.

**Independent Test**: In a 250-Asset Dataset, search a filename substring, apply multiple statuses, select an Asset outside page one, and confirm page size, Dataset progress, and previous/next remain constrained to the result set.

### Tests for User Story 2

- [X] T022 [P] [US2] Add 250-Asset case-insensitive full-Dataset search, multi-status filter, stable order, and page-size boundary tests in `apps/web/tests/workspace/image-workspace-http.test.ts`.
- [X] T023 [P] [US2] Add filtered previous/next, selected-Asset reconciliation, empty-result, and page-boundary tests in `apps/web/tests/workspace/image-navigation.test.ts`.
- [X] T024 [P] [US2] Add authorized Dataset progress and non-member/no-data-disclosure tests in `apps/web/tests/workspace/workspace-authorization.test.ts`.

### Implementation for User Story 2

- [X] T025 [US2] Extend the safe list query parser for repeated/multi-status filter values and bounded search/page inputs in `apps/web/src/lib/validation/image-workspace.ts`.
- [X] T026 [US2] Update the Dataset-scoped workspace read model to apply the validated filtered order consistently, cap pages at 100, reconcile selection, and return safe progress aggregates in `apps/web/src/lib/workspace/image-workspace.ts`.
- [X] T027 [US2] Update workspace query parsing and authorized server data loading to retain `q`, statuses, page, and selected asset safely in `apps/web/src/app/(app)/workspace/[datasetId]/page.tsx`.
- [X] T028 [US2] Render a single-status selector with an `All statuses` reset, search, empty state, 100-item pagination, Dataset progress, and stable selected-asset context in `apps/web/src/components/workspace/properties-panel.tsx`. The backend and URL contract continue to accept repeated status values.
- [X] T029 [US2] Make previous/next generate URLs from the same filtered order and preserve query/filter/page state in `apps/web/src/components/workspace/dataset-sidebar.tsx`.
- [X] T030 [US2] Run and record the focused workspace list/navigation/authorization suite in `apps/web/tests/workspace/image-workspace-http.test.ts`, `apps/web/tests/workspace/image-navigation.test.ts`, and `apps/web/tests/workspace/workspace-authorization.test.ts`.

**Checkpoint**: Search/filter/page/navigation is a single authorized Dataset-scoped flow; every batch has at most 100 Assets and navigation never escapes the active result set.

---

## Phase 5: User Story 3 — Start and Monitor a Dataset Export (Priority: P1)

**Goal**: An authorized user creates a durable export Job, the private worker claims and processes it, and the user sees only safe PostgreSQL-backed status and a short-lived authorized download capability.

**Independent Test**: Start an export through authenticated HTTP, inspect the one-item queue payload, run controlled worker delivery, observe PostgreSQL progress/completion, and fetch safe status/download as the authorized user.

### Tests for User Story 3

- [X] T031 [P] [US3] Add authenticated HTTP create-export contract tests for durable `EXPORT_DATASET` Job creation, server-derived idempotency, and exact safe response projection in `apps/web/tests/job-queue/export-create-route.test.ts`.
- [X] T032 [P] [US3] Add enqueue transport tests that inspect the controlled queue payload and assert it is exactly `{ jobId }`, with no raw export data or credentials, in `apps/web/tests/job-queue/export-enqueue.test.ts`.
- [X] T033 [P] [US3] Add worker receipt/claim/progress/cancel lifecycle tests for `EXPORT_DATASET` using PostgreSQL and a current lock token in `apps/worker/tests/queue/export-dataset-worker.test.ts`.
- [X] T034 [P] [US3] Add authenticated safe status/download, unauthorized concealment, forbidden action, and response-redaction tests in `apps/web/tests/job-queue/export-status-route.test.ts`.

### Implementation for User Story 3

- [X] T035 [US3] Implement strict export configuration parsing, canonical idempotency-key derivation, and safe create/status DTO mapping in `apps/web/src/lib/exports/export-service.ts`.
- [X] T036 [US3] Implement authenticated `POST /api/export` with create-or-reconcile PostgreSQL Job then existing enqueue flow in `apps/web/src/app/api/export/route.ts`; leave a recoverable `QUEUED` Job on queue outage.
- [X] T037 [US3] Implement authorized `GET /api/export/[jobId]` safe status and completed-artifact download-capability boundary in `apps/web/src/app/api/export/[jobId]/route.ts` without returning private artifact metadata.
- [X] T038 [US3] Implement private worker `EXPORT_DATASET` dispatch after atomic claim in `apps/worker/src/queue/queue-router.ts`, pass the current claim context only internally, and retain current unsupported-type behavior.
- [X] T039 [US3] Implement lock-token-guarded export lifecycle/progress/event updates and cancellation acknowledgement in `apps/worker/src/jobs/export-dataset.ts` using existing helpers in `apps/worker/src/jobs/job.repository.ts` and `apps/worker/src/jobs/job-event-writer.ts`.
- [X] T040 [US3] Implement server-only private artifact capability issuance with existence verification in `apps/web/src/lib/exports/export-download.ts` using `apps/web/src/lib/providers.ts`; do not expose bucket/key/provider configuration.
- [X] T041 [US3] Run controlled PostgreSQL/Redis worker integration for create → `{ jobId }` enqueue → worker receipt → atomic claim → PostgreSQL progress/cancel acknowledgement, recording only redacted nonterminal lifecycle evidence in `specs/012-autosave-batch-export/quickstart.md`.

**Checkpoint**: Durable submission, exact queue transport, worker receipt, atomic claim, PostgreSQL progress, cancellation acknowledgement, and safe nonterminal status are proven. Artifact completion/download proof is deferred until the manifest and MinIO tasks in Phase 6 are complete.

---

## Phase 6: User Story 4 — Produce a Portable Annotation Manifest (Priority: P2)

**Goal**: The completed artifact is a deterministic, complete JSON metadata manifest with safe storage references and no binary or secret leakage.

**Independent Test**: Export a Dataset containing Assets, Labels, and Annotations, validate every manifest section/order/reference, and prove that bytes, credentials, private keys/URLs, raw Job fields, and raw queue data are absent.

### Tests for User Story 4

- [X] T042 [P] [US4] Add manifest schema/order/reference and metadata-only redaction tests in `apps/worker/tests/queue/export-manifest.test.ts`.
- [X] T043 [P] [US4] Add controlled MinIO artifact existence, deterministic retry/re-delivery reconciliation, and no-duplicate-artifact tests in `apps/worker/tests/queue/export-artifact-reconciliation.test.ts`.
- [X] T044 [P] [US4] Add HTTP download body/redaction coverage for required manifest content and prohibited fields in `apps/web/tests/job-queue/export-download.test.ts`.

### Implementation for User Story 4

- [X] T045 [US4] Implement stable Dataset/Asset/Label/Annotation metadata reads and canonical JSON manifest construction in `apps/worker/src/jobs/export-manifest.ts` according to `specs/012-autosave-batch-export/contracts/export-manifest.md`.
- [X] T046 [US4] Integrate manifest validation, deterministic private object key derivation, object reconciliation, and MinIO upload into `apps/worker/src/jobs/export-dataset.ts` without storing binary in PostgreSQL.
- [X] T047 [US4] Restrict retry successor context to allowlisted export configuration and preserve one artifact per durable Job in `apps/web/src/lib/jobs/retry-job.ts` and `apps/worker/src/jobs/export-dataset.ts`.
- [X] T048 [US4] Run and record the manifest/artifact/redaction suite in `apps/worker/tests/queue/export-manifest.test.ts`, `apps/worker/tests/queue/export-artifact-reconciliation.test.ts`, and `apps/web/tests/job-queue/export-download.test.ts`.

**Checkpoint**: Completed export JSON contains all required metadata and only safe logical storage references; no binary or private operational data is present, and repeated delivery cannot create duplicate artifact output for one Job.

---

## Phase 7: Security, Runtime Validation, and Documentation

**Purpose**: Prove the complete Phase 012 behavior against real controlled dependencies and close cross-cutting gaps without expanding scope.

- [X] T049 [P] Add complete role, cross-Dataset, and denial no-side-effect matrix for create/read/download and existing export-job cancellation in `apps/web/tests/job-queue/export-ownership-matrix.test.ts`; assert no Job, JobEvent, queue delivery, MinIO object, Asset, Label, Annotation, or Dataset mutation after denial.
- [X] T050 [P] Add controlled Redis transport inspection for export Jobs in `apps/web/tests/job-queue/export-redis-redaction.test.ts`; assert queue payload has only `jobId` and contains no raw export config, manifest, credentials, URL, token, or binary value.
- [X] T051 [P] Add worker cancellation/expired-lock/duplicate-delivery no-side-effect regressions for export Jobs in `apps/worker/tests/queue/export-worker-safety.test.ts`.
- [X] T052 Add a controlled Redis outage/recovery-scanner integration test in `apps/web/tests/job-queue/export-recovery.test.ts`: create the durable Job while delivery is unavailable, assert `QUEUED` plus null enqueue timestamp, restore controlled Redis, and assert exactly one `{ jobId }` delivery with no duplicate Job/artifact.
- [X] T053 Run `pnpm db:validate`, `pnpm db:generate`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` from `package.json`, recording pass/fail outcomes without credentials in `specs/012-autosave-batch-export/quickstart.md`.
- [X] T054 Run the controlled Compose web/worker/PostgreSQL/passworded-Redis/MinIO end-to-end smoke path in `specs/012-autosave-batch-export/quickstart.md`. Assert: HTTP POST creates one durable `EXPORT_DATASET` Job; PostgreSQL records canonical initial queue fields; Redis has exactly `{ jobId }`; worker receives and atomically claims with its lock token; PostgreSQL progress/stage/counters update; one private JSON artifact exists in MinIO; Job records result metadata and becomes `COMPLETED`; authorized GET returns only a safe status plus short-lived capability; capability downloads the redacted manifest; denied create/read/download/cancel causes no Job/JobEvent/queue/storage side effect; and Redis contains no raw export data or credential.
- [X] T055 Audit changed Phase 012 paths against `docs/architecture.md`, `docs/job-system.md`, and `docs/bullmq-postgres-job-flow.md`, then update completion/known-limitations notes in `specs/012-autosave-batch-export/quickstart.md`.
- [X] T056 Update the exact Phase 012 runtime command, controlled-service evidence, redaction statement, completed-task record, and known limitations in `specs/012-autosave-batch-export/quickstart.md` only after T041, T048, T049–T055 have actually passed.

**Checkpoint**: All Phase 012 runtime evidence is real, authorized, redacted, and architecture-compliant. No task is marked complete based only on implementation presence or mocked dependencies.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1** has no implementation dependency.
- **Phase 2** depends on Phase 1 and blocks every story because it establishes validation, safe DTOs, authorization, and controlled test harnesses.
- **US1 / Phase 3** depends on Phase 2.
- **US2 / Phase 4** depends on Phase 2 and should follow US1 because navigation must flush the completed autosave coordinator.
- **US3 / Phase 5** depends on Phase 2 and may start after Phase 2, but its final runtime validation depends on Phase 6 and Phase 7.
- **US4 / Phase 6** depends on the export processor from US3.
- **Phase 7** depends on all desired story phases.

### User story completion order

```text
Setup → Foundation → US1 autosave → US2 search/batch → US3 durable export → US4 manifest → security/runtime validation
```

### Required acceptance mapping for export

| Required proof | Task(s) |
| --- | --- |
| POST creates durable Job | T031, T035–T036, T041, T054 |
| Queue payload exactly `{ jobId }` | T032, T036, T041, T050, T052, T054 |
| Worker receives payload | T033, T038, T041 |
| Worker claims through lock token | T033, T038–T039, T051 |
| Worker writes progress to PostgreSQL | T033, T039, T041, T054 |
| Worker uploads JSON artifact to MinIO | T043, T046, T048, T054 |
| Job becomes `COMPLETED` | T033, T039, T054 |
| GET returns safe status | T034, T037, T054 |
| Authorized download capability works | T034, T037, T040, T044, T054 |
| Unauthorized user cannot create/read/download/cancel | T009, T034, T049, T054 |
| Denied request has no Job/queue/storage side effect | T009, T049, T054 |
| Queue outage is recoverable without duplicate delivery | T036, T052, T054 |
| Redis contains no raw export data/credentials | T032, T050, T052, T054 |

### Parallel opportunities

- T001–T003 can run in parallel.
- T005–T007 can run in parallel after T001–T004.
- Within US1, T010–T013 can run in parallel before T014–T020.
- Within US2, T022–T024 can run in parallel before T025–T029.
- Within US3, T031–T034 can run in parallel before T035–T040.
- Within US4, T042–T044 can run in parallel before T045–T047.
- T049–T052 can run in parallel after US3/US4 implementation stabilizes.

## Implementation Strategy

### MVP first

1. Complete Phases 1–3 and independently validate durable autosave, revision conflict handling, and safe navigation.
2. Complete Phase 4 to make daily labeling navigation scalable and predictable.
3. Stop and validate the full workspace workflow before adding export processor code.

### Export increment

1. Complete Phase 5 through a real controlled Job/queue/worker lifecycle proof.
2. Complete Phase 6 manifest completeness and artifact reconciliation.
3. Complete Phase 7 only after T054 has proven the complete HTTP → PostgreSQL Job → `{ jobId }` → worker claim → MinIO artifact → authorized download flow with real authorization/no-side-effect/Redis-redaction evidence.

### Scope stop

Do not begin a subsequent feature phase while any Phase 012 task is open. Do not replace PostgreSQL Job status with Redis, add binary to PostgreSQL, or broaden the queue payload while resolving a Phase 012 test failure.
