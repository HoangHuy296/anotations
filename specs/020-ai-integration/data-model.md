# Phase 1 Data Model: AI Integration through BullMQ

Every model and field below is **already present in the committed `prisma/schema.prisma`** (see `AiTask`, `AiModel`, `Job`, `Annotation`). This feature adds **no migration**; it only adds application code that reads/writes these existing fields according to the rules below.

## Job (existing model — relevant fields only)

| Field | Type | Role in this feature |
| --- | --- | --- |
| `id` | `String @id` | The only value ever placed in a queue payload (`{ jobId }`). |
| `type` | `JobType` | `AI_PREANNOTATE_ASSET` (single asset) or `AI_PREANNOTATE_DATASET` (multiple assets), set at creation from `assetIds.length`. |
| `status` | `JobStatus` | `QUEUED → RUNNING → COMPLETED \| FAILED \| CANCELING → CANCELED`. Never left `RUNNING`/`QUEUED` forever — enforced by poll-budget timeout and cancellation handling. |
| `stage` | `JobStage` | `CREATING_AI_TASK → WAITING_AI_RESULT → FETCHING_AI_RESULT → VALIDATING_AI_RESULT → WRITING_AI_SUGGESTIONS → FINISHED` (all values already exist in the `JobStage` enum). |
| `provider` | `RepoProvider?` | **Never read or written** by any AI code path. Retains its Phase 011 repository-import meaning exclusively. |
| `errorCode` | `String?` | Set to `"AI_TASK_TIMEOUT"` when `hasExceededPollBudget()` trips; set to the provider's error code on a provider-reported failure. |
| `cancelRequestedAt` | `DateTime?` | Read by the poll processor (after lock acquisition, before calling the provider) to short-circuit into cancellation instead of polling. |
| `lockedBy` / `lockToken` / `lockedUntil` / `heartbeatAt` | worker-lock fields | Managed by the new `renewOrReclaimLock`/`renewLock` primitives across repeated scanner-driven poll steps (not just the initial `claimJob`). |

No new `Job` field is required.

## AiTask (existing model — relevant fields only)

| Field | Type | Role in this feature |
| --- | --- | --- |
| `jobId` | `String @unique` | Enforces the 1:1 `Job ↔ AiTask` invariant at the database level; no manual duplicate check needed. |
| `modelId` | `String` | The **only** path to provider resolution (`AiModel.provider`), via `resolveAiProviderForTask`. |
| `modelNameSnapshot` / `modelVersionSnapshot` / `modelKeySnapshot` | `String` / `String?` / `String` | Captured at creation time from `AiModel`, so a later change/deactivation of the `AiModel` row never changes what an already-created `AiTask` reports it used. |
| `type` | `AiTaskType` | Copied from `AiModel.taskType` at creation. |
| `modality` | `Modality?` | Copied from `AiModel.modality` at creation; written onto each created `Annotation`. |
| `input` | `Json` | `{ assetIds: string[] }` — the originally submitted set, used to discard out-of-scope predictions (FR-015). |
| `output` | `Json?` | Set once, on success, to the validated `{ predictions }` array. |
| `status` | `AiTaskStatus` | `QUEUED → RUNNING → SUCCEEDED \| FAILED \| CANCELED`. |
| `externalTaskId` | `String? @unique` | Set by `ai-submit.processor.ts` after the provider accepts the submission; read by every subsequent poll. |
| `pollAttempts` | `Int` | Incremented on every non-terminal poll result; compared against `MAX_POLL_ATTEMPTS`. |
| `nextPollAt` | `DateTime?` | The scanner's due-work predicate (`nextPollAt <= now()`); recomputed with exponential backoff after every non-terminal poll. |
| `error` / `errorCode` / `errorDetails` | failure fields | Populated on `FAILED` (timeout or provider error). |

No new `AiTask` field is required.

## AiModel (existing model — relevant fields only)

| Field | Type | Role in this feature |
| --- | --- | --- |
| `provider` | `String` | Registry key looked up in `ai-provider-registry.ts` (e.g. `"aioz-company"`). Deliberately **not** the `RepoProvider` enum. |
| `isActive` | `Boolean` | Checked both at task-creation time (reject inactive models before opening a transaction) and defensively inside `resolveAiProviderForTask` (a model can be deactivated after a task referencing it was created). |
| `taskType` | `AiTaskType` | Drives `AiTask.type` and the `AiTaskType → AnnotationType` mapping used when creating predictions. |
| `modality` | `Modality?` | Drives `AiTask.modality`. `null` means the model supports more than one modality; this phase requires a concrete `Modality` be resolvable per submitted asset (validated against each `Asset.modality`). |

