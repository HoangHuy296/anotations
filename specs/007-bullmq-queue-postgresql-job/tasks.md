# Tasks: BullMQ Queue and PostgreSQL Job Source of Truth

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [durable Job contract](./contracts/job-queue-contract.md), [queue transport contract](./contracts/queue-transport.md), [Job status contract](./contracts/job-status-api.md), and [quickstart.md](./quickstart.md).

**Constraints**: Use the finalized `Job` and `JobEvent` schema without a migration. PostgreSQL remains authoritative. BullMQ/Redis only transport exactly `{ jobId }`. No raw SQL, new package, public worker endpoint, job-specific processing, binary/object output, timer loop, or schema/generated-client edit. Tests use Node/tsx, real Compose PostgreSQL/Redis, and Prisma assertions.

**Non-negotiable preservation rules**:

- Do not change the queue payload contract or add payload fields: it remains strictly `{ jobId }`.
- PostgreSQL is the canonical Job source of truth; Redis/BullMQ is transport only and never a status/read model.
- Browser Job status may expose only the canonical safe projection and nullable allowlisted `JobSafeSummary`; it must never forward raw Job `input`, `state`, `result`, raw `summary`, raw JobEvent/error data, or BullMQ internals.

**Tests**: Required by the specification. Add focused Node/tsx integration tests for durable creation, strict payload, transport stamping, recovery, worker receipt, status authorization, safe summary/null projection, and no-side-effect/redaction behavior.

## Phase 1: Setup and Scope Guardrails

**Purpose**: Make the approved foundation boundaries and test entry points explicit before queue behavior changes.

- [X] T001 Record all existing Job helpers, queue clients, worker readiness lifecycle, and protected Job-route coverage in `specs/007-bullmq-queue-postgresql-job/contracts/route-and-runtime-coverage.md`.
- [X] T002 Add Phase 007 Node/tsx test commands for web Job-queue tests and private-worker queue tests without adding dependencies in `apps/web/package.json` and `apps/worker/package.json`.
- [X] T003 Record the immutable Phase 007 exclusions—no migration, new Job table, public worker endpoint, scheduler loop, repository/import/export/AI processing, or MinIO artifacts—in `specs/007-bullmq-queue-postgresql-job/quickstart.md`.

---

## Phase 2: Foundational Queue and Safety Primitives

**Purpose**: Build the strict shared contracts and server-only primitives that block every user story.

**⚠️ CRITICAL**: Do not start durable submission, recovery, status, or worker receipt work before this phase is complete.

- [X] T004 [P] Define one allowlisted existing `JobType` → queue-name mapping and reject unsupported types in `apps/web/src/lib/queue/queue-names.ts` and `apps/worker/src/queue/queue-names.ts`.
- [X] T005 [P] Preserve the exact strict `{ jobId }` payload schema and add only deterministic delivery-id helpers—never a Dataset id, type, input, state, result, or transport metadata field—in `packages/queue/src/job-contract.ts`.
- [X] T006 [P] Create safe Zod schemas for server-only foundation Job creation input and the `SafeJobStatus`/`JobSafeSummary` serialization boundary in `apps/web/src/lib/validation/job.ts`.
- [X] T007 [P] Create a narrow allowlisted JobEvent writer that accepts only safe event kinds, scalar diagnostics, and reason codes in `apps/worker/src/jobs/job-event-writer.ts`.
- [X] T008 Create the server-only BullMQ/Redis Queue factory with the configured prefix and graceful close semantics in `apps/web/src/lib/queue/bullmq-client.ts`.
- [X] T009 Refactor the existing Job authorization boundary to expose Dataset-scoped create/read/cancel checks and safe Job lookup projections without queue authority in `apps/web/src/lib/jobs/authorization.ts`.
- [X] T010 Create Prisma-backed Job/JobEvent/Dataset fixtures, queue inspection helpers, and secret-safe cleanup in `apps/web/tests/job-queue/helpers.ts` and `apps/worker/tests/queue/helpers.ts`.
- [X] T011 Add foundational tests for exact payload rejection, unsupported Job-type rejection, safe event allowlist, and no secret/full-input serialization in `apps/web/tests/job-queue/foundation.test.ts` and `apps/worker/tests/queue/event-writer.test.ts`.

**Checkpoint**: The project can create test fixtures and validate the shared minimal payload/event contracts without yet submitting, recovering, or processing a Job.

---

## Phase 3: User Story 1 — Submit and Read a Durable Job (Priority: P1) 🎯 MVP

**Goal**: An authorized request creates one canonical Job, requests minimal queue delivery, records successful transport metadata, and reads a safe PostgreSQL-backed status projection.

**Independent Test**: For an authorized Dataset fixture, submit one supported foundation Job, assert one Job is persisted before delivery, inspect the exact queue payload, verify the same Job is transport-stamped after delivery, and retrieve the canonical status response with `summary: null`. Verify unauthenticated/member-denied/non-member/cross-Dataset reads are `401`/`403`/`404` with no side effect.

### Tests for User Story 1

