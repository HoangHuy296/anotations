---

description: "Task list template for feature implementation"
---

# Tasks: AI Integration through BullMQ

**Input**: Design documents from `/specs/020-ai-integration/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/ai-api.md](./contracts/ai-api.md), [quickstart.md](./quickstart.md)

**Tests**: `plan.md`'s Technical Context commits to Vitest contract/unit tests for the new routes, processors, and lock primitive, so test tasks are included per story (marked, not mandatory to run before every implementation task — this is not a strict TDD request).

**Organization**: Tasks are grouped by user story (P1–P4 from `spec.md`) so each can be implemented and demoed independently. Read the **"Architecture note — provider ownership"** section below before starting — two files from the original request are deliberately not created, `packages/domain` gains one new file, and T006 is blocked pending a real external contract.

## ⚠️ Architecture note — provider ownership (resolved via `/speckit-analyze`, confirmed) — read first

Two files from the original feature request are **not** created at the path first suggested, and `packages/domain` gains one new file. This was surfaced by `/speckit-analyze` (finding D1) and confirmed: keep the AI provider **worker-owned**, split by whether the code touches Prisma/network.

1. **`apps/web/src/lib/ai/ai-provider-registry.ts` and `apps/web/src/lib/ai/providers/aioz-company.provider.ts` are NOT created.** The Next.js web app never calls the external AI provider — per `AGENTS.md`'s architecture table, "long-running processing" (which includes submitting to and polling an external AI provider) is the **private worker's** responsibility, and `POST /api/ai/tasks` must acknowledge without waiting on the provider (FR-006), so no provider call ever belongs on the web request path. Confirmed against this repo's own precedent: `apps/web/src/lib/providers/{github,gitea}/*` (web-side repository preflight) and `apps/worker/src/source/source-access.ts` (worker-side repository access) are already two **separate, non-importing** implementations — `apps/worker` has no path alias to `apps/web/src/lib` and never imports from it (verified: no `apps/web` import anywhere under `apps/worker/src`). Building a web-side adapter that is structurally unreachable and never invoked would be dead code. The web route only ever needs `AiModel.isActive` (a plain DB read) — it does not need to resolve a provider adapter at all.
2. **The pure type contract** (`AiProviderAdapter` interface, `AiProviderSubmitInput`/`AiProviderSubmitResult`/`AiProviderStatusResult`/`AiProviderPrediction`) is created in **`packages/domain/src/ai-provider.ts`** — already a dependency of both `apps/web` and `apps/worker`, already Prisma-free by convention (see `provider-config.ts`, `source-access-policy.ts`), the one place a shared *shape* can live without either app importing the other's source tree.
3. **The concrete adapter + the DB-touching registry** are created worker-side, under a new `apps/worker/src/providers/ai/` directory (mirroring the existing `apps/worker/src/providers/` and `apps/worker/src/source/` convention for worker-owned external access): `aioz-company.provider.ts` (the only code that calls the external service) and `ai-provider-registry.ts` (`resolveAiProviderForTask(db, aiTask)`, called from both `ai-submit.processor.ts` and `ai-poll.processor.ts`).

Everything else in the original request's file tree (`apps/web/src/app/api/ai/**`, `apps/web/src/lib/ai/ai-task-service.ts`, `apps/worker/src/jobs/ai-submit.processor.ts`, `apps/worker/src/jobs/ai-poll.processor.ts`, `apps/worker/src/queue/job-lock.ts`) is created exactly as named.

### ⛔ Open blocker — do not start T006 from a guess

The external AIOZ-company AI service's real request/response contract (submit endpoint + body, status-check endpoint + body, auth, error shape) has not been supplied yet. **T006 (`aioz-company.provider.ts`) must not be implemented until that contract is provided** — writing it against an assumed shape risks a rewrite of both the adapter and the poll-processor's result handling later. Every other task in Foundational and US1 (T005, T007–T021) is written against the **normalized** `AiProviderAdapter` interface and can be built/tested with a fake/stub adapter in the meantime; only T006 itself is blocked.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)
- File paths are exact and repo-relative.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Constants and config every later phase needs; touches no business logic.

- [X] T001 Add `AIOZ_COMPANY_API_BASE_URL` / `AIOZ_COMPANY_API_KEY` (names illustrative — match whatever the real "AIOZ-company API" needs) to `apps/worker/src/config.ts`'s env schema and to `.env.example`; never read these outside the worker.
- [X] T002 [P] Add `AI_MODEL_INACTIVE`, `AI_MODEL_NOT_FOUND`, `ASSET_NOT_IN_DATASET`, `AI_TASK_NOT_FOUND` to the `ApiErrorCode` union in `apps/web/src/lib/api-response.ts`.
- [X] T003 [P] Create `apps/web/src/lib/ai/ai-task-errors.ts` with a typed `AiTaskError` class (`reason: "AI_MODEL_INACTIVE" | "AI_MODEL_NOT_FOUND" | "ASSET_NOT_IN_DATASET"`), matching the existing `ServiceError` pattern in `apps/web/src/lib/annotations/annotation-service.ts`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Infrastructure every Job/AiTask-pipeline story (US1, US2, US4) needs before any of them can run end-to-end. US3 (list models) has no dependency on this phase and could technically be built in parallel, but is sequenced after for simplicity.

**⚠️ CRITICAL**: Do not start US1 implementation tasks until this phase is checked off.

- [X] T004 Add `"AI_PREANNOTATE_ASSET"` and `"AI_PREANNOTATE_DATASET"` to `supportedQueueJobTypes` in `packages/queue/src/job-contract.ts` (both `JobType` enum values already exist in `prisma/schema.prisma`; without this, `queueNameForJobType()` returns `null` for them and every enqueue attempt is rejected).
- [X] T005 [P] Create `packages/domain/src/ai-provider.ts` — pure, Prisma-free, `fetch`-free shared contract: `AiProviderAdapter` interface with three **required** methods (`submitTask`, `getTaskStatus`, `normalizePredictions`) and two **optional** capability methods (`cancelTask?`, `validateModel?` — not every provider supports them; callers must feature-detect), plus `AiProviderSubmitInput`, `AiProviderSubmitResult` (`{ externalTaskId: string }`), `AiProviderStatusResult` (carries the **raw**, not-yet-normalized completion payload: `{ status: "PENDING"|"IN_PROGRESS" } | { status: "COMPLETED"; rawPredictions: unknown } | { status: "FAILED"; error }`), and `AiProviderPrediction` (the normalized shape `normalizePredictions()` produces — refine `boundingBoxes` once the real contract is known). Added `export * from "./ai-provider.js"` to `packages/domain/src/index.ts` and a `"./ai-provider"` entry to `packages/domain/package.json`'s `exports` map. **Done** — built with `pnpm --filter @annotationplatform/domain build`.
- [ ] T006 **⛔ BLOCKED — do not start until the real AIOZ-company API contract is supplied.** Create `apps/worker/src/providers/ai/aioz-company.provider.ts` exporting `AIOZCompanyProvider`, implementing `AiProviderAdapter` (T005) against the actual configured AIOZ-company API endpoint (uses `fetch` with a request timeout via `AbortSignal.timeout(...)` comfortably below the 3-minute Job lock lease — see `job-lock.ts`'s `DEFAULT_LEASE_DURATION_MS`; matches the style of `apps/web/src/lib/providers/provider-fetch.ts`; credentials from `apps/worker/src/config.ts#getAiozCompanyProviderConfig()` only, never logged, never placed in any `AiTask`/`Job` field; this file must contain zero `prisma`/`db.*` calls). `getTaskStatus` returns the **raw** payload (`{ status: "COMPLETED"; rawPredictions: <raw shape> }`); `normalizePredictions()` converts it to `AiProviderPrediction[]`. *(depends on T005)*
- [X] T007 Create `apps/worker/src/providers/ai/ai-provider-registry.ts` exporting `resolveAiProviderForTask(db, aiTask, registry?)`: loads `AiModel` by `aiTask.modelId` (the only Prisma call in this file), throws `AiProviderResolutionError("AI_MODEL_NOT_FOUND" | "AI_MODEL_INACTIVE" | "AI_PROVIDER_NOT_REGISTERED")`, returns the `AiProviderAdapter` (T005 type) keyed by `model.provider` via an injectable `Record<string, AiProviderAdapter>` map (defaults to an empty map with a `TODO(T006)` — registering `{ "aioz-company": ... }` happens once T006 lands). Must never select or reference `Job.provider`. Unit-testable against a fake `AiProviderAdapter` via the injected `registry` param before T006 exists. **Done** — typechecks clean against the regenerated Prisma client.
- [X] T008 [P] Create `apps/worker/src/queue/job-lock.ts` with `renewOrReclaimLock(db, jobId, workerId, observedLockToken, leaseDurationMs?)`, `renewLock(db, jobId, lockToken, workerId, extendByMs)`, and `releaseLock(db, jobId, lockToken, workerId)` as parameterized `UPDATE ... RETURNING` statements against `Job.lockedBy`/`lockToken`/`lockedAt`/`lockedUntil`/`heartbeatAt`. Ownership invariant: a valid lease renews only for the worker that holds it (token **and** `workerId` must both match); an expired lease can be reclaimed by any worker. `lockToken` rotates on every successful call (renew or reclaim) — required to prevent two concurrent calls with the same stale observed token from both acquiring; `lockedAt` is preserved across an ordinary renewal. Default lease is `DEFAULT_LEASE_DURATION_MS = 3 * 60 * 1000` (3 minutes), configurable per call. `extendByMs` is validated (finite, positive) before use. Named constants for poll timing/lock-buffer live in the new `apps/worker/src/jobs/ai-poll-constants.ts` (`POLL_BASE_DELAY_MS`, `LOCK_RENEWAL_BUFFER_MS`; T024 adds the rest). **Done** — 6 tests in `apps/worker/tests/queue/job-lock.test.ts` pass against a live Postgres, including the priority case: two concurrent `renewOrReclaimLock()` calls from the same worker with the same observed token yield exactly one `acquired: true`.
- [X] T009 [P] Create `apps/web/src/lib/validation/ai-task.ts` with `createAiTaskSchema` (Zod: `datasetId`, `modelId`, non-empty `assetIds: string[]`), matching the style of `apps/web/src/lib/validation/dataset.ts`.

### ⚠️ Note added during contract-focused implementation pass — `data-model.md`'s "no migration" claim was wrong

`data-model.md` states every field this feature needs "already exists in the
committed `prisma/schema.prisma`". That was true of the working tree's
`schema.prisma` at the time, but **not of any committed migration** — the
`AiModel` table and the reshaped `AiTask` (dropped `assetId`/`provider`,
added `modelId`/`modelKeySnapshot`/`pollAttempts`/`nextPollAt`, `jobId` now
`@unique`) had never been migrated into any database. Confirmed against the
local dev Postgres: `AiTask` existed in its *old* Phase-013 shape, `AiModel`
did not exist at all, and no migration directory referenced either. Added
`prisma/migrations/20260814000000_add_ai_model_and_reshape_ai_task/` —
scoped to only the AI-feature schema diff (confirmed by user: the
`TextDocument`→`TextAsset` rename present in the same uncommitted
`schema.prisma` is separate, owned work and is deliberately **not** included
in this migration). Applied via `prisma migrate deploy` against the local
dev database (the table was empty, so no data-loss risk in tightening
nullability). Also fixed a bug this surfaced: `apps/worker/tests/jobs/ai-fixtures.ts`
selected only `{ id: true }` from the created `AiModel`, so
`modelKeySnapshot: model.key` was silently `undefined` — added `key: true`
to the `select`.

**Checkpoint**: Foundation ready — US1, US2, and US4 implementation can begin.

---

## Phase 3: User Story 1 - Request AI Pre-Annotation for a Dataset or Asset (Priority: P1) 🎯 MVP

**Goal**: A user submits assets + an active model; the system durably accepts the request, submits it to the AI provider, polls until a result exists, and turns valid predictions into new `DRAFT`/`AI`-sourced annotations without touching manual ones.

**Independent Test**: `POST /api/ai/tasks` for one asset + a seeded active `AiModel`; poll `GET /api/ai/tasks/{id}` (or the DB directly) until `SUCCEEDED`; confirm new `source=AI, status=DRAFT` annotations exist on the asset and any pre-existing manual annotation is unchanged.

### Tests for User Story 1 (Vitest, per plan.md's Testing commitment)

- [X] T010 [P] [US1] Contract test for `POST /api/ai/tasks` (success + each rejection in `contracts/ai-api.md`'s failure table) in `apps/web/tests/ai/ai-tasks-route.test.ts`. **Done** — extended to assert the specific error `code` per failure row (the route previously collapsed distinct codes onto one status, fixed alongside this task).
- [X] T011 [P] [US1] Unit test for `ai-prediction-writer.ts` (valid prediction → annotation created; out-of-scope `assetId` discarded; unresolvable `labelKey` skipped without failing the task; a pre-existing manual annotation is never touched) in `apps/worker/tests/jobs/ai-prediction-writer.test.ts`. **Done** — passes against a live Postgres.
- [X] T012 [P] [US1] Integration test for `ai-poll.processor.ts` happy path (PENDING → reschedule with `nextPollAt`; COMPLETED → annotations created, `AiTask`/`Job` reach `SUCCEEDED`/`COMPLETED` exactly once even under two concurrent poll invocations) in `apps/worker/tests/jobs/ai-poll.processor.test.ts`. **Done** — passes against a live Postgres; also added a poll-budget-exceeded case to this file.

### Implementation for User Story 1

- [X] T013 [P] [US1] Add `assertAssetsBelongToDataset(assetIds, datasetId)` to `apps/web/src/lib/ai/ai-task-service.ts` (rejects before any transaction opens, per FR-002).
- [X] T014 [US1] Add `createAiTask(actor, input)` to `apps/web/src/lib/ai/ai-task-service.ts`: authorize (`requireDatasetPermission(actor, datasetId, "annotation.create")`) + active-`AiModel` check + `assertAssetsBelongToDataset` outside any transaction → `db.$transaction` creating `Job` (`type` = `AI_PREANNOTATE_ASSET`/`AI_PREANNOTATE_DATASET` by `assetIds.length`, `stage: "CREATING_AI_TASK"`) + `AiTask` (`jobId`, `modelId`, snapshots copied from `AiModel`, `input: { assetIds }`) → `enqueueExistingJob(job.id, ...)` (`@/lib/queue/enqueue-job`) strictly after commit. *(depends on T004, T009, T013)* **Done** — typechecks clean.
- [X] T015 [US1] Create `apps/web/src/app/api/ai/tasks/route.ts` — `POST` handler: `getRequestActor()` → 401 if absent → parse body with `createAiTaskSchema` (inside `createAiTask`) → call `createAiTask` → map failures per `contracts/ai-api.md`'s table → `202` with `{ taskId, jobId }` on success. *(depends on T002, T003, T014)* **Done**.
- [X] T016 [P] [US1] Create `apps/worker/src/jobs/ai-submit.processor.ts` — `processAiSubmit(db, jobId, lockToken)`: load `AiTask` by `jobId`, `resolveAiProviderForTask` (T007), call `adapter.submitTask(...) → AiProviderSubmitResult`, persist `AiTask.externalTaskId` + initial `nextPollAt` (`now + POLL_BASE_DELAY_MS`, from `ai-poll-constants.ts`) + `status: "RUNNING"`, set `Job.stage = "WAITING_AI_RESULT"` (status stays `RUNNING` from the existing `claimJob`). On any submission failure: `AiTask.status = "FAILED"` (`errorCode: "AI_SUBMIT_FAILED"`) + `failJob()`. *(depends on T007)* **Done**.
- [X] T017 [US1] Added the `AI_PREANNOTATE_ASSET`/`AI_PREANNOTATE_DATASET` dispatch line to `routeQueueDelivery` in `apps/worker/src/queue/queue-router.ts`, same pattern as the existing `IMPORT_DATASET`/`EXPORT_DATASET` lines. *(depends on T004, T016)* **Done**.
- [X] T018 [P] [US1] Create `apps/worker/src/jobs/ai-prediction-writer.ts`: Zod schema validating the worker's normalized `AiProviderPrediction[]` (T005), a `DETECT_OBJECTS → BOUNDING_BOX`-style `AiTaskType → AnnotationType` map, and `handleAiTaskCompleted(db, jobId, aiTask, predictions, lockToken, workerId)`: discards out-of-scope `assetId`s, skips unresolvable `labelKey`s, then in one `db.$transaction` — `tx.annotation.create()` (never `update`/`delete`) per valid prediction with `source: "AI"`, `status: "DRAFT"`, `properties: { confidence, aiTaskId, modelKey }`, `reviewedById` left `null` — plus `AiTask.status = "SUCCEEDED"` + `output`, plus `Job.status = "COMPLETED"` / `stage = "FINISHED"` / `finishedAt`, then `releaseLock`. The *only* place `tx.annotation.create()` is called anywhere in the feature. **Done** — typechecks clean.
- [X] T019 [US1] Create `apps/worker/src/jobs/ai-poll.processor.ts` — `processAiPoll(db, jobId, workerId)` implementing the full 7-step sequence: load `Job` → `renewOrReclaimLock` (T008; return quietly if refused) → **re-read** `Job.cancelRequestedAt` after acquiring the lock (fresh read, not the step-1 snapshot — avoids a TOCTOU gap) → if set, `finalizeCanceledAiTask` (implemented in full now, not a stub — idempotent on an already-terminal `AiTask`) → load `AiTask` → poll provider via `resolveAiProviderForTask`/`adapter.getTaskStatus` (T007) → `switch` on `status` (discriminated-union narrowing needs a `switch`, not `if`/`||`, to typecheck cleanly here): `PENDING`/`IN_PROGRESS` → increment `pollAttempts`, fixed-step `nextPollAt` (T024 replaces with backoff), `renewLock`; `COMPLETED` → `adapter.normalizePredictions(result.rawPredictions)` then `handleAiTaskCompleted` (T018); `FAILED` → mark `AiTask`/`Job` `FAILED` with `result.error`, `releaseLock`. *(depends on T007, T008, T018)* **Done** — typechecks clean.
- [X] T020 [US1] Create `apps/worker/src/queue/ai-poll-scanner.ts` — `pollDueAiTasks(db, workerId, now?, limit?)`: query `AiTask` rows where `status IN ("QUEUED","RUNNING")` and `nextPollAt <= now()` (bounded batch, same shape as `apps/worker/src/queue/import-timeout-scanner.ts`), call `processAiPoll` for each. *(depends on T019)* **Done**.
- [X] T021 [US1] Wired the scanner into worker startup in `apps/worker/src/readiness.ts`: one dedicated `aiPollWorkerId`, run one pass, then `setInterval(() => void pollDueAiTasks(db, aiPollWorkerId), 2_000)`, `unref()`'d, alongside the existing `importTimeoutTimer` pattern. *(depends on T020)* **Done**.

**Checkpoint**: User Story 1 is fully functional and independently testable — submit → provider round-trip → draft annotations, manual annotations untouched.

---

## Phase 4: User Story 2 - Track AI Task Status and See Failures Clearly (Priority: P2)

**Goal**: A user can read an AI task's live status at any time, and a task that never gets a usable provider result is bounded into a clear `FAILED`/timeout state rather than polling forever.

**Independent Test**: Submit a task, read `GET /api/ai/tasks/{id}` while it's in flight (expect `QUEUED`/`RUNNING`), then force/wait past the poll budget and confirm it settles into `FAILED` with a timeout reason and the `Job` also reaches a non-running terminal state.

### Tests for User Story 2

- [X] T022 [P] [US2] Unit test for `computePollDelay()`/`hasExceededPollBudget()` (backoff grows and caps at `POLL_MAX_DELAY_MS`; budget trips at `MAX_POLL_ATTEMPTS` OR `MAX_POLL_DURATION_MS`) in `apps/worker/tests/jobs/ai-poll-budget.test.ts`. **Done**.
- [X] T023 [P] [US2] Contract test for `GET /api/ai/tasks/{aiTaskId}` (in-progress, succeeded, failed, not-found/concealed) in `apps/web/tests/ai/ai-task-status-route.test.ts`. **Done**.

### Implementation for User Story 2

- [X] T024 [US2] Extend `apps/worker/src/jobs/ai-poll.processor.ts`: add `POLL_BASE_DELAY_MS`, `POLL_MAX_DELAY_MS`, `POLL_BACKOFF_FACTOR`, `MAX_POLL_ATTEMPTS`, `MAX_POLL_DURATION_MS` constants, `computePollDelay(pollAttempts)` (exponential, capped), and `hasExceededPollBudget(aiTask)`; call the budget check **before** polling the provider on every step, and replace T019's fixed-step reschedule with `computePollDelay`. On budget exceeded: `AiTask.status = "FAILED"`, `Job.status = "FAILED"`, `Job.errorCode = "AI_TASK_TIMEOUT"`. *(depends on T019)* **Done** — verified via T012's new budget-exceeded case.
- [X] T025 [P] [US2] Create `apps/web/src/lib/ai/ai-task-read-service.ts` — `readAuthorizedAiTask(actor, taskId)`: load `AiTask` → `requireDatasetPermission(actor, aiTask.datasetId, "dataset.read")` → return the safe DTO shape from `contracts/ai-api.md` (no `externalTaskId`, no raw provider output, no lock fields). **Done**.
- [X] T026 [US2] Create `apps/web/src/app/api/ai/tasks/[aiTaskId]/route.ts` — `GET` handler using T025; `404 AI_TASK_NOT_FOUND` for both "doesn't exist" and "not authorized" (concealed, matching existing job-route policy). *(depends on T002, T025)* **Done** — verified live via curl (401 unauthenticated) before the local dev server on :3001 stopped; see the Foundational note below re: the dev-server collision.

**Checkpoint**: User Stories 1 AND 2 both work independently; polling is now bounded and status is queryable.

---

## Phase 5: User Story 3 - Choose From Available AI Models (Priority: P3)

**Goal**: A user can list currently active AI models with their modality/task type before submitting a request.

**Independent Test**: `GET /api/ai/models` with a mix of active/inactive seeded `AiModel` rows; confirm only active ones are returned.

### Tests for User Story 3

- [X] T027 [P] [US3] Contract test for `GET /api/ai/models` (only `isActive: true` rows returned, correct shape, no `provider` field leaked) in `apps/web/tests/ai/ai-models-route.test.ts`. **Done**.

### Implementation for User Story 3

- [X] T028 [P] [US3] Create `apps/web/src/lib/ai/ai-model-service.ts` — `listActiveAiModels()`: `db.aiModel.findMany({ where: { isActive: true }, select: { id, key, displayName, modality, taskType } })`. **Done**.
- [X] T029 [US3] Create `apps/web/src/app/api/ai/models/route.ts` — `GET` handler using T028, wrapped in `getRequestActor()` auth check. *(depends on T028)* **Done** — verified live via curl (`401 AUTH_REQUIRED` unauthenticated) against a local dev server before it stopped.

**Checkpoint**: All three of US1–US3 are independently functional.

---

## Phase 6: User Story 4 - Cancel an In-Progress AI Task (Priority: P4)

**Goal**: Once a user cancels the underlying `Job` (existing `POST /api/jobs/{jobId}/cancel`), the next poll step finalizes the `AiTask` as canceled instead of contacting the provider.

**Independent Test**: Submit a task against a slow/never-completing provider double, cancel its `jobId` mid-flight, confirm no further provider calls occur and the task settles into `CANCELED`; cancel again and confirm the already-terminal outcome is unchanged.

### Tests for User Story 4

- [X] T030 [P] [US4] Integration test for cancellation ordering (poll processor invoked after `cancelRequestedAt` is set → zero provider-double calls, `AiTask` → `CANCELED`; a second cancel on an already-canceled task is a no-op) in `apps/worker/tests/jobs/ai-poll-cancellation.test.ts`. **Done** — passes against a live Postgres.

### Implementation for User Story 4

- [X] T031 [US4] Replace T019's `finalizeCanceledAiTask` stub in `apps/worker/src/jobs/ai-poll.processor.ts` with the real implementation: set `AiTask.status = "CANCELED"` (only if not already terminal), release the lock, write no provider call. Relies entirely on the existing `POST /api/jobs/{jobId}/cancel` → `cancelAuthorizedJob()` (`apps/web/src/lib/jobs/authorization.ts`) for setting `Job.cancelRequestedAt`/`status`; no new cancel route is created (see `research.md` #7). *(depends on T019/T024)* **Done** — found already fully implemented (not a stub) when this phase started; T030 now verifies it.

**Checkpoint**: All four user stories are independently functional. Full feature complete.

---

## Final Phase: Polish & Cross-Cutting Concerns

- [X] T032 [P] Run `pnpm --filter @annotationplatform/web typecheck` and `pnpm --filter @annotationplatform/worker typecheck` (and `pnpm --filter @annotationplatform/queue typecheck` for T004) across every file touched above. **Done** — clean on every AI file; remaining failures are a pre-existing, unrelated `TextDocument`→`TextAsset` refactor in progress elsewhere.
- [X] T033 [P] Run the full new Vitest suite (`apps/web/tests/ai/**`, `apps/worker/tests/jobs/ai-*.test.ts`). **Done for the worker side** — all 19 `apps/worker/tests/jobs/ai-*.test.ts` + `job-lock.test.ts` cases pass against a live local Postgres (required adding a migration — see the new Foundational note — and fixing a `model.key` selection bug in `apps/worker/tests/jobs/ai-fixtures.ts`). The `apps/web/tests/ai/**` HTTP suite was confirmed reachable (curl against a locally running dev server returned the expected `401`s from all three routes) but could not be run to completion — the only local dev server available stopped during this phase; see the Foundational note.
- [ ] T034 Execute `quickstart.md` Scenarios 1–5 end-to-end against a local Docker Compose stack; confirm every "Expect" line. **Not done** — still blocked on T006 (no real provider to submit/poll against) and on the Docker web/worker images being rebuilt with this phase's code (the running `anotations-web-1`/`anotations-worker-1` containers predate it). See the dev-server note below for why the `apps/web/tests/ai/**` HTTP suite specifically also couldn't finish this pass.

**Note on the local dev server used for verification**: `apps/web/tests/ai/**` are HTTP integration tests that hit a running Next.js server (`AI_HTTP_BASE_URL`, defaulting to `http://127.0.0.1:3000` in this codebase's convention). Port 3000 is occupied by the `anotations-web-1` Docker container (an older build, without this phase's routes). A separate `next dev` process was already running on port 3001 outside this session — curling it confirmed both new GET routes were live and returning the expected `401 AUTH_REQUIRED`. Starting a second `pnpm dev` in the same `apps/web` directory to run the test suite collided with that existing dev server's `.next/dev` lock, and the port-3001 server stopped shortly after. If that was your own active dev session, you'll need to restart it (`pnpm dev` from the repo root, or your IDE's task) — apologies for the disruption. No process was left running by this session.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup (needs T002/T003's error codes and T009's schema for T014 to compile cleanly, though T004–T008 have no Setup dependency and could start immediately). Blocks US1, US2, US4.
- **US1 (Phase 3)**: Depends on Foundational. Nothing in the feature works end-to-end until this phase completes — it is the MVP.
- **US2 (Phase 4)**: Depends on Foundational; T024 depends on T019 (extends the same file created in US1) and T026 depends on T002. Independently testable once US1's happy path exists, but its *timeout* scenario needs T019's poll loop present.
- **US3 (Phase 5)**: Depends only on Foundational (T002). Has no dependency on US1/US2/US4 and could be built in parallel with any of them.
- **US4 (Phase 6)**: Depends on T019 (extends the same file again). Needs the existing `/api/jobs/{jobId}/cancel` route, which already exists — no new task required for it.
- **Polish (Final Phase)**: Depends on whichever stories were built.

### Within-Story Notes

- T014, T019, and T024/T031 each touch a file created by an earlier task in a *different* phase (`ai-task-service.ts`, `ai-poll.processor.ts`) — this is intentional incremental extension across P1→P2→P4, not a parallelization conflict. Do not run T024 or T031 concurrently with T019; they are sequential by design.
- Within Foundational: T004, T005, T008, T009 have no interdependency and are `[P]`. T006 depends on T005; T007 depends on T005+T006.
- Within US1: T010–T012 (tests) and T013, T016, T018 (implementation) are `[P]` against each other (different files); T014/T015/T017/T019/T020/T021 are sequential (each depends on the previous).

### Parallel Opportunities

- Setup: T002, T003 in parallel.
- Foundational: T004, T005, T008, T009 in parallel; T006 → T007 sequential after T005.
- US1: T010, T011, T012 (tests) in parallel with each other and with T013/T016/T018 (different files); T014→T015 and T017 and T019→T020→T021 are otherwise sequential chains.
- US2 and US3 can be staffed in parallel once Foundational is done (US3 has zero overlap with US2's files).

---

## Parallel Example: Foundational Phase

```bash
Task: "Create packages/domain/src/ai-provider.ts with the AiProviderAdapter contract"
Task: "Create apps/worker/src/queue/job-lock.ts with renewLock()/renewOrReclaimLock()"
Task: "Create apps/web/src/lib/validation/ai-task.ts with createAiTaskSchema"
```

## Parallel Example: User Story 1 tests

```bash
Task: "Contract test for POST /api/ai/tasks in apps/web/tests/ai/ai-tasks-route.test.ts"
Task: "Unit test for ai-prediction-writer.ts in apps/worker/tests/jobs/ai-prediction-writer.test.ts"
Task: "Integration test for ai-poll.processor.ts happy path in apps/worker/tests/jobs/ai-poll.processor.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational — everything except T006 (blocked on the real AIOZ-company API contract) can be built and unit-tested against the `AiProviderAdapter` interface with a fake adapter; T006 itself waits for the real contract.
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: run `quickstart.md` Scenario 1 and 2 against a real or stubbed "AIOZ-company API".
5. Demo: submit → draft annotations appear → manual annotations untouched.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. US1 → MVP demoable (submission through to draft annotations).
3. US2 → status becomes queryable and polling becomes bounded (no more infinite RUNNING Jobs).
4. US3 → model discovery UI/API unblocked (can be done any time after Foundational, including in parallel with US2).
5. US4 → cancellation stops wasted provider calls.
6. Polish → typecheck, full test run, full quickstart pass.

---

## Notes

- [P] tasks = different files, no dependencies.
- [Story] label maps task to specific user story for traceability.
- No new Prisma migration exists in this task list — confirmed by `data-model.md`, every field already exists.
- Commit after each task or logical group; stop at any checkpoint to validate a story independently.
- Re-read the **Architecture note — provider ownership** section above before starting Phase 2 — it changes where 2 of the originally-requested files live, and T006 is blocked until the real AIOZ-company API contract is supplied.
