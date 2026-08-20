# Implementation Plan: AI Integration through BullMQ

**Branch**: `020-ai-integration` | **Date**: 2026-08-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/020-ai-integration/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Turn AI provider output into new draft `Annotation` rows without ever touching manually created annotations. A public `POST /api/ai/tasks` route creates exactly one `Job` + one `AiTask` (linked 1:1 via `AiTask.jobId @unique`) inside a single Prisma transaction, then enqueues `{ jobId }` only after that transaction commits. The private worker resolves the AI provider strictly from `AiTask.modelId → AiModel.provider` (never `Job.provider`, which keeps its unrelated repository-import meaning). Submission to the external provider happens once, on the normal single BullMQ delivery for the `Job`. Ongoing status polling is **not** re-delivered through BullMQ — the queue transport in this codebase permits at most one delivery per durable `Job` (`enqueueExistingJob` stamps `queueName`/`queueJobId` exactly once) — so polling instead reuses this codebase's existing worker-scanner pattern (`import-timeout-scanner.ts`, `recovery-scanner.ts`): a short-interval scanner reads `AiTask` rows whose `nextPollAt` has elapsed, acquires/renews a per-`Job` lock, checks cancellation, polls the provider, applies bounded exponential backoff, and — on success — creates new `source = AI`, `status = DRAFT` annotations in a transaction that also finalizes the `AiTask` and `Job`. All new code lives in the already-reserved layout (`apps/web/src/app/api/ai/`, `apps/web/src/lib/ai/`, `apps/worker/src/jobs/ai-*`, `apps/worker/src/queue/job-lock.ts`); the Prisma schema already carries every field this feature needs (`AiTask`, `AiModel`, `Annotation.source = AI`, `JobType.AI_PREANNOTATE_*`, `JobStage.CREATING_AI_TASK` … `WRITING_AI_SUGGESTIONS`), so this phase adds no migration.

## Technical Context

**Language/Version**: TypeScript (Next.js App Router web app on Node.js; private worker as a separate Node.js process), matching every prior phase.

**Primary Dependencies**: Next.js Route Handlers, Prisma (`@internal/db` path alias to the generated client), BullMQ (`@annotationplatform/queue` shared package), Zod for request/service validation, `ioredis` for the worker's Redis connection. No new npm package is introduced.

**Storage**: PostgreSQL via Prisma is the source of truth for `Job`, `AiTask`, `AiModel`, and `Annotation`. Redis/BullMQ is transport-only (`{ jobId }` payload). MinIO is not written to by this feature (AI predictions carry geometry/labels, not binaries); `AiTask.resultStorageKey` exists in the schema for a future large-result-to-MinIO path but is out of scope here.

**Testing**: Vitest, matching `apps/worker/tests/**` and existing web unit/integration tests; contract-level tests for the three new routes and the two new worker processors, plus a lock-primitive unit test (`job-lock.ts`) exercising concurrent-claim and expired-lock reclaim.

**Target Platform**: Linux server (Docker Compose topology already established in Phase 1) — Next.js web app + private worker process, both against the same PostgreSQL/Redis/MinIO.

**Project Type**: Web application monorepo (existing `apps/web` + `apps/worker` + shared `packages/*`) — this feature adds files inside that structure, it does not introduce a new project.

**Performance Goals**: Acceptance/enqueue of an AI task responds in the same class as other durable-Job creation routes (sub-second, excluding network). Poll cadence starts at 2s and backs off exponentially to a 30s ceiling, so a scanner tick interval on the order of 1–2s (matching the existing 60s `import-timeout-scanner` pattern, but tighter given the shorter base delay) is sufficient to honor `nextPollAt` promptly.

**Constraints**: Queue payload is strictly `{ jobId }` (`docs/bullmq-postgres-job-flow.md`). At most one BullMQ delivery exists per durable `Job` (existing `enqueueExistingJob` guard) — polling must not depend on repeated queue delivery. `AiTask.jobId` is `@unique`, enforced at the database level. Provider resolution must never read/write `Job.provider`. Manually created (`source = MANUAL`) annotations must never be updated or deleted by any AI code path. `MAX_POLL_ATTEMPTS` / `MAX_POLL_DURATION_MS` must bound every poll loop.

**Scale/Scope**: Three new API routes, three new `apps/web/src/lib/ai/*` service modules (task creation, task read, model list — none of them touch the AI provider directly), one new shared `packages/domain/src/ai-provider.ts` type-contract module, one worker-owned provider adapter + registry, two new worker job processors, one new worker lock primitive, one new worker scanner, and one `supportedQueueJobTypes` addition. No new Prisma models or migrations.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the unfilled template for this project; per `CLAUDE.md`, the binding governance document is `AGENTS.md` ("Fieldframe Agent Governance"), which this check applies:

