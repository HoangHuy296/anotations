# Tasks: Dataset Bulk AI Inference (Single-Asset and Bulk-Selection AI Preannotation)

**Feature**: 026-single-bulkselection-asset
**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md), [verification/audit.md](verification/audit.md)
**Task IDs T001–T092 are the user's requested numbering and are preserved.** T093–T095 are appended only to cover spec requirements absent from that list (SC-010, SC-009, security audit). The earlier 57-task breakdown is kept unchanged as `tasks.superseded-57.md`; its reconciled decisions are carried into the tasks below.

**Checking rule (user):** mark a task `[X]` only when the implementation AND the required evidence are complete. Read-only audit tasks are complete when their evidence document exists. A skipped, blocked or mocked-only check is never a pass.

## Gate register — read before starting any task

| Gate | Blocks | State (2026-09-24) |
| --- | --- | --- |
| **G1** deployed AI Service contract + N-input correlation guarantee (T006, T007) | every task from T009 onward | **OPEN** — only a 2-image observation in repo notes; docs and adapter disagree on `task_name`. If correlation is not guaranteed, **stop and report; do not invent a contract or code around it.** |
| **E3** AI-service-side reachability of scoped MinIO downloads (part of T006) | T028, T031, T082 | **OPEN** |
| **E1** uncommitted Phase 025 in this working tree | every production-code task (T009+) | **HOLD** — the user commits/stashes/isolates 025; the assistant runs no git history operations |
| I1 plan/tasks consistency | — | Reconciled in `plan.md` |
| **I2** a skipped (e.g. review-frozen) target ends the operation FAILED, also for one Asset | T043, T047, T059, T066 | Decided — `research.md` D-I2 |
| **U1** source identity from `sourceFingerprint` etc.; checksum not required | T022, T030 | Decided — `research.md` D-U1 |
| **C1** new codes into closed `ApiErrorCode`; **I3** HTTP mapping | T014–T017, T056, T067 | Written into those tasks |
| **C2** domain package has no `test` script | T022 | Written into T022 |
| **A1** five real annotators for SC-009; **A2** glossary | T094, T088 | A2 glossary in `data-model.md`; A1 rule in T094 |

**Labels.** `[US1]`–`[US7]` are the requested workstreams; they map to the spec's stories as: US1/US2 → spec US1+US2; US3/US4/US5 → spec US4 (+US3 dispatch); US6 → spec US1+US2 UI; US7 → spec US3. `[P]` = independent files, no incomplete dependency.

## Phase 0: Audit (no implementation)

