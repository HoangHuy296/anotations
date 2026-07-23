# Tasks: Source Connections Security Layer

**Input**: Design documents from `/specs/013-source-connections-security-layer/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), and [quickstart.md](./quickstart.md)

**Tests**: Required. Security, ownership, SSRF/root-path, worker revalidation, queue-payload, response-redaction, and zero-side-effect evidence are non-negotiable. Required integration evidence uses a controlled Compose PostgreSQL, passworded Redis, MinIO, web, worker, and dedicated Gitea source where provider contact is exercised. Tests must use normal opaque-cookie login; no `DEV_AUTH_EMAIL`, auth bypass, mocked PostgreSQL, mocked Redis, or mocked MinIO.

**Architecture invariants**: PostgreSQL/Prisma remains authoritative. BullMQ payload remains exactly `{ jobId }`. `Job` data and events never carry token material, private/credential-bearing URLs, provider responses, or binary data. Browser responses/logs never expose plaintext/encrypted tokens, encryption configuration, provider diagnostics, credentials, or stack traces. No schema change, migration, dependency, or raw SQL is authorized by this task list.

**Organization**: Tasks are grouped by independently testable user story. A task marked `[P]` works in a different file after its stated prerequisites are complete.

## Phase 1: Setup and Scope Audit

**Purpose**: Establish the precise source-connection surface and validation harness without changing the data model.

- [X] T001 Audit all `SourceConnection`, Dataset source fields, `Job.sourceConnectionId`, Gitea routes, and worker call sites against `specs/013-source-connections-security-layer/contracts/source-job-boundary.md`; record the approved Gitea-only scope and prohibited data in `specs/013-source-connections-security-layer/research.md`.
- [X] T002 Confirm the current `SourceConnection` schema/indexes satisfy `specs/013-source-connections-security-layer/data-model.md`; document any mismatch in `specs/013-source-connections-security-layer/plan.md` and stop for approval rather than editing `prisma/schema.prisma`.
- [X] T003 Define the secret-safe controlled Compose test topology and deployment-policy boundary in `specs/013-source-connections-security-layer/quickstart.md`: numeric IP default-deny, server-controlled exact IP/CIDR exceptions only, finite server-controlled limits, and a production-disabled trusted local Gitea source.
- [X] T004 Create source-connection HTTP/Compose fixture helpers with normal `/api/auth/login` cookie sessions and no secret output in `apps/web/tests/source-connections/helpers.ts`.

---

## Phase 2: Foundational Security Boundaries

**Purpose**: Implement shared policies required by every source-connection and source-backed operation.

**⚠️ CRITICAL**: Complete this phase before any user story implementation.

- [X] T005 Create strict Zod request schemas and safe stable error-code types for source connection and source-operation inputs in `apps/web/src/lib/validation/source-connection.ts`.
- [X] T006 Create the shared server-only repository address, DNS destination, root-path normalization, exact IP/CIDR allowlist, and finite configured-limit policy in `apps/web/src/lib/source-access-policy.ts`; reject unsafe input before provider contact and prohibit browser policy overrides.
- [X] T007 Create a safe `SourceConnection` DTO/projection and response-redaction helper in `apps/web/src/lib/source-connection-dto.ts` that excludes raw URL, encrypted fields, account data, metadata, and provider diagnostics.
- [X] T008 Harden the existing encryption boundary in `apps/web/src/lib/source-connection-crypto.ts` so invalid/missing encryption configuration fails server-side without serializing or logging key/token material.
- [X] T009 Extend owner-scoped connection lookup and active/revoked/expiry handling in `apps/web/src/lib/authorization.ts`; preserve concealed-resource behavior and existing administrator policy.
- [X] T010 Create the server-only lifecycle service for validation, encrypted persistence, safe provider validation, duplicate handling, and status transitions in `apps/web/src/lib/source-connection-service.ts`.
- [X] T011 [P] Write focused policy tests for URL userinfo/query/fragment, numeric-IP default-deny, exact server-owned IP/CIDR exceptions, prohibited destination classes, DNS-rebinding revalidation, root normalization, finite configured limits, and rejected browser overrides in `apps/web/tests/source-connections/source-access-policy.test.ts`.
- [X] T012 [P] Write encryption/DTO redaction tests for malformed ciphertext/configuration, safe projections, and no secret/error leakage in `apps/web/tests/source-connections/source-connection-security.test.ts`.
- [X] T013 [P] Write Prisma-backed ownership and active-state fixture tests for owner, administrator, non-owner, revoked, expired, and malformed connection IDs in `apps/web/tests/source-connections/source-connection-authorization.test.ts`.

**Checkpoint**: Shared policy, safe DTO, encryption, owner resolution, and test fixtures are ready; no browser route or worker may bypass them.

---

## Phase 3: User Story 1 - Connect a Private Source Safely (Priority: P1) 🎯 MVP

**Goal**: An authenticated owner can create and list a validated Gitea token connection while only safe metadata is returned.

**Independent Test**: A user signs up/seeds through an approved server helper, logs in through `/api/auth/login`, creates a valid controlled-Gitea connection, lists the safe DTO, and proves Prisma stores encrypted—not plaintext—token material while the HTTP response, Job input, queue, and logs remain secret-free.

### Tests for User Story 1

- [X] T014 [P] [US1] Write authenticated HTTP contract tests for `POST`, collection `GET`, and `GET /api/source-connections/[id]`: owner/admin safe reads; foreign, malformed, and unknown concealed reads; valid Gitea validation; duplicate behavior; and no raw URL/token exposure in `apps/web/tests/source-connections/source-connections-routes.test.ts`.
- [X] T015 [P] [US1] Write controlled Compose Gitea validation tests for valid, expired, invalid, and unavailable tokens; a server-owned exact IP exception and CIDR exception may pass address policy but must still return a safe provider failure when no provider is reachable; use `SOURCE_TOKEN_EXPIRED`/stable errors and never serialize provider diagnostics in `apps/web/tests/source-connections/source-connection-denial-effects.test.ts`.
- [X] T016 [P] [US1] Write no-side-effect/redaction tests proving every failed POST case (invalid token, blocked numeric IP, allowed-but-unreachable exact IP/CIDR, private/mixed DNS result, malformed input) leaves SourceConnection, Job, JobEvent, queue delivery, and MinIO state unchanged and prints no credential in `apps/web/tests/source-connections/source-connection-denial-effects.test.ts` and `apps/web/tests/source-connections/source-operation-security.test.ts`.

### Implementation for User Story 1

- [X] T017 [US1] Implement `GET` and `POST` handlers with session actor resolution, Zod validation, owner-derived persistence, lifecycle service calls, and safe error/DTO responses in `apps/web/src/app/api/source-connections/route.ts`.
- [X] T018 [US1] Route existing Gitea client construction through the validated active-connection service in `apps/web/src/lib/gitea-route.ts` and remove any remaining environment-token/default-connection path.
- [X] T019 [US1] Restrict Gitea provider validation/client errors to safe token-expiry, invalid-token, and unavailable outcomes in `apps/web/src/lib/gitea.ts` without returning provider diagnostics.
- [X] T020 [US1] Run the US1 focused policy, route, controlled-provider, encryption, and redaction suites; record non-secret pass/fail evidence in `specs/013-source-connections-security-layer/quickstart.md`.

**Checkpoint**: US1 is complete only when a real authenticated owner can create/list a connection through controlled Compose provider validation and no token/private source detail reaches browser, Job, Redis, MinIO, or log evidence.

---

## Phase 4: User Story 2 - Enforce Ownership and Safe Repository Boundaries (Priority: P1)

**Goal**: Foreign connections, unsafe URLs, and unsafe root paths are rejected before external access at both web and worker boundaries.

**Independent Test**: A non-owner supplies a known connection ID, and unsafe URL/path cases are submitted through real HTTP routes; each receives the approved denial and produces zero database, queue, storage, or provider-call effects. A worker repeats policy checks before a controlled provider call.

### Tests for User Story 2

- [X] T021 [P] [US2] Write authenticated HTTP `GET /api/source-connections/[id]` ownership matrix tests: owner `200` safe DTO, administrator behavior under the established global policy, and foreign/malformed/unknown concealed `404`; assert no encryption fields, token, credential, nonce/tag, provider/private-address detail, or stack trace in `apps/web/tests/source-connections/source-connection-ownership-matrix.test.ts`.
- [X] T022 [P] [US2] Write authenticated HTTP SSRF/root-path rejection and denial-side-effect tests, including numeric-IP default-deny, exact-IP/CIDR policy exceptions, hostname-private and mixed public/private DNS answers, DNS lookup failure, and rejected browser policy overrides. Assert no provider call, SourceConnection, Job, JobEvent, queue delivery, MinIO, or Dataset mutation in `apps/web/tests/source-connections/source-operation-security.test.ts`.
- [X] T023 [P] [US2] Write private-worker revalidation tests for fresh connection lookup, DNS/address/root-path checks, server-memory-only decrypt, and expired-token classification in `apps/worker/tests/source/source-access.test.ts`.
- [X] T024 [P] [US2] Write cross-boundary payload tests proving existing Gitea/import routes cannot put raw URL/token/provider response into Job input, JobEvent data, or BullMQ payload in `apps/web/tests/source-connections/source-job-boundary.test.ts`; cover allowed-host redirects to loopback/private and outside-policy destinations plus redirect loops, all of which must fail safely without following a redirect.

### Implementation for User Story 2

- [X] T025 [US2] Apply the shared source-access policy and server-derived owned-connection resolution to `apps/web/src/app/api/gitea/repos/route.ts`, `apps/web/src/app/api/gitea/repos/[owner]/[repo]/tree/route.ts`, and `apps/web/src/app/api/gitea/import/route.ts`.
- [X] T026 [US2] Normalize and validate Dataset/source root selection and allowlisted source metadata before persistence in `apps/web/src/lib/dataset-import.ts`.
- [X] T027 [US2] Implement private worker source resolution and revalidation before decrypt/provider access in `apps/worker/src/source/source-access.ts`.
- [X] T028 [US2] Integrate the worker source resolver only at the authorized source-job dispatch boundary in `apps/worker/src/queue/queue-router.ts`, without implementing repository clone/import processing.
- [X] T029 [US2] Run controlled Compose HTTP plus worker revalidation suites and verify all denied cases have zero side effects and no secret-bearing output; record results in `specs/013-source-connections-security-layer/quickstart.md`.

**Checkpoint**: US2 is complete only when the same URL/path policy is enforced before web validation and worker access, non-owners are concealed, and source Job/queue data is safe.

---

## Phase 5: User Story 3 - Manage Connection Lifecycle Without Secret Leakage (Priority: P2)

**Goal**: An owner can remove an unused connection safely; active source work prevents destructive removal.

**Independent Test**: An owner deletes an inactive connection through HTTP and cannot reuse it; deletion of a connection referenced by a non-terminal Job returns `SOURCE_CONNECTION_IN_USE`; a non-owner cannot delete or alter it.

### Tests for User Story 3

- [X] T030 [P] [US3] Write authenticated HTTP deletion tests for owner success, non-owner/unknown concealment, safe empty response, and concurrent `204 + 404` idempotent outcomes in `apps/web/tests/source-connections/source-connection-delete.test.ts`.
- [X] T031 [P] [US3] Write Prisma-backed active-Job deletion conflict and denial-side-effect tests covering all non-terminal Job statuses plus concurrent reference-creation/delete integrity (no orphan reference) in `apps/web/tests/source-connections/source-connection-delete.test.ts` and `apps/web/tests/source-connections/source-job-race.test.ts`.
- [X] T032 [P] [US3] Extend response/log redaction coverage across list, create, delete, and error paths in `apps/web/tests/source-connections/source-connection-redaction.test.ts`.

### Implementation for User Story 3

- [X] T033 [US3] Implement lifecycle-service deletion/revocation semantics and non-terminal Job reference check in `apps/web/src/lib/source-connection-service.ts`.
- [X] T034 [US3] Implement session-authenticated owner-safe `DELETE` response handling in `apps/web/src/app/api/source-connections/[id]/route.ts`.
- [X] T035 [US3] Ensure source resolvers reject deleted/revoked connections before decrypt or provider contact in `apps/web/src/lib/gitea-route.ts` and `apps/worker/src/source/source-access.ts`.
- [X] T036 [US3] Run owner/delete/conflict/redaction suites against controlled Compose services and record non-secret evidence in `specs/013-source-connections-security-layer/quickstart.md`.

**Checkpoint**: US3 is complete only when deletion blocks future use, active Jobs protect durable consistency, and every outcome remains secret-free.

---

## Phase 6: User Story 4 - Bound Source-backed Work (Priority: P2)

**Goal**: Only valid, owned source operations within configured limits can create durable source-backed work.

**Independent Test**: A valid request creates or uses a Job with only `sourceConnectionId` and allowlisted metadata; requests exceeding each limit create no Job, queue message, storage object, or Dataset mutation.

### Tests for User Story 4

- [X] T037 [P] [US4] Write authenticated HTTP configured-limit matrix tests for root depth, entry count, declared size, duration, valid boundary values, and existing Start/preflight → capability → completion → commit canonical checks in `apps/web/tests/source-connections/source-import-limits.test.ts`.
- [X] T038 [P] [US4] Write durable Job/BullMQ integration tests proving source work persists only allowlisted data and queue delivery remains exactly `{ jobId }` in `apps/web/tests/source-connections/source-job-queue-contract.test.ts`.
- [X] T039 [P] [US4] Write worker tests proving limit/connection/token failure is safely projected without raw Job input/provider response leakage in `apps/worker/tests/source/source-job-safety.test.ts`.

### Implementation for User Story 4

- [X] T040 [US4] Apply configured source limits and allowlisted source-input builder to the authorized source-backed Job API and `apps/web/src/lib/queue/enqueue-job.ts`; preserve the existing Start/preflight item/logical-path/aggregate-size validation without adding a new import flow.
- [X] T041 [US4] Enforce the safe source Job-input projection before enqueueing in `apps/web/src/lib/queue/enqueue-job.ts` and preserve canonical `{ jobId }` queue payload.
- [X] T042 [US4] Apply worker-side configured limits and safe `SOURCE_TOKEN_EXPIRED`/source-failure projections in `apps/worker/src/source/source-access.ts` and `apps/worker/src/jobs/job-event-writer.ts`.
- [X] T043 [US4] Run controlled Compose end-to-end evidence for HTTP → PostgreSQL Job → BullMQ `{ jobId }` → worker revalidation/claim, verifying no binary or credential is stored or transported, in `specs/013-source-connections-security-layer/quickstart.md`.

**Checkpoint**: US4 is complete only when allowlisted source metadata is durable, limits deny before side effects, and the existing Job/queue architecture is unchanged.

---

## Phase 7: Polish and Cross-Cutting Validation

**Purpose**: Complete security review, documentation, and phase evidence without widening scope.

- [X] T044 [P] Run a full source-connection response, Job, JobEvent, BullMQ/Redis, MinIO metadata, and structured-log redaction audit; document not-applicable log surfaces honestly in `specs/013-source-connections-security-layer/quickstart.md`.
- [X] T045 [P] Review all changed source call sites against `docs/architecture.md`, `docs/job-system.md`, `AGENTS.md`, and the three Phase 013 contracts; correct only Phase 013 documentation drift in `specs/013-source-connections-security-layer/`.
- [X] T046 Run required validation commands—Prisma validation/generation, web typecheck/lint/build, worker typecheck/build, targeted source suites, and controlled Compose smoke—then record exact non-secret commands and test counts in `specs/013-source-connections-security-layer/quickstart.md`.
- [X] T047 Perform final scope audit: confirm no schema/migration/dependency/raw-SQL addition, no clone/import processing expansion, no JWT/auth bypass/browser token storage, and no unresolved task is marked complete in `specs/013-source-connections-security-layer/tasks.md`.

## Dependencies and Execution Order

### Phase dependencies

- **Setup (Phase 1)**: Starts immediately.
- **Foundational (Phase 2)**: Depends on T001–T004 and blocks all stories.
- **US1 (Phase 3)**: Depends on T005–T013.
- **US2 (Phase 4)**: Depends on T005–T013 and uses US1 lifecycle/DTO boundary; it should begin after T017–T019 are stable.
- **US3 (Phase 5)**: Depends on lifecycle service/owner guard from US1 and source resolver from US2.
- **US4 (Phase 6)**: Depends on policy/allowlisted input from US2 and queue architecture already established in prior phases.
- **Polish (Phase 7)**: Depends on all selected user stories and runtime evidence.

### User story order

1. **US1** — Create/list safe connection (MVP).
2. **US2** — Owner isolation and dual-boundary SSRF/root guard.
3. **US3** — Deletion/revocation lifecycle.
4. **US4** — Source limits and safe source-backed Job boundary.

### Parallel opportunities

- After T005–T010, T011–T013 can run in parallel.
- Within US1, T014–T016 can run in parallel before T017.
- Within US2, T021–T024 can run in parallel before T025.
- Within US3, T030–T032 can run in parallel before T033.
- Within US4, T037–T039 can run in parallel before T040.
- T044 and T045 can run in parallel after story implementation completes.

## Implementation Strategy

### MVP first

1. Finish T001–T013, including shared policy and test harness.
2. Finish US1 through T020.
3. Stop and validate an authenticated owner can create/list a controlled-Gitea connection with encrypted storage and safe responses.

### Incremental delivery

1. Add US2 to close IDOR/SSRF/root-path/worker boundary gaps.
2. Add US3 for revocation/deletion consistency.
3. Add US4 only to protect existing source-backed Job creation with limits and safe durable input; do not expand into clone/import processing.
4. Complete Phase 7 only after controlled Compose runtime evidence is recorded.

## Notes

- Every task follows the required checklist format with ID, optional parallel marker, story label for story work, and exact file path.
- No task authorizes an unplanned schema/migration/dependency/raw-SQL change. A discovered schema gap is a blocker requiring explicit approval.
- Do not mark a security or runtime task complete based solely on implementation presence; it requires its specified controlled evidence.