| Gate (from AGENTS.md) | Status | Notes |
| --- | --- | --- |
| Common `Job` is the sole durable-workflow table; no `AiTaskJob`-style duplicate table | PASS | Feature reuses the existing `Job` model; `AiTask` is the AI business record, already `@unique` on `jobId`. |
| Redis/BullMQ carries only `{ jobId }`, never full input or state | PASS | `ai-submit`/enqueue use the existing `jobQueuePayloadSchema`; no full `AiTask` fields cross the wire. |
| No binary data in PostgreSQL | PASS | Predictions are geometry/label JSON on `Annotation`; no binaries are written by this feature. |
| Retries idempotent; no duplicate asset/artifact on duplicate delivery | PASS | `AiTask.jobId` uniqueness plus the poll processor's lock-gated, transactional `handleAiTaskCompleted` prevents duplicate `Annotation` creation on redelivery or duplicate scanner ticks. |
| `Annotation.geometry` canonical; `Annotation.revision` required and stale-overwrite-safe on every update | PASS (N/A for creates) | AI predictions are always **created**, never update an existing `Annotation`, so `revision` starts at its schema default; no optimistic-lock path is touched. |
| Provider/DB/Redis/MinIO credentials never reach browser code, queue payloads, or MinIO object metadata | PASS | The AI provider adapter (worker-only, see Project Structure) holds the AIOZ-company API key/endpoint as worker-process config; `apps/web` never imports or constructs the adapter, never places a credential in `AiTask.input`/`output`, and never puts one in the queue payload. |
| Absolute `@/lib/...` imports; server logic out of UI; Zod for request/Server-Action validation | PASS (design intent) | New routes/services follow the same conventions as `apps/web/src/lib/exports/export-service.ts` and `apps/web/src/lib/jobs/authorization.ts`. |
| No new npm package without explicit permission | PASS | No new dependency is introduced; the "AIOZ-company API" adapter uses the platform's existing `fetch`-based HTTP pattern (mirrors `provider-fetch.ts`). |
| No workaround mock in place of an earlier approved phase's real dependency | PASS | The AI provider adapter calls a real external HTTP endpoint (configured via env), not a mock; `AiModel`/`AiTask` schema already exists from an approved phase. |
| Canvas rules (react-konva, commit-at-boundary) | N/A | This feature does not touch canvas/annotation-editing UI; it only creates `DRAFT` annotations for the existing review UI (Phase 017/019) to display. |
| Phase discipline: do not implement later-phase work early | PASS | No workspace-UI "request AI pre-annotation" button, no export/download of AI results, and no `AiTask.resultStorageKey` MinIO path are built here — those remain candidate future phases per the spec's Assumptions. |

**Result**: No violations requiring the Complexity Tracking table. Initial gate: **PASS**.

### Post-Design Re-Check

Re-evaluated after Phase 0 (`research.md`) and Phase 1 (`data-model.md`,
`contracts/`, `quickstart.md`) were produced:

- No new Prisma model, field, or migration was introduced — `data-model.md`
  confirms every field this feature touches already exists in the committed
  schema.
- The two additive worker primitives design decided on (`job-lock.ts`'s
  `renewOrReclaimLock`/`renewLock`, and the `ai-poll-scanner.ts` interval
  scanner) extend the existing worker-lock and scanner patterns
  (`job-claim-lock.ts`, `import-timeout-scanner.ts`) rather than replacing or
  weakening them for any other `JobType`.
- No new npm dependency was introduced by the research decisions (the
  "AIOZ-company API" adapter uses `fetch`, matching `provider-fetch.ts`).
- `contracts/ai-api.md` confirms `Job.provider` never appears in any request
  or response body, and confirms cancellation reuses the existing
  `POST /api/jobs/{jobId}/cancel` route rather than adding a duplicate.

**Result**: **PASS**, unchanged from the initial gate. Complexity Tracking
table remains intentionally empty.

## Project Structure

### Documentation (this feature)