- [X] T001 Locate the AI model/task clients and single-asset execution path. Evidence: `verification/audit.md` rows 1–2 (`apps/web/src/lib/ai/ai-task-api-client.ts`, `ai-task-service.ts`, `app/api/ai/tasks/route.ts`, `components/workspace/ai-detect-dialog.tsx`).
- [X] T002 Document AI Job type/stages/state machine and retry/cancel/recovery semantics. Evidence: `verification/audit.md` rows 3, 4, 10 (`JobType`, `JobStatus`, `AiTaskStatus`, `retry-job.ts` has no AI case, cancel delegates to `cancelAuthorizedJob`).
- [X] T003 Locate Phase 022 EXPLICIT/FILTERED contract and server resolver. Evidence: `verification/audit.md` row 6 (`asset-selection-store.ts`, `validation/asset-bulk.ts`, `assets/asset-bulk-service.ts`, `types/workspace.ts`).
- [X] T004 Locate MinIO storage-key and presigned-URL utilities. Evidence: `verification/audit.md` row 7 (`apps/worker/src/providers/ai/aioz-task-resources.ts`, 20-minute `presignedGetObject`).
- [X] T005 Locate the canonical AI prediction writer and Phase 023 parent-revision behavior. Evidence: `verification/audit.md` rows 5c, 8 (`ai-prediction-writer.ts`, `ai-video-prediction-writer.ts`, `claimEditableAssetContent`).
- [ ] T006 Verify the real deployed AI Service create-task request/response schema. Write redacted, version-identifiable evidence to new `verification/provider-contract.md` (resolve the `task_name` doc-vs-adapter disagreement, scalar vs array `model_id`, per-model/modality file-count, payload and response limits, IMAGE/VIDEO matrix) and new `verification/source-access.md` (E3: a scoped MinIO download performed **from the AI Service's network**, download time versus the 20-minute TTL, behavior when the link expires or is unreachable). Needs whoever operates the AI Service; record unavailable evidence as BLOCKED, never as assumed.
- [ ] T007 Verify the real status/result schema and the exact batch input-correlation guarantee. Write new `verification/correlation.md` (same-filename, reordered, missing, duplicate and unknown result groups; explicit zero-detection group; whether independent groups may proceed) and new `verification/recovery-contract.md` (idempotency key, lookup by client id, cancel endpoint — currently none documented — and the fail-closed policy for an ambiguous submission). Use a real N>2 run; adapter tests are not evidence.
- [X] T008 Produce the reuse/extend/blocker audit. Done: `verification/audit.md` (verdict: correlation at N inputs is a **blocker**, not coded around). Re-open this task and update the file if T006/T007 change any row.

**Checkpoint — STOP HERE unless T006 and T007 hold real evidence, T008's verdict is not BLOCKED, and the user has confirmed Phase 025 is isolated.** Then fold the evidence into `research.md`, `data-model.md`, `contracts/ai-batch-api.md`, `contracts/ai-batch-worker.md`, `contracts/ai-batch-ui.md` and `quickstart.md`, publish the verified effective limit (at most 200, `BULK_SYNC_MAX_ASSETS`), and report the phase with AGENTS.md's seven fields.

## Phase 1 — US1: Unified target resolution

**Goal**: current Asset and Phase 022 selections resolve through one strict, ordered, all-or-nothing server path. **Independent test**: explicit, filtered (multi-page) and current-Asset inputs each yield one ordered, deduplicated Asset list; empty, mixed, foreign or oversized input is rejected whole.

- [ ] T009 [US1] Define the `AiDetectionTarget` contract in new `apps/web/src/types/ai-batch.ts`: `{ mode:"CURRENT_ASSET"; assetId } | { mode:"BULK_SELECTION"; selection }`, where `selection` is the exported Phase 022 shape (T010). Add the request union to `apps/web/src/lib/validation/ai-task.ts` (`createAiTaskSchema`): new `target` (+ optional `previewFingerprint`) mutually exclusive with legacy `assetIds`; reject both together; keep `datasetId`, `modelId`, `classes`, thresholds. No page/cursor/sort/filename/file-URL/full-record fields.
- [ ] T010 [US1] Export the existing Phase 022 selection schema from `apps/web/src/lib/validation/asset-bulk.ts` (`bulkSelectionSchema`, `bulkSelectionQuerySchema`) for reuse in T009; do not copy or redefine it; behavior of existing bulk routes must not change.
- [ ] T011 [US1] Implement authoritative CURRENT_ASSET resolution in new `apps/web/src/lib/ai/ai-target-service.ts`: `resolveAiTarget(actor, datasetId, target)` returns the one Asset (dataset-scoped, `deletedAt`/`archivedAt` null) as a one-element ordered list through the same code path as bulk (no special branch after resolution). Require `annotation.create`.
- [ ] T012 [US1] Implement strict EXPLICIT resolution: add a strict, transaction-client-aware mode to `resolveBulkSelection` in `apps/web/src/lib/assets/asset-bulk-service.ts` (existing callers keep partial-skip). Deduplicate ids **before** the limit check; reject the whole request if any id is missing, archived, deleted or outside the dataset; order by `id ASC`; no `notFoundIds` partial result; do not list concealed ids.
- [ ] T013 [US1] Implement strict FILTERED resolution in the same strict mode using `buildAssetListWhere` from `apps/web/src/lib/workspace/workspace-assets.ts`: one ordered query `orderBy id ASC, take effectiveLimit+1`; if `effectiveLimit+1` rows return, reject (never truncate); never trust `filteredCount`; membership is resolved once, in the acceptance request, and the resulting id list (not the query) is what gets stored.
- [ ] T014 [US1] Validate a non-empty target in `ai-target-service.ts`; add `TARGET_EMPTY` to the closed `ApiErrorCode` union in `apps/web/src/lib/api-response.ts` (**C1**) and map it in `apps/web/src/app/api/ai/tasks/route.ts` (400).
- [ ] T015 [US1] Validate exactly one modality in `ai-target-service.ts` (reject mixed IMAGE/VIDEO/AUDIO atomically, no partition, no current-Asset fallback); add `TARGET_MIXED_MODALITY` to `ApiErrorCode`; **I3** status 422.
- [ ] T016 [US1] Validate model/task compatibility with the resolved modality (active model, `AiModel.modality`/`taskType`; VIDEO only if T006 verified batch support, else `AI_CAPABILITY_UNVERIFIED` 409); enforce the effective limit (`TARGET_TOO_LARGE` 422, mirrors `SELECTION_TOO_LARGE`); add `TARGET_INELIGIBLE`, `TARGET_TOO_LARGE`, `AI_CAPABILITY_UNVERIFIED` to `ApiErrorCode`.
- [ ] T017 [US1] Preserve authorization and concealment: dataset membership and `annotation.create` checked before resolution; unknown/foreign/unauthorized resources return the existing 404/403 without revealing ids; a bad member of an otherwise valid request returns 409 `ASSET_NOT_IN_DATASET` (existing route behavior) — no per-id detail.
- [ ] T018 [US1] Add tests, written first, in new `apps/web/tests/ai/ai-batch-targets.test.ts`: current-Asset parity with a one-member explicit target; explicit with duplicates/missing/archived/foreign ids (whole-request rejection); filtered over three pages (100% of matches, zero unselected, deterministic order, limit+1 rejection, same-count membership change); mixed-modality atomic rejection; model/modality incompatibility; over-limit; empty; concealment. Also confirm `apps/web/tests/assets-bulk/selection-resolution.test.ts` still passes unchanged.

## Phase 2 — US2: Durable batch Job

**Goal**: one accepted operation = one Job + one AiTask holding the authoritative target; queue carries `{jobId}` only. **Independent test**: N-Asset request creates exactly one Job/AiTask; a failure before commit creates none; enqueue failure after commit keeps the references.

- [ ] T019 [US2] Extend `createAiTask` in `apps/web/src/lib/ai/ai-task-service.ts` to accept the resolved target: keep remote catalog/class reads outside the transaction; inside one bounded-retry `Prisma.TransactionIsolationLevel.Serializable` transaction re-resolve (T012/T013), recheck active model, then create the Job + AiTask; keep `JobType.AI_PREANNOTATE_ASSET` (1) / `AI_PREANNOTATE_DATASET` (>1), set `Job.modality` and `totalItems`; return 202 `{taskId, jobId}` plus a safe accepted-target summary; update `apps/web/src/lib/ai/ai-task-api-client.ts`.
- [ ] T020 [US2] Keep PostgreSQL authoritative: write the versioned accepted target/configuration into `Job.input` (currently left `{}`) — schema in `packages/domain/src/ai-batch.ts` (T022); `AiTask.input` remains the provider-facing projection and must match; a mismatch is detected, not silently chosen.
- [ ] T021 [US2] Keep the BullMQ payload exactly `{ jobId }` (`enqueueExistingJob` in `apps/web/src/lib/queue/enqueue-job.ts`, enqueue strictly after commit); add an assertion test that no asset list, URL or credential appears in the payload.
- [ ] T022 [US2] Persist stable identities without filenames: create `packages/domain/src/ai-batch.ts` (versioned zod schemas: ordered targets `{assetId, inputIndex, sourceIdentityDigest}`, configuration, per-Asset outcome, aggregate counts) exported from `packages/domain/package.json`. `sourceIdentityDigest` follows research.md D-U1 (`sourceFingerprint`, `currentVersionId`, `sourceRevision`, `sizeBytes`, `checksum`/`cacheChecksum` when present, selected object locator; require fingerprint, size and storage locator, not a checksum) and verify how `sourceFingerprint` behaves on UPLOAD-mode replacement (`apps/web/src/lib/upload-verification.ts`). **C2**: add a `test` script to `packages/domain/package.json` (`node --import tsx --test`, no new package) and tests in new `packages/domain/tests/ai-batch.test.ts` (bounded unique order, finite thresholds, zero vs missing, secret-free projections).
- [ ] T023 [US2] Guarantee no fan-out: one request → one Job/AiTask regardless of N; add an assertion that a 7-Asset request creates exactly 1 Job and 1 AiTask (`AiTask.jobId` is `@unique`).
- [ ] T024 [US2] Migration decision: default is **no migration** (existing `Job.input/state/summary` and `AiTask` JSON suffice per `data-model.md`). Only if T006–T023 prove an invariant impossible, propose an additive migration with justification and ask the user before touching `prisma/migrations`; otherwise record "no migration" in the report.
- [ ] T025 [US2] Add tests, written first, extending `apps/web/tests/ai/ai-tasks-route.test.ts` and `apps/web/tests/ai/ai-preannotate-happy-path.test.ts`: versioned `Job.input`, one Job for N, no Job on pre-commit rejection, post-commit enqueue failure keeps `taskId/jobId`, repeated identical request behavior, legacy `assetIds` caller unchanged (202 `{taskId,jobId}`).

## Phase 3 — US3: Batch worker dispatch

**Goal**: the worker rebuilds the input from PostgreSQL and makes exactly one create-task call with all files. **Independent test**: N accepted Assets → one reservation, one POST with N `files`, durable ordered mapping, no signed URL persisted or logged.

- [ ] T026 [US3] In `apps/worker/src/jobs/ai-submit.processor.ts`, read the versioned `Job.input`, validate it against `AiTask.input`, and load the target Assets from PostgreSQL by the stored ids; handle historical `Job.input={}` tasks only through a narrowly validated legacy branch; recheck requester permission, active model and every Asset (`deletedAt`/`archivedAt` null, editable workflow state); if any accepted Asset is no longer valid, **submit nothing** and finalize all accepted targets with safe reasons (no smaller batch).
- [ ] T027 [US3] In `apps/worker/src/providers/ai/aioz-task-resources.ts`, resolve each Asset's canonical storage object server-side (original vs cache per existing selection) and compare its identity to the stored `sourceIdentityDigest`.
- [ ] T028 [US3] Generate object-scoped short-lived URLs server-side with the existing `presignedGetObject` path (TTL per T006 evidence; requires `MINIO_PUBLIC_ENDPOINT`); never accept a client URL. Depends on the E3 evidence in `verification/source-access.md`.
- [ ] T029 [US3] Ensure signed URLs, query strings and credentials are never logged or persisted: add a test capturing worker log output and job/AiTask rows for a batch run and asserting none contain the signature parameters.
- [ ] T030 [US3] Build the deterministic ordered Asset↔input mapping: extend the manifest `AiTask.summary.aiozSubmission.images` to `{assetId, inputIndex, urlDigest, sourceIdentityDigest}`; reject duplicate digests unless T007 proves a unique input identity; the mapping is written before the HTTP call.
- [ ] T031 [US3] Call the AI Service create-task exactly once with the full `files[]` in `apps/worker/src/providers/ai/aioz-annotation-services-provider.ts`, using the request shape verified in T006 (scalar `model_id`, `type`/`task_name` per evidence); enforce verified size/payload limits with a durable safe failure instead of truncation.
- [ ] T032 [US3] Persist the external task identity on `AiTask.externalTaskId` (unique) and `nextPollAt` through the existing path; keep the reservation/`AIOZ_SUBMISSION_AMBIGUOUS` fail-closed behavior; never clear a reservation to resubmit.
- [ ] T033 [US3] Prove one call for N: extend `apps/worker/tests/jobs/aioz-provider-pipeline.test.ts` with 2, 7 and the verified maximum Assets asserting exactly one POST, N `files`, no fan-out, and dispatch-time invalidity rejecting the whole submission.

## Phase 4 — US4: Polling and result correlation

**Goal**: results attach to the right Asset only through verified identity. **Independent test**: same-filename, reordered, missing, duplicate and unknown groups never attribute a prediction to the wrong Asset.

- [ ] T034 [US4] Reuse the existing polling lifecycle (`apps/worker/src/jobs/ai-poll.processor.ts`, `apps/worker/src/queue/ai-poll-scanner.ts`); no new queue or loop. Reconcile the 8 MiB response cap, 60-poll/15-minute budget and signing TTL with the verified maximum; exceeding them is a durable safe failure.
- [ ] T035 [US4] Implement correlation from the verified contract (T007): extend `packages/domain/src/ai-provider.ts` so a COMPLETED result carries explicit per-input groups (identity, outcome kind, predictions) instead of only a flattened list; adapt `aioz-annotation-services-normalization.ts` and `aioz-video-normalization.ts`; a confirmed empty group is success with zero predictions, an absent group is `MISSING_RESULT`, never success.
- [ ] T036 [US4] Reject and record unknown result identifiers (a returned `image_path`/`video_path` digest not in the manifest) as a durable, sanitized outcome; fail closed before any write when attribution is ambiguous.
- [ ] T037 [US4] Reject and record duplicate result mappings (two groups for one input, or one group matching two inputs).
- [ ] T038 [US4] Handle cardinality mismatch without guessing: replace today's whole-task `AIOZ_INVALID_OUTPUT` on any count mismatch with per-input outcomes, and fail every unresolved input when the contract does not prove independent groups safe (per T007).
- [ ] T039 [US4] Never correlate by filename or array position: add a test with two Assets sharing a filename and a reversed result order that still resolves by digest only.
- [ ] T040 [US4] Add multi-file correlation tests in `apps/worker/tests/providers/ai/aioz-annotation-services-normalization.test.ts` and `apps/worker/tests/jobs/aioz-provider-pipeline.test.ts` (reordered, same filename, missing, duplicate, unknown, explicit-zero, malformed geometry invalidating its whole Asset group).

## Phase 5 — US5: Canonical per-Asset prediction writes

**Goal**: every accepted Asset gets exactly one durable, workflow-safe outcome. **Independent test**: a frozen Asset is not mutated while others in the same batch still succeed; replay writes nothing twice.

- [ ] T041 [US5] Group predictions by mapped Asset in `apps/worker/src/jobs/ai-prediction-writer.ts` (and `ai-video-prediction-writer.ts` for verified VIDEO).
- [ ] T042 [US5] Re-check authoritative state at write time, per Asset, **inside that Asset's own transaction** (no single giant transaction across Assets; no external call inside a transaction): Dataset access, source identity, workflow status via the guarded update below.
- [ ] T043 [US5] Enforce review freeze with the existing predicate (`claimEditableAssetContent` in `apps/web/src/lib/workflow/asset-workflow-service.ts:61`; the worker writers use the same inline `updateMany` — add a parity test): a frozen Asset is not mutated and is recorded `SKIPPED` with reason `WORKFLOW_FROZEN`. **I2**: any skipped target makes the operation FAILED (also for one Asset); successful Assets remain durable.
- [ ] T044 [US5] Keep the canonical AI annotation path: append AI/DRAFT annotations with existing provenance, label resolution and manual/accepted-work protection; prevalidate an Asset's whole prediction set so any failure rolls back that Asset only.
- [ ] T045 [US5] Preserve `Annotation.revision` optimistic-lock semantics; a replayed or failed write creates no extra revision.
- [ ] T046 [US5] Preserve Phase 023 parent revision: increment `Asset.revision` only for real content changes, atomically with the annotation writes; an explicit zero-detection success or replay must not advance it; a stale reviewer decision must still fail.
- [ ] T047 [US5] Record an explicit per-Asset outcome (`SUCCEEDED` incl. zero, `FAILED`, `SKIPPED`, `MISSING_RESULT`, `CANCELED`) with `predictionCount` and a sanitized reason, committed in the same Asset transaction as its writes; create `apps/worker/src/jobs/ai-batch-state.ts` for the fenced checkpoint (Job lease/status/`cancelRequestedAt` + generation), and reconcile counts to N before the terminal Job/AiTask update. No terminal record keeps pending targets.
- [ ] T048 [US5] Add the delayed-result freeze race test in `apps/worker/tests/jobs/ai-prediction-writer.test.ts` and `apps/web/tests/workflow/stale-review-race.test.ts` with real PostgreSQL: freeze after acceptance, deliver results, assert no mutation of the frozen Asset. Keep `late AI output preserves review-frozen Asset status, revision and workflow history` passing **unchanged**; add new assertions for the SKIPPED outcome and FAILED aggregate (list any existing expectation that assumed SUCCEEDED as a deliberate change).
- [ ] T049 [US5] Add per-Asset revision tests (`apps/web/tests/workflow/asset-revision-invalidation.test.ts` plus worker tests): revision +1 per Asset with real changes, unchanged on zero/replay/failure, older review decision rejected.
- [ ] T050 [US5] Add the wrong-Asset safety test: two same-filename, distinguishable Assets and swapped results never cross-write; and a mixed-outcome batch (one frozen, one succeeding) in one completion call.

## Phase 6 — US6: Unified UI

**Goal**: one existing panel targets the current Asset or the active selection and shows what will run. **Independent test**: no selection → current Asset; valid selection → "Run AI on N assets"; mixed → disabled with a reason.

- [ ] T051 [US6] Reuse `apps/web/src/components/workspace/ai-detect-dialog.tsx` (no new panel); add an "AI Detect" action to `apps/web/src/components/workspace/bulk-action-bar.tsx` that opens the same dialog with the bulk target; the dialog gains an optional target prop while keeping current `assetId` callers working.
- [ ] T052 [US6] Read Phase 022 state from `apps/web/src/stores/asset-selection-store.ts` (NONE/EXPLICIT/FILTERED, dataset-scoped); reject/reset a selection from another dataset explicitly; do not duplicate selection state.
- [ ] T053 [US6] Keep current behavior when no bulk target: `assetIds:[assetId]`, existing completion callbacks, no change to existing single-Asset tests.
- [ ] T054 [US6] Show verified count/modality/limit: add read-only `apps/web/src/app/api/ai/tasks/preview/route.ts` (uses `ai-target-service.ts`, no Job created, returns mode/count/modality/limit/reason and an opaque `previewFingerprint`), add preview client in `ai-task-api-client.ts`; on selection/model/dataset change disable Run until the latest response arrives and ignore out-of-order responses by request id.
- [ ] T055 [US6] Reuse model discovery (`listActiveAiModelsClient`), class selection and confidence/IoU controls; discover models by the **resolved bulk modality**, which may differ from the open Asset.
- [ ] T056 [US6] Disable/reject mixed-modality, empty, over-limit and unverified-capability targets with visible text; extend `createErrorMessage` with the new codes (**C1**); never fall back to the current Asset for an invalid active selection.
- [ ] T057 [US6] Submit one request: the same `createAiTaskClient` call for single and bulk, sending the target and `previewFingerprint`; `TARGET_CHANGED` (409) refreshes the preview and requires another click; Run label "Run AI on N assets".
- [ ] T058 [US6] Add tests in new `apps/web/tests/workspace/ai-batch-selection.vitest.spec.ts` and extend `apps/web/tests/ai/ai-task-api-client.test.ts`: NONE/EXPLICIT/FILTERED mapping, dataset mismatch, hidden selections, sort independence, stale preview, and that single and bulk share the identical execution function and request path.

## Phase 7 — US7: Failure, retry, recovery

**Goal**: interruptions never lose the accepted target or duplicate external work. **Independent test**: interrupt after acceptance, after reservation, after external-id persistence and after one Asset commit.

- [ ] T059 [US7] Preserve the Job state machine (no new status): all succeeded → `COMPLETED`/`SUCCEEDED`; any failed or skipped → `FAILED`/`FAILED`; cancellation → `CANCELED`. Document in `data-model.md` if any transition differs.
- [ ] T060 [US7] Represent per-Asset outcomes in existing structures: populate `Job.totalItems/processedItems/successItems/failedItems/skippedItems` (currently unused by AI), keep `canceledItems` in `Job.summary`, store the ordered outcome list in `Job.state`/`AiTask.output`; extend `apps/web/src/lib/ai/ai-task-read-service.ts` (`AiTaskStatusDto`) and `apps/web/src/app/api/ai/tasks/[aiTaskId]/route.ts` with bounded, allowlisted per-Asset outcomes; expose committed predictions of failed/canceled operations via `ai-prediction-results.ts`.
- [ ] T061 [US7] Verify create-task retry/idempotency using T007's recovery contract: known `externalTaskId` is reused; a crash between reservation and id persistence stays `AIOZ_SUBMISSION_AMBIGUOUS` and is never blindly resubmitted; add the AI case to `extractRetryContext` in `apps/web/src/lib/jobs/retry-job.ts` (allowlisted, re-validated target/configuration, `job.retry` + `annotation.create`, unique successor via `retryOfJobId`, paired successor `AiTask`, original task remains the owner of the unique `externalTaskId`); ambiguous/insufficient history returns a safe 409.
- [ ] T062 [US7] Verify worker-restart recovery: extend `apps/worker/src/queue/ai-poll-scanner.ts` and `ai-poll.processor.ts` so a successor with a null local `externalTaskId` still polls the owner's task; predecessor history is never mutated; inherited successes receive no new writes or revision bump.
- [ ] T063 [US7] Verify polling failure is durable: exhausted budget, HTTP/network/invalid response → safe terminal failure with every unresolved input finalized, never an empty success.
- [ ] T064 [US7] Verify a per-Asset write failure leaves earlier successful Assets intact and reported (rollback of that Asset only).
- [ ] T065 [US7] Preserve cancellation: reuse `cancelAuthorizedJob` (`apps/web/src/lib/jobs/authorization.ts`); local cancel checked before/after the provider call; committed Assets stay counted, remaining targets `CANCELED`; call remote cancel only if T007 proves an endpoint exists.
- [ ] T066 [US7] Add tests in new `apps/web/tests/ai/ai-batch-retry.test.ts` and new `apps/worker/tests/jobs/ai-batch-recovery.test.ts`, extending `apps/worker/tests/jobs/ai-poll-cancellation.test.ts`: authorization/concealment, one successor under concurrent retries, no duplicate external POST, restart recovery, partial failure visibility, cancel-vs-write race, replayed predecessor/successor delivery.

## Phase 8: Contracts and regression

- [ ] T067 Update `specs/api/openapi.yaml` and `contracts/ai-batch-*.md` for `target`, preview route, per-Asset outcomes, new error codes and the final **I3** status mapping; document the published limit.
- [ ] T068 Run `pnpm run docs:validate-openapi` and `pnpm run docs:bundle-openapi`; record in new `verification/openapi.md`.
- [ ] T069 [P] Run `pnpm run typecheck` (web, worker, domain, queue, realtime); record in new `verification/regression.md`.
- [ ] T070 [P] Run `pnpm run lint`; record results.
- [ ] T071 Run the existing AI suites (`apps/web/tests/ai/*`, `apps/worker/tests/jobs/aioz-*`, `ai-prediction-writer`, `providers/ai/*`); record counts and skips.
- [ ] T072 Run Phase 022 regressions (`apps/web/tests/assets-bulk/*`, `WORKSPACE_INTEGRATION_TESTS=1`; known pre-existing failure `change-status.test.ts` is recorded separately, not fixed here).
- [ ] T073 Run Phase 023 regressions (`apps/web/tests/workflow/*`).
- [ ] T074 Run workspace regressions (`npm --prefix apps/web run test:workspace`).
- [ ] T075 Run worker queue/recovery regressions (`apps/worker` queue tests, `apps/web` `test:job-queue`; record the gated skips honestly).
- [ ] T076 Run `pnpm run build`.

## Phase 9: Real runtime proof (needs G1 closed and a configured AI Service)

- [ ] T077 Start or rebuild PostgreSQL, Redis, MinIO, web, worker via `docker compose` without altering `.env`; record service health in new `verification/real-pipeline.md`.
- [ ] T078 Run one current-Asset AI task end to end; prove no regression.
- [ ] T079 Select several same-modality Assets across pages (explicit, then filtered) for the sizes 2, 7 and the verified maximum.
- [ ] T080 Prove exactly one platform Job (DB assertion).
- [ ] T081 Prove the BullMQ job data is exactly `{jobId}` (Redis inspection, sanitized).
- [ ] T082 Prove one AI Service external task with N file inputs (sanitized request capture; no signed URLs in the record).
- [ ] T083 Prove every result maps to the intended Asset, using same-filename Assets with distinguishable content.
- [ ] T084 Prove canonical predictions persist after browser refresh.
- [ ] T085 Prove each affected Asset's revision follows the existing semantics.
- [ ] T086 Prove a mixed-modality selection creates no Job and no external task.
- [ ] T087 Prove a delayed result cannot mutate an Asset that became review-frozen while the rest of the batch succeeds.

## Phase 10: Closure

- [ ] T088 Reconcile this checklist against code and evidence only; check items solely per the checking rule; verify the `data-model.md` glossary (A2) is used consistently across spec, contracts, identifiers and UI copy; write new `verification/completion.md` mapping every FR/SC to evidence.
- [ ] T089 Record pre-existing failures and skips separately from regressions (e.g. `assets-bulk/change-status.test.ts`, gated suites) in `verification/regression.md`.
- [ ] T090 Record the AI Service correlation semantics that were actually verified (T006/T007), including versions, dates and sample sizes.
- [ ] T091 Record remaining limitations and the safe batch-size constraint (effective limit, verified vs assumed).
- [ ] T092 Confirm and document that single-Asset and bulk AI use one execution path (`ai-target-service.ts` → `createAiTask` → one Job/AiTask → one submit/poll/write pipeline), with test evidence from T058 and T078–T082.

## Additional tasks (spec requirements missing from the requested list)

- [ ] T093 [P] Run the SC-010 acceptance-latency experiment: 100 valid submissions, concurrency 5, rotating sizes 1/2/7/max, isolated fixtures; record hardware, versions, cold vs warm model/class discovery and dependency conditions in new `verification/performance.md`; verify p95 ≤ 5 s (durable acceptance only, not inference).
- [ ] T094 [P] SC-009 usability check with **five real annotators** (target: four of five configure and submit a valid seven-Asset batch within two minutes and identify count and failed Assets unaided); record in new `verification/browser-usability.md`. **A1**: if participants are unavailable record SC-009 NOT MET/PENDING with the reason — never simulate participants, substitute developers or count fewer than five — and carry that status into T088.
- [ ] T095 [P] Security audit (FR-016/017/029/030): inspect browser DTOs, logs, queue payloads, Job/AiTask metadata and errors for signed URLs, credentials, storage keys and provider ids; exercise client-supplied file locations and forged counts; record in new `verification/security.md`.

## Dependencies and execution order

```text
T001–T005 [done] ; T006 || T007 → T008 (re-open if evidence changes rows)
                 │  GATE: G1 closed + E3 + E1 hold released
                 ▼
US1 (T009–T018) → US2 (T019–T025) → US3 (T026–T033) → US4 (T034–T040)
                 → US5 (T041–T050) → US6 (T051–T058) → US7 (T059–T066)
                 → T067–T076 → T077–T087 → T088–T092 ; T093–T095 in parallel with T077 onward
```

Each story is independently testable but they share files (`ai-task-service.ts`, the worker processors/writers, `ai-detect-dialog.tsx`); do not parallelize edits to the same file across stories. Test tasks (T018, T025, T040, T048–T050, T058, T066) are written first and must fail for the intended missing behavior before implementation.

## Parallel opportunities

- T006 ‖ T007 (different evidence documents, different people).
- After the gate: T010 ‖ T022 (different files); T018/T025/T040/T058/T066 test authoring can overlap across stories when they touch different test files.
- T069 ‖ T070; T093 ‖ T094 ‖ T095.

## Implementation strategy

1. **MVP = US1 + US2 + US3 (IMAGE only)**: one strict target path, one Job/AiTask, one POST — demonstrable on isolated fixtures only after the gate. It is an internal milestone, not a release: US4 (safe attribution), US5 (safe writes) and US7 (recovery) are all required before release.
2. Keep VIDEO disabled with a visible reason unless T006 verifies batch support.
3. Re-run the current-Asset regression (T053/T078) after every change to a shared file.
4. Stop at the governance boundary and report each phase with AGENTS.md's seven fields; no deployment or later-phase work is implied.

## Format validation

All 95 tasks use `- [ ]`/`- [X]`, a sequential ID, `[P]` only where independent, `[US#]` only inside story phases, and a file path or verification-document path. Audit, regression, runtime and closure phases carry no story label by design.