No new `AiModel` field is required.

## Annotation (existing model — relevant fields only, write path only)

| Field | Value this feature writes | Notes |
| --- | --- | --- |
| `source` | `"AI"` | The `AnnotationSource` enum already has this value. |
| `status` | `"DRAFT"` | Matches the schema default; written explicitly for clarity at the call site. |
| `createdById` | `aiTask.createdById` | The human who requested the pre-annotation, not a system/service account. |
| `reviewedById` | left `null` | Only ever set later by the existing human-review flow (Phase 017/019); this feature never sets it. |
| `properties` | `{ confidence, aiTaskId, modelKey }` | Traceability back to the originating `AiTask`/model (FR-018), inside the existing free-form `properties` JSON column — no new column. |
| `geometry` | normalized bounding-box JSON | Built from the provider's raw prediction shape; validated before write. |
| `type` | derived from `AiModel.taskType` | `DETECT_OBJECTS → BOUNDING_BOX` is the mapping this phase implements (image bounding-box, the spec's primary flow); other `AiTaskType` values are out of scope until a later phase defines their `AnnotationType` mapping. |

**Invariant enforced by code, not schema**: every write in this feature's transaction is `tx.annotation.create(...)`. No AI code path ever calls `tx.annotation.update()` or `tx.annotation.delete()` against a pre-existing row, which is what guarantees `source = MANUAL` annotations are never touched (FR-016) — reviewed at the code level, since the schema cannot express "never update a sibling row of a different source value."

## State Transitions

### AiTask / Job (paired lifecycle)

```text
[POST /api/ai/tasks, in one transaction]
  Job:    (created) QUEUED
  AiTask: (created) QUEUED
        │
        ▼  (single BullMQ delivery, ai-submit.processor.ts)
  Job:    RUNNING, stage=WAITING_AI_RESULT
  AiTask: RUNNING, externalTaskId set, nextPollAt = now + POLL_BASE_DELAY_MS
        │
        ▼  (scanner-driven poll steps, ai-poll.processor.ts; repeats)
  ┌─ provider PENDING/IN_PROGRESS ─┐        ┌─ hasExceededPollBudget() ─┐
  │  AiTask.pollAttempts += 1       │        │  AiTask: FAILED           │
  │  AiTask.nextPollAt = backoff()  │        │  Job: FAILED,             │
  │  Job: lock renewed, stays       │        │       errorCode=          │
  │       RUNNING                   │        │       AI_TASK_TIMEOUT     │
  └──────────────────────────────────┘        └────────────────────────────┘
        │                                              │
        ▼ provider COMPLETED                           ▼ (terminal)
  [handleAiTaskCompleted, one transaction]
  AiTask: SUCCEEDED, output = predictions
  Job:    COMPLETED, stage=FINISHED, finishedAt
  N × Annotation created (source=AI, status=DRAFT)
        │
        ▼ provider FAILED
  AiTask: FAILED, error/errorCode from provider
  Job:    FAILED

        │ (at any poll step, checked after lock, before provider call)
        ▼ Job.cancelRequestedAt is set
  AiTask: CANCELED
  Job:    CANCELED (via existing cancelAuthorizedJob path)
```

Terminal states for both `Job` and `AiTask` are mutually exclusive and reached exactly once per task; the transactional writes above and the lock-gated poll step make re-entry (duplicate scanner tick, redelivered queue message) a no-op rather than a duplicate transition.

## Validation Rules Recap (from spec Functional Requirements)

- `assetIds` must all belong to `datasetId`, and the actor must hold `annotation.create` on that dataset — checked **before** opening the creation transaction (FR-002).
- `modelId` must reference an `isActive: true` `AiModel` — checked before the transaction and re-checked at resolve-time in the worker (FR-003).
- A prediction whose `assetId` is not in the task's original `input.assetIds` is discarded, never turned into an `Annotation` (FR-015).
- A prediction whose `labelKey` cannot be resolved in the dataset's `Label` set is skipped individually; it does not fail the whole task (spec Edge Cases / Assumptions).
- `pollAttempts >= MAX_POLL_ATTEMPTS` OR elapsed time since `AiTask.createdAt >= MAX_POLL_DURATION_MS` ⇒ stop polling, `FAILED` / `AI_TASK_TIMEOUT` (FR-010).
- Cancellation (`Job.cancelRequestedAt`) is read after lock acquisition and before any provider call on every poll step (FR-011).