```text
specs/020-ai-integration/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md         # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
apps/web/src/app/api/ai/
├── models/route.ts                 # GET — list active AiModel rows (id, key, displayName, modality, taskType)
├── tasks/route.ts                  # POST — creates Job + AiTask in one transaction, enqueues { jobId } post-commit, 202
└── tasks/[aiTaskId]/route.ts       # GET — authorized AiTask status read (cancellation reuses existing /api/jobs/[jobId]/cancel)

apps/web/src/lib/ai/
├── ai-task-errors.ts                # typed AiTaskError (AI_MODEL_INACTIVE / AI_MODEL_NOT_FOUND / ASSET_NOT_IN_DATASET)
├── ai-task-service.ts               # assertAssetsBelongToDataset() pre-check + createAiTask() transaction + post-commit enqueue
├── ai-task-read-service.ts          # readAuthorizedAiTask(): dataset-scoped status read
└── ai-model-service.ts              # listActiveAiModels()

# apps/web NEVER imports or constructs an AiProviderAdapter. It only reads
# AiModel.isActive/displayName/modality/taskType from Postgres — it never
# resolves a provider adapter and never calls the external AI provider,
# matching AGENTS.md's boundary ("Next.js backend API: validate, authorize,
# write metadata, create durable Jobs, enqueue") and FR-006 (acknowledge
# without waiting on the provider). See research.md #3 for the rationale
# behind moving the two files this area originally listed
# (ai-provider-registry.ts, providers/aioz-company.provider.ts) below —
# split across packages/domain (pure contract) and apps/worker (the code
# that actually performs the outbound call).

packages/domain/src/ai-provider.ts   # NEW — pure, DB-free, Prisma-free shared contract:
                                      #   AiProviderAdapter interface (submitTask, getTaskStatus)
                                      #   AiProviderSubmitInput / AiProviderSubmitResult
                                      #   AiProviderStatusResult / AiProviderPrediction
                                      # Exported via packages/domain/src/index.ts + package.json "./ai-provider",
                                      # matching the existing provider-config.ts / source-access-policy.ts pattern.

apps/worker/src/providers/ai/
├── aioz-company.provider.ts        # concrete AiProviderAdapter — the ONLY code that calls the external
                                      # AIOZ-company AI service. BLOCKED on the real AIOZ-company API contract
                                      # (see research.md "Open Dependency"); must not be written from a guess.
└── ai-provider-registry.ts          # resolveAiProviderForTask(db, aiTask): AiTask.modelId → AiModel row
                                      # (Prisma lookup, worker-only) → AiModel.provider → adapter, via the
                                      # pure AiProviderAdapter contract from @annotationplatform/domain/ai-provider.
                                      # Never reads or writes Job.provider.

apps/worker/src/jobs/
├── ai-submit.processor.ts          # first (and only) queue delivery: submits to provider, stores externalTaskId, sets nextPollAt, stage = WAITING_AI_RESULT
├── ai-poll.processor.ts            # one poll step: load Job → renew-or-reclaim lock → check cancellation → poll provider → update AiTask → update Job → recompute nextPollAt (no re-enqueue)
└── ai-prediction-writer.ts         # validate AiProviderPrediction[] → resolve Label → tx.annotation.create() (never update/delete)

apps/worker/src/queue/
├── job-lock.ts                     # renewLock(), renewOrReclaimLock() — new primitive for scanner-driven, non-queue-delivered re-entry into a RUNNING Job
└── ai-poll-scanner.ts              # setInterval-style scanner (mirrors import-timeout-scanner.ts): finds AiTask rows with elapsed nextPollAt and invokes ai-poll.processor

packages/queue/src/job-contract.ts  # MODIFIED — add AI_PREANNOTATE_ASSET / AI_PREANNOTATE_DATASET to supportedQueueJobTypes
apps/worker/src/queue/queue-router.ts  # MODIFIED — dispatch AI_PREANNOTATE_ASSET / AI_PREANNOTATE_DATASET to ai-submit.processor
apps/worker/src/index.ts / readiness.ts # MODIFIED — start the ai-poll-scanner interval alongside the existing import-timeout scanner
```

**Structure Decision**: Existing monorepo layout (`apps/web`, `apps/worker`, `packages/queue`, `packages/domain`) is reused as-is. The AI provider's **type contract** is pure/DB-free and lives in `packages/domain` (already a dependency of both `apps/web` and `apps/worker`, already the home for exactly this kind of shared, Prisma-free logic — see `provider-config.ts`, `source-access-policy.ts`). The AI provider's **concrete implementation and DB-touching registry** live worker-only under `apps/worker/src/providers/ai/`, mirroring the existing precedent that `apps/web/src/lib/providers/{github,gitea}` (web-side preflight) and `apps/worker/src/source/source-access.ts` (worker-side access) are already two separate, non-importing implementations — `apps/worker` has no import path to `apps/web/src/lib` and never uses one. `apps/web/src/lib/ai/` contains only Postgres-reading service modules; it never resolves or calls an AI provider.

## Complexity Tracking

*No Constitution Check violations were found; this table is intentionally empty.*