- [X] T012 [P] [US1] Write authorized durable create/enqueue, same-Job transport-stamp, and deterministic delivery-id integration tests in `apps/web/tests/job-queue/enqueue-and-status.test.ts`.
- [X] T013 [P] [US1] Write HTTP Job-status authorization, PostgreSQL-only canonical counter mapping, nullable safe-summary, and prohibited raw Job/BullMQ-field redaction tests in `apps/web/tests/job-queue/status-route.test.ts`.
- [X] T014 [P] [US1] Write no-side-effect tests for unauthenticated, forbidden, non-member, cross-Dataset, malformed-input, and unsupported-type submission/status attempts in `apps/web/tests/job-queue/authorization-and-redaction.test.ts`.

### Implementation for User Story 1

- [X] T015 [US1] Implement the server-only durable create → BullMQ add `{ jobId }` → conditional transport-stamp/reconcile service, including a safe pending-delivery result, in `apps/web/src/lib/queue/enqueue-job.ts`.
- [X] T016 [US1] Integrate server-derived Dataset authorization, validated safe input, existing Job creation, and the enqueue service without adding a public fake-Job endpoint in `apps/web/src/lib/jobs/authorization.ts`.
- [X] T017 [US1] Implement `GET /api/jobs/[jobId]` with session-first Dataset authorization and a PostgreSQL-only `SafeJobStatus` projection in `apps/web/src/app/api/jobs/[jobId]/route.ts`.
- [X] T018 [US1] Implement the explicit raw-summary-to-`JobSafeSummary` sanitizer; return `summary: null` for all Phase 007 foundation Jobs and exclude raw Job input/state/result/summary, JobEvents/errors, and BullMQ internals in `apps/web/src/lib/jobs/safe-job-status.ts`.
- [X] T019 [US1] Record the independent durable-submission/status validation, safe response review, and no-public-fake-endpoint result in `specs/007-bullmq-queue-postgresql-job/quickstart.md`.

**Checkpoint**: A supported fixture Job is durable before transport, BullMQ gets only `{ jobId }`, PostgreSQL receives the successful transport stamp, and frontend status uses only a safe durable projection.

---

## Phase 4: User Story 2 — Recover Pending Queue Delivery (Priority: P1)

**Goal**: A Job persisted during a queue outage remains queued and can be explicitly redelivered later without replacement or duplicate future work.

**Independent Test**: Force BullMQ add to fail after Job creation, assert `QUEUED` plus null `enqueuedAt`, restore transport, run one bounded recovery pass, verify the original Job is stamped/delivered, then repeat the pass with no duplicate Job or delivery.

### Tests for User Story 2

- [X] T020 [P] [US2] Write enqueue-failure and recovery-success integration tests asserting one original Job, null `enqueuedAt`, safe pending event, and same-id delivery in `apps/web/tests/job-queue/recovery-scanner.test.ts`.
- [X] T021 [P] [US2] Write post-delivery/pre-stamp reconciliation, repeated-scan idempotency, and conflicting-transport-metadata tests in `apps/web/tests/job-queue/reconciliation.test.ts`.
- [X] T022 [P] [US2] Write cancelled, non-queued, archived/inactive-Dataset, and unsupported-candidate skip/no-side-effect tests in `apps/worker/tests/queue/recovery-eligibility.test.ts`.

### Implementation for User Story 2

- [X] T023 [US2] Extend the enqueue service with conditional same-Job stamp reconciliation and safe pending/reconciled events without overwriting conflicting metadata in `apps/web/src/lib/queue/enqueue-job.ts`.
- [X] T024 [US2] Implement an explicitly invoked, bounded scanner for `QUEUED` Jobs with null `enqueuedAt` that revalidates every candidate before reusing the enqueue service in `apps/worker/src/queue/recovery-scanner.ts`.
- [X] T025 [US2] Expose only a server/private invocation path for the recovery scanner and document its no-timer/no-public-endpoint boundary in `apps/worker/src/queue/recovery-scanner.ts` and `specs/007-bullmq-queue-postgresql-job/quickstart.md`.

**Checkpoint**: A queue outage leaves one recoverable durable Job, and repeated bounded recovery is idempotent without creating replacement Jobs or future artifacts.

---

## Phase 5: User Story 3 — Private Worker Receives Durable References (Priority: P2)

**Goal**: The private worker accepts only the strict Job reference, resolves the Job from PostgreSQL, records safe receipt/skip observations, and performs no business processing.

**Independent Test**: Send a valid delivery for a queued foundation Job and verify the worker reads it, conditionally sets `dequeuedAt`, and writes one safe receipt event. Send malformed, unknown, cancelled, terminal, inactive-Dataset, and unsupported deliveries and verify no new Job or business work occurs.

### Tests for User Story 3

- [X] T026 [P] [US3] Write private-worker valid receipt tests for strict payload parsing, PostgreSQL Job resolution, conditional `dequeuedAt`, and safe `QUEUE_RECEIVED` event content in `apps/worker/tests/queue/worker-receipt.test.ts`.
- [X] T027 [P] [US3] Write malformed/unknown/cancelled/non-queued/inactive-Dataset/unsupported delivery skip tests with no business side effect in `apps/worker/tests/queue/queue-router.test.ts`.
- [X] T028 [P] [US3] Write worker lifecycle tests for worker/queue/Redis/Prisma graceful close and no HTTP listener in `apps/worker/tests/queue/bullmq-worker.test.ts`.

