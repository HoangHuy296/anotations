# Tasks: Repository Import Request + Queue Enqueue

**Input**: Design documents from `/specs/015-repository-import-request-queue-enqueue/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md),
[research.md](./research.md), [data-model.md](./data-model.md),
[contracts/](./contracts/), and [quickstart.md](./quickstart.md)

**Tests**: Required. Phase 015 creates durable Dataset/Job state and dispatches
queue work, so unit, authenticated HTTP, authorization/no-side-effect, queue,
and controlled Compose evidence are mandatory.

**Critical gate**: T003 requires explicit user approval before any schema or
migration change. Do **not** implement Tasks T004 onward until it is approved.
The current schema cannot durably satisfy FR-009 for a new Dataset without the
actor-scoped idempotency constraint documented in [data-model.md](./data-model.md).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Parallelizable after stated dependencies are complete.
- **[US#]**: User story traceability.
- Every task includes its exact primary file path.

## Phase 1: Setup and Contract Baseline

**Purpose**: Confirm the existing Phase-014 preflight and canonical queue
boundary that Phase 015 must reuse; no production behavior is changed here.

- [X] T001 Audited the existing safe preflight, `createAndEnqueueNewDatasetSourceImportJob`, and safe Job-status projection; recorded the single-boundary reuse map in `specs/015-repository-import-request-queue-enqueue/research.md`.
- [X] T002 [P] Created authenticated HTTP fixture and isolated PostgreSQL/Redis/MinIO snapshot helpers for repository-import request tests in `apps/web/tests/repository-import-request/helpers.ts`.

---

## Phase 2: Foundational Gate and Shared Acceptance Boundary

**Purpose**: Establish the only durable idempotency boundary and shared
server-only validation before any user-story route/UI work.

**⚠️ BLOCKER**: No task after T003 may be started unless the project owner has
explicitly approved this narrow migration. Do not replace it with a JSON lookup,
Dataset-name lookup, deterministic ID, or `PreparedImport` workaround.

- [X] T003 Approval recorded 2026-07-28: add optional `Dataset.creationIdempotencyKey` and `Dataset.creationRequestHash` with `@@unique([ownerId, creationIdempotencyKey])`; no workflow-specific Job table or application-only deduplication.
- [X] T004 Applied `20260728000000_add_dataset_creation_idempotency` with optional `creationIdempotencyKey`/`creationRequestHash` and the owner-scoped unique index; existing Dataset rows remain unchanged.
- [X] T005 Applied the user-approved `sourceBranch` → `sourceRef` preservation migration, regenerated Prisma, and updated all application callers; `creationIdempotencyKey` remains reserved for the repository-create boundary.
- [X] T006 [P] Defined the strict browser request schema and safe acceptance DTO, rejecting tokens, credential URLs, owner/storage/queue fields, full manifests, and policy overrides in `apps/web/src/lib/validation/repository-import-request.ts`.
- [X] T007 [P] Added safe repository-import input/output types, canonical creation-request hashing, and a Job-input allowlist assertion in `apps/web/src/lib/repository-import/types.ts`.
- [X] T008 Refactored the approved source-backed acceptance service for the Phase-015 provider input, actor/source eligibility, serializable idempotency reuse/conflict handling, and no-second-enqueue behavior in `apps/web/src/lib/queue/enqueue-job.ts` and `apps/web/src/lib/repository-import/acceptance.ts`.
- [X] T009 Preserved commit-before-`enqueueExistingJob`, recoverable `QUEUED` delivery failure, and allowlisted credential-free Job input in `apps/web/src/lib/queue/enqueue-job.ts` and `apps/web/src/lib/repository-import/types.ts`.
- [X] T010 Added repository-import acceptance unit tests for deep input allowlisting, transaction idempotency conflict/reuse reconciliation, and exact `{ jobId }` delivery construction in `apps/web/tests/repository-import-request/acceptance-service.test.ts`.

**Checkpoint**: The migration is approved/applied, a single canonical durable
acceptance boundary exists, and safe test fixtures can observe all state
boundaries.

---

## Phase 3: User Story 1 - Start a Valid Repository Import (Priority: P1) 🎯 MVP

**Goal**: A permitted actor submits a validated public or owned-private
repository request, gets exactly one Dataset + `IMPORT_DATASET` Job, and opens
the returned progress page.

**Independent Test**: Use normal `/api/auth/login` cookie authentication with
controlled provider fixtures. A valid request creates one Dataset/Job and an
isolated BullMQ delivery whose payload is exactly `{ jobId }`; repeating the
same key returns the original safe result with no duplicate delivery.

### Tests for User Story 1

- [X] T011 [P] [US1] Added authenticated HTTP contract tests for valid public GitHub/Gitea repository acceptance and the safe `201` response in `apps/web/tests/repository-import-request/from-repository-route.test.ts`; controlled Compose evidence passed on 2026-07-28.
- [X] T012 [P] [US1] Added authenticated HTTP tests for valid private import with an active owned SourceConnection and safe response redaction in `apps/web/tests/repository-import-request/from-repository-route.test.ts`; controlled Compose evidence passed on 2026-07-28 with the local PAT injected only into the test process.
- [X] T013 [P] [US1] Added duplicate-submit and concurrent same-key integration tests proving one Dataset, one Job, and one delivery in `apps/web/tests/repository-import-request/duplicate-submit.test.ts`; controlled Compose evidence passed on 2026-07-28.
- [X] T014 [P] [US1] Added isolated queue assertions proving successful delivery contains exactly `{ jobId }` and no source/credential/raw Job fields in `apps/web/tests/repository-import-request/queue-delivery.test.ts`; controlled Compose evidence passed on 2026-07-28.

### Implementation for User Story 1

- [X] T015 [US1] Implemented `POST /api/datasets/from-repository` with normal opaque-cookie actor lookup, strict Zod parsing, server-side dataset-create authorization, and safe success/error projection in `apps/web/src/app/api/datasets/from-repository/route.ts`.
- [X] T016 [US1] Re-runs approved read-only Phase-014 preflight before delegating to the canonical acceptance service and preserves public/no-connection and private/owned-connection rules in `apps/web/src/lib/repository-import/acceptance.ts`.
- [X] T017 [US1] Superseded by the approved UI-routing decision: `/datasets/imports` remains the sole repository-import entry point; no `repository-import-wizard.tsx` was created.
- [X] T018 [US1] `/datasets/new` now redirects to `/datasets/imports`; no authenticated second wizard route remains.
- [X] T019 [US1] Confirmed `/datasets/imports` is the sole retained repository-import UI entry point, preserving its approved Gitea public/existing-connection/one-time-PAT flow; `/datasets/new` redirects to it.

**Checkpoint**: A valid public/private request is accepted once, safely queued,
and navigates to the returned Dataset/Job path. No worker clone/import
processing is implemented.

---

## Phase 4: User Story 2 - Reject Unsafe or Inaccessible Repositories Before Writing (Priority: P1)

**Goal**: Invalid, unsafe, inaccessible, or unauthorized source requests
produce stable redacted errors and no durable side effects.

**Independent Test**: Submit the invalid cases through normal cookie-authenticated
HTTP and verify exact Dataset/Job/JobEvent IDs, isolated Redis namespace, and
MinIO prefix remain unchanged.

### Tests for User Story 2

- [X] T020 [P] [US2] Added no-side-effect HTTP tests for malformed body, forbidden fields, unauthenticated actor, and missing dataset-create permission in `apps/web/tests/repository-import-request/no-side-effects.test.ts`; controlled Compose evidence passed 11/11 on 2026-07-28 using normal opaque-cookie auth, Redis DB 15, and `fieldframe-phase015-test`.
- [X] T021 [P] [US2] Added no-side-effect HTTP tests for forbidden provider URL input, unsupported provider, repository missing, ref missing, and root missing in `apps/web/tests/repository-import-request/no-side-effects.test.ts`; controlled Compose evidence passed 12/12 on 2026-07-28. Visibility mismatch remains structurally rejected by the strict request schema before preflight when it would require an incompatible credential mode.
- [X] T022 [P] [US2] Added concealed ownership/state tests for foreign and malformed IDs plus owned expired/revoked SourceConnections in `apps/web/tests/repository-import-request/no-side-effects.test.ts`; the controlled Compose suite passed 13/13 on 2026-07-28 with normal opaque-cookie auth, Redis DB 15, `fieldframe-phase015-test`, and MinIO snapshot evidence. `SourceConnectionStatus` has no `DISABLED` value; its existing `ERROR` state remains covered by the same credential-invalid policy rather than inventing schema/state semantics.
- [X] T023 [P] [US2] Added authenticated HTTP response-redaction assertions for accepted, invalid-body, semantic provider failure, foreign SourceConnection, and expired credential envelopes in `apps/web/tests/repository-import-request/redaction.test.ts`; controlled Compose evidence passed 14/14 on 2026-07-28 without outputting credential/configuration values.
- [X] T024 [P] [US2] Added the controlled real-transport outage/recovery test in `apps/web/tests/repository-import-request/enqueue-recovery.test.ts`; with the web producer pointed at an unused Redis port, normal cookie HTTP returned safe `202`, committed one recoverable `QUEUED` Job, and the recovery scanner delivered the same Job exactly once as `{ jobId }` (1/1 passed on 2026-07-28).

### Implementation for User Story 2

- [X] T025 [US2] Verified and documented the route's existing `safePreflightFailure` projection: foreign/malformed SourceConnection IDs are concealed as `404 SOURCE_CONNECTION_NOT_FOUND`; owned expired/revoked/`ERROR`/missing-credential states converge on `422 SOURCE_TOKEN_INVALID`, with no request/provider diagnostics. Controlled Compose evidence passed 16/16 executed tests on 2026-07-28.
- [X] T026 [US2] Verified the canonical acceptance service completes read-only preflight before entering its serializable Dataset/Job transaction; the expanded SourceConnection matrix asserts exact Dataset/Job/JobEvent, isolated Redis, and MinIO snapshots do not change for each rejection.
- [X] T027 [US2] Hardened `isSafeRepositoryImportJobInput` in `apps/web/src/lib/repository-import/types.ts` to require the exact allowed object shape and non-empty safe scalars, then extended unit coverage for unexpected source keys and empty durable identifiers. The builder remains credential-, URL-, queue-, storage-, and raw-manifest-free.

**Checkpoint**: All rejected request types have controlled HTTP proof of zero
Dataset/Job/event/queue/storage side effects and no secret/internal leakage.

---

## Phase 5: User Story 3 - Observe the Accepted Import Safely (Priority: P2)

**Goal**: An authorized actor opens the Dataset-scoped progress page and sees
only safe PostgreSQL Job state; a foreign actor is concealed.

**Independent Test**: Open the returned progress path using owner and
non-member cookie sessions. The owner sees safe job progress; the non-member
does not receive Dataset/Job details or raw Job input.

### Tests for User Story 3

- [X] T028 [P] [US3] Added normal-cookie owner/non-member HTTP page and `/api/jobs/[jobId]` projection tests in `apps/web/tests/repository-import-request/progress-page.test.ts`; the controlled Compose run passed 2/2 on 2026-07-28 and confirmed foreign Job/page concealment plus raw-input exclusion.
- [X] T029 [P] [US3] Added safe UI-state tests in `apps/web/tests/repository-import-request/progress-ui.test.ts`; accepted imports already return the canonical Dataset/Job `progressPath` in T011/T012, and this test confirms pending/active/terminal UI behavior is derived from the safe Job DTO only, never queue state.

### Implementation for User Story 3

- [X] T030 [US3] Implemented the server-authorized Dataset-scoped import progress page in `apps/web/src/app/(app)/datasets/[datasetId]/imports/[jobId]/page.tsx`; it requires Dataset read access, verifies Job/Dataset identity, and projects only safe Job/Event DTOs.
- [X] T031 [US3] Implemented `apps/web/src/components/datasets/repository-import-progress.tsx` with explicit pending/active/terminal presentation derived solely from safe PostgreSQL status fields.
- [X] T032 [US3] Reused the existing authorized `/api/jobs/[jobId]` and events polling through `JobDetailClient`; browser code imports no BullMQ/Redis client, raw Job input, or transport metadata.

**Checkpoint**: Accepted imports have an authorized, redacted progress view;
foreign users receive the existing concealed outcome.

---

## Phase 6: Polish, Controlled Runtime Evidence, and Scope Audit

**Purpose**: Verify the complete Phase-015 boundary without implementing the
next clone/binary/Asset worker phase.

- [X] T033 [P] Updated `contracts/repository-import-request-api.md` with the real `{ data: ... }` response envelope, `200` idempotency replay, safe `202` transport-pending behavior, exact SourceConnection failure policy, and exact recovery contract.
- [X] T034 Ran `pnpm exec prisma validate`, `pnpm exec prisma generate`, and `pnpm exec prisma migrate status`; schema validation/generation passed and the approved local migration history is up to date. Evidence is recorded in `quickstart.md`.
- [X] T035 Ran targeted controlled repository-import (17 total: 16 pass, 1 documented outage skip), repository-preflight (32 total: 29 pass, 3 documented skips), auth/ownership (15 pass), and worker queue (23 total: 19 pass, 4 documented skips) suites. Commands and redacted totals are recorded in `quickstart.md`.
- [X] T036 Ran the controlled Compose matrix with PostgreSQL, passworded Redis DB 15 / `fieldframe-phase015-test`, MinIO `phase015-test/` snapshots, GitHub/Gitea fixtures, normal opaque-cookie auth, consumer stop/restart discipline, and the separate real enqueue-outage recovery proof. Evidence is recorded in `quickstart.md`.
- [X] T037 Ran root typecheck/lint, `git diff --check`, controlled production web build, and worker build. All passed; the host Turbopack build initially required execution outside the sandbox due process-binding restrictions, and that environmental limitation is recorded without treating it as a code failure.
- [X] T038 Consolidated the public durable repository-import boundary: `/datasets/imports` previews only through `/api/source-import-preflight`, creates work only through `/api/datasets/from-repository`, and `/api/source-import-jobs` now returns `410 SOURCE_IMPORT_JOBS_DEPRECATED`. Controlled Compose evidence on 2026-07-28 covered public, owned existing connection, saved one-time PAT, idempotency reuse (including no duplicate SourceConnection), redaction, no-side-effect denials, and exact `{ jobId }` delivery.

---

## Dependencies and Execution Order

### Phase dependencies

```text
Phase 1 (T001–T002)
  → Phase 2 gate (T003 approval)
  → Phase 2 foundation (T004–T010)
  → US1 valid acceptance (T011–T019)
  → US2 no-side-effect safety (T020–T027)
  → US3 progress view (T028–T032)
  → validation and scope audit (T033–T038)
