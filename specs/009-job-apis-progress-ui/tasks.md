# Tasks: Job APIs and Progress UI

**Input**: Design documents from `/specs/009-job-apis-progress-ui/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Contract, authorization, concurrency, no-side-effect, polling, and worker-regression tests are mandatory under the approved Phase 009 scope.

**Scope guard**: Do not add `POST /api/jobs/[jobId]/commit-import`, PreparedImport, local-folder staging, IMPORT_DATASET queue/processor support, manifest-to-Asset persistence, staged-file cleanup, or import compensation. Queue payload remains exactly `{ jobId }`.

## Phase 1: Setup and scope guards

**Purpose**: Establish the Phase 009 contracts and test locations without starting import work.

- [ ] T001 Record Phase 009 API/UI scope, explicit import exclusions, and safe browser field prohibitions in `specs/009-job-apis-progress-ui/contracts/job-api.md`
- [ ] T002 Record durable polling, terminal-state, and action-control behavior in `specs/009-job-apis-progress-ui/contracts/progress-ui.md`
- [ ] T003 Create Phase 009 fixture helpers for Dataset members, failed/running/queued Jobs, and queue inspection in `apps/web/tests/job-queue/helpers.ts`
- [ ] T004 [P] Add the Phase 009 test command and test-file discovery coverage in `apps/web/package.json`

---

## Phase 2: Foundational durable and authorization boundaries

**Purpose**: Add shared retry lineage, permissions, safe projections, and route helpers that block all user stories.

**⚠️ CRITICAL**: Complete this phase before implementing status/events, cancellation, retry, or UI actions.

- [ ] T005 Add nullable unique `retryOfJobId` self-relation and reverse retry relation to `prisma/schema.prisma`
- [ ] T006 Create and review the additive retry-lineage migration under `prisma/migrations/`
- [ ] T007 Generate the Prisma client after T005–T006 using `prisma/schema.prisma`
- [ ] T008 Add `job.retry` to the Dataset permission type and owner/manager/admin permission policy in `apps/web/src/lib/authorization.ts`
- [ ] T009 [P] Add Dataset permission matrix coverage for `job.retry` and preserve non-member 404 behavior in `apps/web/tests/auth-ownership/permission-matrix.test.ts`
- [ ] T010 Create a server-only allowlist mapper and cursor schema for SafeJobEvent without returning `JobEvent.data` in `apps/web/src/lib/jobs/safe-job-event.ts`
- [ ] T011 Create shared Job action/status validation and Job-specific safe error-code helpers in `apps/web/src/lib/validation/job.ts` and `apps/web/src/lib/api-response.ts`
- [ ] T012 Extend Job authorization helpers with action-scoped lookup and safe conflict results in `apps/web/src/lib/jobs/authorization.ts`

**Checkpoint**: Retry lineage is durable, authorization is explicit, and shared server helpers cannot expose raw Job or JobEvent data.

---

## Phase 3: User Story 1 — Monitor an authorized job (Priority: P1) 🎯 MVP

**Goal**: Dataset members can view safe Job status, bounded event history, stage, and progress from durable records.

**Independent Test**: A member reads one Job and its events; a non-member receives 404; both responses omit raw Job/JobEvent and queue/private data.

### Tests for User Story 1

- [ ] T013 [P] [US1] Add status-route authorization, safe summary, and prohibited-field regression coverage in `apps/web/tests/job-queue/status-route.test.ts`
- [ ] T014 [P] [US1] Add cursor, ordering, allowlisted-event, raw-`data` redaction, member 200, non-member 404, and forbidden 403 coverage in `apps/web/tests/job-queue/events-route.test.ts`
- [ ] T015 [P] [US1] Add pure progress/stage/counter and non-terminal polling lifecycle tests in `apps/web/tests/job-queue/job-progress-view.test.ts`

### Implementation for User Story 1

- [ ] T016 [US1] Update the existing safe status read and Job-specific not-found response in `apps/web/src/app/api/jobs/[jobId]/route.ts`
- [ ] T017 [US1] Implement bounded authorized SafeJobEvent history endpoint in `apps/web/src/app/api/jobs/[jobId]/events/route.ts`
- [ ] T018 [P] [US1] Create client-safe Job status/event display types and polling state helpers in `apps/web/src/lib/jobs/job-progress-view.ts`
- [ ] T019 [P] [US1] Implement progress card, stage indicator, progress bar, counters, and event list components in `apps/web/src/components/jobs/job-progress-card.tsx`, `apps/web/src/components/jobs/job-stage-indicator.tsx`, `apps/web/src/components/jobs/job-progress-bar.tsx`, and `apps/web/src/components/jobs/job-event-list.tsx`
- [ ] T020 [US1] Implement the authorized Job detail page and non-terminal visible-page polling in `apps/web/src/app/(app)/jobs/[jobId]/page.tsx`

**Checkpoint**: An authorized member can independently monitor one Job without reading queue state or private event data.

---

## Phase 4: User Story 2 — Request safe cancellation (Priority: P1)

**Goal**: Authorized operators can cancel unclaimed Jobs directly and request cancellation of running Jobs without bypassing Phase 008 worker ownership.

**Independent Test**: A manager cancels queued and running Jobs; queued work becomes terminal, running work becomes pending cancellation, and unauthorized/stale paths cause no Job, JobEvent, or queue side effect.

### Tests for User Story 2

- [ ] T021 [P] [US2] Add HTTP cancellation matrix for owner/manager/reviewer/labeler/non-member, queued/retrying/running/terminal states, 404/403 behavior, and no-side-effect denials in `apps/web/tests/job-queue/cancel-route.test.ts`
- [ ] T022 [P] [US2] Add cancellation race and allowlisted cancellation-event assertions using Prisma fixtures in `apps/web/tests/job-queue/cancel-route.test.ts`
- [ ] T023 [P] [US2] Add worker regression coverage proving only a current unexpired lease acknowledges RUNNING cancellation in `apps/worker/tests/queue/lifecycle-mutations.test.ts`

### Implementation for User Story 2

- [ ] T024 [US2] Implement state-aware authorized cancellation mutation: direct terminal cancel for unclaimed QUEUED/unlocked RETRYING and CANCELING request for RUNNING in `apps/web/src/lib/jobs/authorization.ts`
- [ ] T025 [US2] Append only allowlisted successful cancellation-request events in `apps/web/src/lib/jobs/safe-job-event.ts` and `apps/web/src/lib/jobs/authorization.ts`
- [ ] T026 [US2] Implement the Dataset-authorized cancellation endpoint with safe 400/403/404/409 responses in `apps/web/src/app/api/jobs/[jobId]/cancel/route.ts`
- [ ] T027 [US2] Add the cancellation action state, disabled/pending behavior, and durable refresh integration to `apps/web/src/components/jobs/job-action-buttons.tsx` and `apps/web/src/app/(app)/jobs/[jobId]/page.tsx`

**Checkpoint**: Browser cancellation is authorized and durable; it never carries a lock token or bypasses worker-side final cancellation.

---

## Phase 5: User Story 3 — Retry a failed job safely (Priority: P2)

**Goal**: An authorized operator can retry one eligible failed Job through a unique successor while preserving original history and strict queue transport.

**Independent Test**: Two simultaneous retry calls for one failed supported Job yield one successor; the original remains failed; unsupported and unauthorized retries make no durable/queue side effect.

### Tests for User Story 3

- [ ] T028 [P] [US3] Add schema/migration integration coverage for one unique retry successor and preserved failed original in `apps/web/tests/job-queue/retry-route.test.ts`
- [ ] T029 [P] [US3] Add retry HTTP authorization, terminal-state eligibility, unsupported-type conflict, queue-payload redaction, and denial-side-effect coverage in `apps/web/tests/job-queue/retry-route.test.ts`
- [ ] T030 [P] [US3] Add concurrent retry assertions proving one successor and one queue delivery for one original Job in `apps/web/tests/job-queue/retry-route.test.ts`

### Implementation for User Story 3

- [ ] T031 [US3] Define type-specific allowlisted retry-context extraction that excludes raw input/state/errors/connections/storage fields in `apps/web/src/lib/jobs/retry-job.ts`
- [ ] T032 [US3] Implement transaction-safe failed-Job successor creation/reuse using `retryOfJobId`, fresh lifecycle fields, and the existing enqueue service in `apps/web/src/lib/jobs/retry-job.ts`
- [ ] T033 [US3] Implement Dataset-authorized retry endpoint with 200 existing-successor, 201 new-successor, and safe 403/404/409 responses in `apps/web/src/app/api/jobs/[jobId]/retry/route.ts`
- [ ] T034 [US3] Add failed-only retry control and successor navigation/refresh behavior in `apps/web/src/components/jobs/job-action-buttons.tsx` and `apps/web/src/app/(app)/jobs/[jobId]/page.tsx`

**Checkpoint**: A failed delivery-supported Job has at most one direct successor and retains its immutable failure history.

---

## Phase 6: User Story 4 — Understand a failed job (Priority: P2)

**Goal**: Members see a useful safe failure panel without receiving raw diagnostic details.

**Independent Test**: A failed Job with an allowlisted summary renders a safe message/outcome; a raw summary/error never appears in API output or UI view model.

### Tests for User Story 4

- [ ] T035 [P] [US4] Add safe-summary allowlist/null and raw summary/error redaction coverage in `apps/web/tests/job-queue/status-route.test.ts`
- [ ] T036 [P] [US4] Add error-panel display-model tests for absent, completed, failed, and canceled summaries in `apps/web/tests/job-queue/job-progress-view.test.ts`

### Implementation for User Story 4

- [ ] T037 [US4] Implement strict safe-summary sanitization without serializing raw Prisma JSON in `apps/web/src/lib/jobs/safe-job-status.ts`
- [ ] T038 [US4] Implement safe error panel rendering and integrate it with the Job progress card in `apps/web/src/components/jobs/job-error-panel.tsx` and `apps/web/src/components/jobs/job-progress-card.tsx`

**Checkpoint**: Failed Job information is actionable for members and safe for the browser.

---

## Phase 7: Polish and cross-cutting validation

**Purpose**: Confirm the public contract, security boundaries, migration, and runtime behavior together.

- [ ] T039 Update Phase 009 contract and validation records with implemented response/error semantics in `specs/009-job-apis-progress-ui/contracts/job-api.md` and `specs/009-job-apis-progress-ui/quickstart.md`
- [ ] T040 [P] Audit all Phase 009 routes/components for prohibited Job, JobEvent, queue, lock, provider, credential, storage, binary, and import fields in `apps/web/src/app/api/jobs/` and `apps/web/src/components/jobs/`
- [ ] T041 Run Prisma validation/generation, the retry migration, web typecheck/build, web Job tests, and worker queue regressions; record results in `specs/009-job-apis-progress-ui/quickstart.md`
- [ ] T042 Confirm no commit-import endpoint, PreparedImport model, import staging, IMPORT_DATASET queue support, or import worker processor was introduced in `apps/web/src/app/api/jobs/`, `prisma/schema.prisma`, `packages/queue/src/job-contract.ts`, and `apps/worker/src/`

---

## Dependencies and execution order

### Phase dependencies

- **Phase 1** → **Phase 2**: setup and scope controls precede durable foundations.
- **Phase 2** blocks every user story because safe event mapping, retry lineage, permission, and authorization helpers are shared.
- **US1** and **US2** can begin after Phase 2; US2 shares the Job detail action-control integration with US1 but retains an independently testable endpoint.
- **US3** begins after Phase 2 and is independent of UI monitoring, but its retry control integration waits for US1's detail page.
- **US4** begins after Phase 2; it integrates with US1's progress card after safe-summary behavior is established.
- **Phase 7** follows all desired stories.

### User story dependency graph

```text
Setup → Foundation ┬→ US1 (status/events/progress UI) ─┬→ US4 (safe failure panel)
                   ├→ US2 (cancellation) ──────────────┤
                   └→ US3 (retry successor) ───────────┘
                                                     ↓
                                               Cross-cutting validation