### Implementation for User Story 3

- [X] T029 [US3] Implement the private BullMQ Worker factory with strict shared payload parsing, configured Redis prefix, and graceful close behavior in `apps/worker/src/queue/bullmq-worker.ts`.
- [X] T030 [US3] Implement the private queue router that loads the durable Job, applies candidate skip rules, and conditionally records dequeue receipt without changing to `RUNNING` or dispatching business handlers in `apps/worker/src/queue/queue-router.ts`.
- [X] T031 [US3] Integrate worker factory lifecycle with existing provider readiness/startup/shutdown while retaining the private non-HTTP process boundary in `apps/worker/src/index.ts` and `apps/worker/src/readiness.ts`.
- [X] T032 [US3] Record worker receipt, skip, redaction, and no-business-processing evidence in `specs/007-bullmq-queue-postgresql-job/quickstart.md`.

**Checkpoint**: The worker proves the cross-service receipt contract and remains a private, non-processing foundation.

---

## Phase 6: Polish and Cross-Cutting Validation

**Purpose**: Verify all architecture, authorization, lifecycle, secret, and runtime boundaries without expanding into a workflow-specific phase.

- [X] T033 [P] Run the complete web Job-queue and worker queue suites with real Compose PostgreSQL/Redis and record safe pass/fail evidence in `specs/007-bullmq-queue-postgresql-job/quickstart.md`.
- [X] T034 [P] Run `pnpm typecheck`, web/worker lint, and relevant production builds; record safe results in `specs/007-bullmq-queue-postgresql-job/quickstart.md`.
- [X] T035 Verify Compose web/worker readiness, Redis connectivity, queue receipt, and one bounded recovery smoke cycle without exposing queue credentials in `specs/007-bullmq-queue-postgresql-job/quickstart.md`.
- [X] T036 Audit queue payloads, JobEvent data, API status payloads, errors, and logs to prove the payload remains exactly `{ jobId }`, PostgreSQL remains canonical, and prohibited raw Job/BullMQ/secrets/private data is absent in `specs/007-bullmq-queue-postgresql-job/contracts/route-and-runtime-coverage.md`.
- [X] T037 Confirm no edits to `prisma/schema.prisma`, `prisma/migrations/`, generated Prisma client, MinIO flows, public worker routes, scheduler loops, or workflow-specific processors; record Phase 007 limitations and stop in `specs/007-bullmq-queue-postgresql-job/quickstart.md`.

## Dependencies and Execution Order

```text
T001–T003
  → T004–T011 (foundational)
    → US1: T012–T019
      → US2: T020–T025
      → US3: T026–T032
        → T033–T037 (polish)
```

- US1 depends on the shared strict payload, queue factory, authorization, safe event, and fixture foundations.
- US2 depends on US1's create/enqueue service because recovery must reuse—not duplicate—the same enqueue/reconcile path.
- US3 depends on the shared payload/event foundations and may begin after them, but its full end-to-end proof uses the durable submission delivered in US1.
- No task authorizes a Job-specific processor, queue-state UI, scheduler, public worker endpoint, schema change, or dependency installation.

## Parallel Opportunities

- After T003, T004–T007 can proceed in parallel because they modify separate queue mapping, shared payload, validation, and event-writer files.
- After the foundational checkpoint, US1 tests T012–T014 can run in parallel.
- Within US2, T020–T022 can run in parallel before T023–T025.
- Within US3, T026–T028 can run in parallel before T029–T031.
- T033 and T034 can run in parallel after all story checkpoints are complete.

## Parallel Example: User Story 1

```text
Task: "T012 durable create/enqueue and transport-stamp tests in apps/web/tests/job-queue/enqueue-and-status.test.ts"
Task: "T013 HTTP Job-status projection tests in apps/web/tests/job-queue/status-route.test.ts"
Task: "T014 authorization/no-side-effect/redaction tests in apps/web/tests/job-queue/authorization-and-redaction.test.ts"
```

## Implementation Strategy

### MVP First

1. Complete T001–T011 so strict payloads, safe events, queue configuration, authorization, and fixtures are stable.
2. Complete US1 (T012–T019) and independently validate durable creation, enqueue, transport stamp, and safe PostgreSQL status projection.
3. Stop for approval before recovery or worker lifecycle integration if approval is constrained.

### Incremental Delivery

1. Add US1 for the durable create/enqueue/status contract.
2. Add US2 for recovery after transient delivery failure.
3. Add US3 for private worker receipt only.
4. Complete cross-cutting validation only after all selected stories pass.

## Task Format Validation

- All 37 tasks use the required checkbox, sequential ID, optional `[P]`, exact file path, and user-story label rules.
- Story labels appear only in US1, US2, and US3 phases.
- `[P]` appears only for tasks designed to modify independent files or execute independent validations.