```

### User story dependencies

- **US1 (P1)** depends on T003–T010; it is the MVP and must be complete before
  the returned progress page is integrated.
- **US2 (P1)** shares the canonical route/service from US1 but its test files
  can be prepared after T002. Its implementation hardening follows T015–T016.
- **US3 (P2)** depends on US1 producing the safe response/path and on the
  existing safe Job-status projection; it does not depend on worker processing.

### Parallel opportunities

- T002 and the documentation audit in T001 can proceed independently.
- After T003 approval, T006 and T007 can run in parallel; T010 follows T008–T009.
- After the route/service contract stabilizes, T011–T014 can run in parallel.
- T020–T024 are isolated test files/scenarios and can run in parallel after
  US1's boundary exists.
- T028 and T029 can run in parallel after US1 accepted response/path exists.

## Parallel Example: User Story 1

```text
T011: public acceptance HTTP contract tests
T012: private owned-connection HTTP tests
T013: duplicate-submit integration tests
T014: queue payload tests
```

These tests share helpers from T002 but target separate scenarios/files. They
must run against the same canonical acceptance boundary, not independent mock
services.

## Implementation Strategy

### MVP first

1. Complete T001–T010, including explicit approval and the idempotency schema
   migration.
2. Complete US1 through T019.
3. Run the valid public/private, duplicate-submit, and exact `{ jobId }` tests.
4. Stop and validate before adding the progress UI or broader denial matrix.

### Incremental delivery

1. Canonical durable acceptance and idempotency → valid repository request MVP.
2. Full no-side-effect/redaction/recovery matrix → safe request boundary.
3. Dataset-scoped progress page → complete browser handoff.
4. Controlled Compose evidence and scope audit → Phase-015 closure.

## Notes

- All tasks use the normal opaque-cookie session path; no JWT,
  `DEV_AUTH_EMAIL`, browser token storage, or authorization bypass is allowed.
- No task authorizes a workflow-specific Job table, raw SQL exception, new
  dependency, clone processor, source manifest persistence, MinIO upload, or
  Asset creation.
- Phase 016 may not be implemented by these tasks.