```

## Parallel opportunities

- T004 can run alongside T001–T003.
- After T005–T007, T008–T012 can be divided across authorization, projection, and validation files.
- US1 tests T013–T015 are parallel; its API/UI helper tasks T017–T019 are parallel after the shared contracts exist.
- US2 tests T021–T023 are parallel; worker regression remains isolated from web implementation.
- US3 tests T028–T030 are parallel after the retry migration; UI integration T034 waits for T020.
- US4 tests T035–T036 and implementation T037 can proceed in parallel with the retry work once the safe status boundary exists.
- T040 can run in parallel with T039; T041 follows completed implementation.

## Implementation strategy

### MVP first

1. Complete Setup and Foundational work.
2. Complete US1 safe status/events and progress view.
3. Validate member read, non-member concealment, raw-field redaction, and 10-second durable polling visibility.
4. Stop for review before cancellation/retry controls if an incremental delivery is desired.

### Incremental delivery

1. US1 delivers trustworthy monitoring.
2. US2 adds safe cancellation without changing worker ownership.
3. US3 adds one-successor retry history and delivery-supported retry.
4. US4 completes safe failed-job explanation.
5. Phase 7 validates the full authorization/security/runtime matrix and confirms import work stayed deferred.

## Format validation

All 42 tasks use the required checkbox, sequential Task ID, optional `[P]` marker only for parallel work, required `[US#]` labels for story tasks, and explicit file paths.
