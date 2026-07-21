# Tasks: PostgreSQL Claim Lock + Worker Safety

**Input**: Design documents from `/specs/008-postgresql-claimlock-worker-safety/`
**Prerequisites**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Scope guard**: This phase adds private worker-side PostgreSQL lease safety only. It does not add a migration, dependency, public API, business processor, recovery/reclaim flow for expired `RUNNING` jobs, or a change to the BullMQ payload. The payload remains exactly `{ jobId }`.

## Phase 1: Test and lifecycle foundations

- [X] T001 Record the Phase 008 scope boundaries, prohibited payload fields, and no-migration/no-dependency constraint in `specs/008-postgresql-claimlock-worker-safety/contracts/claim-lock-contract.md`
- [X] T002 Configure the worker queue test command to run database-mutating claim-lock tests serially in `apps/worker/package.json`
- [X] T003 Reuse isolated Job/Dataset fixture creation and deterministic cleanup helpers for worker queue tests in `apps/worker/tests/queue/helpers.ts`
- [X] T004 Define private claim, lease-mutation, and neutral-refusal result types without exposing lock tokens or worker identifiers outside worker internals in `apps/worker/src/jobs/job-claim-lock.ts`
- [X] T005 Define allowlisted, token-free JobEvent payloads for successful lease lifecycle mutations and document that refusals write no event in `apps/worker/src/jobs/job-event-writer.ts`

**Checkpoint**: Test isolation and private lifecycle contracts are ready; no worker behavior has changed yet.

## Phase 2: User Story 1 — A Job is claimed by only one worker (Priority: P1) 🎯 MVP

**Goal**: A duplicate BullMQ delivery can result in at most one active worker lease for a `QUEUED` or `RETRYING` Job.

**Independent Test**: Create one durable eligible Job, issue two concurrent claim attempts with distinct worker IDs, and prove exactly one succeeds while the other leaves the PostgreSQL Job unchanged.

### Tests for User Story 1

- [X] T006 [US1] Add concurrent-claim coverage proving exactly one of two workers receives a lease for the same Job in `apps/worker/tests/queue/claim-lock.test.ts`
- [X] T007 [US1] Add eligibility and refusal coverage for `QUEUED`, `RETRYING`, terminal, `CANCELING`, and unexpired `RUNNING` Jobs in `apps/worker/tests/queue/claim-lock.test.ts`
- [X] T008 [US1] Add expired-`RUNNING` coverage proving it is not reclaimable in this phase in `apps/worker/tests/queue/claim-lock.test.ts`
- [X] T009 [US1] Add duplicate BullMQ delivery integration coverage proving only the winning listener receives a lease and no business processing runs in `apps/worker/tests/queue/worker-claim-integration.test.ts`

### Implementation for User Story 1

- [X] T010 [US1] Implement `claimJob(jobId, workerId)` as the approved single parameterized PostgreSQL `UPDATE … RETURNING` compare-and-set mutation for only `QUEUED`/`RETRYING` Jobs whose lease is absent or expired in `apps/worker/src/jobs/job.repository.ts`; do not extend raw SQL to other lifecycle mutations.
- [X] T011 [US1] Generate fresh opaque lock tokens and set `RUNNING`, `lockedBy`, `lockedAt`, `lockedUntil`, `heartbeatAt`, and preserved `startedAt`/`dequeuedAt` values only in the successful claim mutation in `apps/worker/src/jobs/job-claim-lock.ts`
- [X] T012 [US1] Add a private per-process worker identity and inject it into the BullMQ worker factory without adding it to the queue payload in `apps/worker/src/queue/bullmq-worker.ts`
- [X] T013 [US1] Invoke the private claim immediately after the existing strict `{ jobId }` receipt validation and stop processing on a neutral claim refusal in `apps/worker/src/queue/queue-router.ts`
- [X] T014 [US1] Persist only an allowlisted successful claim JobEvent, with no lock token, worker ID, raw Job data, or queue internals, in `apps/worker/src/jobs/job-event-writer.ts`

**Checkpoint**: One worker can claim an eligible Job; competing and duplicate deliveries cannot begin business processing.

## Phase 3: User Story 2 — Only the current lease can heartbeat or report progress (Priority: P1)

**Goal**: A worker can extend and update its own active lease, but stale, expired, malformed, or wrong tokens cause no write.

**Independent Test**: Claim a Job, then attempt heartbeat and progress updates with the current token, a wrong token, and an expired lease; only current unexpired-token operations may change PostgreSQL state.

### Tests for User Story 2

- [X] T015 [US2] Add heartbeat tests for current-token extension and stale/wrong/expired-token no-side-effect refusal in `apps/worker/tests/queue/lifecycle-mutations.test.ts`
- [X] T016 [US2] Add progress tests for current-token persistence, invalid progress validation, and stale/wrong/expired-token no-side-effect refusal in `apps/worker/tests/queue/lifecycle-mutations.test.ts`

### Implementation for User Story 2

- [X] T017 [US2] Implement `heartbeatJob(jobId, lockToken)` as a guarded active-lease mutation that extends `lockedUntil` and updates `heartbeatAt` only for the current unexpired token in `apps/worker/src/jobs/job-claim-lock.ts`
- [X] T018 [US2] Implement validated `updateJobProgress(jobId, lockToken, progress)` guarded by Job ID, `RUNNING` status, current token, and unexpired lease in `apps/worker/src/jobs/job-claim-lock.ts`
- [X] T019 [US2] Write allowlisted heartbeat/progress JobEvents only after successful mutations and retain zero-event behavior for refusals in `apps/worker/src/jobs/job-event-writer.ts`

**Checkpoint**: Stale workers cannot renew a lease or overwrite current worker progress.

## Phase 4: User Story 3 — Terminal mutations require the current lease and authorized cancellation (Priority: P2)

**Goal**: Only a current worker lease can complete or fail a Job; cancellation is an acknowledgement of an earlier authorized application-side cancellation request.

**Independent Test**: Claim Jobs and exercise complete, fail, and cancel using valid and invalid tokens. Verify that cancellation works only after `CANCELING` or `cancellationRequestedAt` evidence and that all refused calls leave Job and JobEvent rows unchanged.

### Tests for User Story 3

- [X] T020 [US3] Add complete and fail tests for current-token success, lock clearing, and stale/wrong/expired-token no-side-effect refusal in `apps/worker/tests/queue/lifecycle-mutations.test.ts`
- [X] T021 [US3] Add cancellation-acknowledgement tests covering missing cancellation evidence, `CANCELING`, `cancellationRequestedAt`, and invalid-token refusal in `apps/worker/tests/queue/lifecycle-mutations.test.ts`
- [X] T022 [US3] Add JobEvent assertions proving successful terminal events are allowlisted and denied lifecycle mutations create no JobEvent in `apps/worker/tests/queue/lifecycle-mutations.test.ts`

### Implementation for User Story 3

- [X] T023 [US3] Implement guarded `completeJob` and `failJob` mutations requiring Job ID, `RUNNING` state, current unexpired lock token, and safe terminal metadata in `apps/worker/src/jobs/job-claim-lock.ts`
- [X] T024 [US3] Implement `cancelJob` only as a guarded worker-side acknowledgement that requires the current unexpired lock token plus `CANCELING` status or `cancellationRequestedAt` evidence before setting `CANCELED` in `apps/worker/src/jobs/job-claim-lock.ts`
- [X] T025 [US3] Clear lease ownership fields only in successful terminal mutations and write corresponding allowlisted terminal JobEvents in `apps/worker/src/jobs/job-event-writer.ts`

**Checkpoint**: A previous worker cannot terminate a Job, and workers cannot invent a cancellation request.

## Phase 5: Integration, security, and regression validation

- [X] T026 Add a private worker lifecycle integration test proving queue receipt remains `{ jobId }`, claim refusal does not invoke a processor, and a claimed Job stops after lease acquisition in `apps/worker/tests/queue/worker-claim-integration.test.ts`
- [X] T027 Add a regression test that the existing authorized application cancellation boundary supplies cancellation evidence without granting worker-side cancellation authority in `apps/web/tests/job-queue/authorization-and-redaction.test.ts`
- [X] T028 Run the complete claim-lock and worker queue test suite against Compose PostgreSQL and Redis, recording the commands and result in `specs/008-postgresql-claimlock-worker-safety/quickstart.md`
- [X] T029 Run web and worker type checks plus lint/build checks relevant to modified files, recording results in `specs/008-postgresql-claimlock-worker-safety/quickstart.md`
- [X] T030 Perform a two-worker Compose smoke test for one fake durable Job and verify PostgreSQL is the only lifecycle/status source in `specs/008-postgresql-claimlock-worker-safety/quickstart.md`
- [X] T031 Audit queue payloads, JobEvents, worker logs, and safe Job status projections for lock tokens, worker identifiers, raw Job input/state/result, queue internals, credentials, and private storage values in `specs/008-postgresql-claimlock-worker-safety/contracts/worker-lifecycle-contract.md`
- [X] T032 Confirm no Prisma schema, migration, dependency, public route, recovery/reclaim, or business-processing changes were introduced by this phase in `specs/008-postgresql-claimlock-worker-safety/quickstart.md`

## Dependencies and execution order

- Phase 1 tasks T001–T005 complete before lifecycle implementation.
- US1 (T006–T014) is the MVP and prerequisite for US2 and US3.
- US2 (T015–T019) and US3 (T020–T025) require the successful claim behavior from US1.
- Integration and security validation (T026–T032) follows all lifecycle stories.

## Parallel opportunities

- T006–T009 may be authored in parallel because they target separate test concerns, after fixtures are available.
- T015 and T016 can be authored in parallel after US1 behavior is stable.
- T020–T022 can be authored in parallel after US1 behavior is stable.
- T028–T032 are validation/documentation tasks; run stateful Compose tests serially where they share the database.

## Implementation strategy

1. Finish the foundations and make atomic claim behavior pass first (US1).
2. Add heartbeat/progress lease protection (US2).
3. Add terminal and cancellation acknowledgement protection (US3).
4. Run integration, security, and regression checks without broadening into recovery, processing, or a public Job API.
