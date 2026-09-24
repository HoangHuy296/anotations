# Tasks: Single-Asset and Bulk-Selection AI Preannotation

**Feature**: 026-single-bulkselection-asset  
**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)  
**Status**: Conditional task breakdown requested by the user; provider evidence gates E1–E3 remain OPEN. Creating this file does not pass those gates or authorize implementation. Only Phase 1 evidence/design work is currently actionable. T006 is the mandatory stop gate before all code tasks.  
**Gate register (from `/speckit-analyze` 2026-09-24, adopted by the user; severities are not equal)**:

| Finding | Must be closed before | State |
| --- | --- | --- |
| G1 provider evidence E1–E3 (T002–T005) | T006 — never crossed on mocks, adapter tests or historical notes | **OPEN** — needs real deployed-service/network evidence |
| I1 plan-vs-tasks contradiction | T006 | Reconciled in `plan.md` (this pass): tasks.md is conditional; T006 is the sole stop gate |
| I2 frozen-asset outcome vs FR-026/FR-031 | T006 | Decision recorded: `research.md` D-I2, `spec.md` Clarifications; test-update work in T032/T035 |
| U1 source-identity eligibility | T006 | Decision recorded: `research.md` D-U1, `data-model.md`; verification in T016 |
| E1 uncommitted Phase 025 in the shared working tree | any production-code task (T007+) | **HOLD** — user commits/stashes/isolates 025; the assistant performs no git history operations and only records the hold in T001 |
| C1 `ApiErrorCode` closed union; I3 HTTP status mapping | while implementing T018 (and T051 docs) | Requirements written into T018/T051 |
| C2 domain test runner | while implementing T007/T008 | Requirement written into T007/T008 |
| A1 five-annotator usability (SC-009); A2 terminology | before closure (T055/T057) | A2 glossary added to `data-model.md`; A1 rule in T055 (no fabricated participants) |

**Scope**: Existing Next.js/Prisma/common Job/private worker pipeline; no new public backend, Job lifecycle, npm package, schema migration or modality engine. Preserve existing uncommitted work. No branch creation/switch is required.

Tests are included because FR-031 and SC-001–010 explicitly require regression, race, real-dependency and acceptance verification. New tests must fail for the intended missing behavior before implementation; existing regression tests establish the baseline. `[P]` means independent files within the stated phase after its prerequisite gate, not permission to bypass phase dependencies. All paths are repository-relative; new files are explicitly identified.

## Phase 1: Setup — Evidence and Design Gate

**Goal**: Resolve the draft's external evidence blockers without pretending test doubles prove service guarantees. No application implementation in this phase.

- [ ] T001 Record prior-phase readiness, existing worktree constraints, baseline test commands and isolated test prerequisites in new `specs/026-single-bulkselection-asset/verification/readiness.md`; use `quickstart.md` and do not declare earlier phases complete from file presence alone. The Phase 0 primitive audit is recorded in `verification/audit.md` (link it from readiness.md). **Record analysis finding E1**: Phase 025 work is uncommitted in this working tree (`git status` count and the shared files 026 will touch — `ai-detect-dialog.tsx`, the prediction writers, `asset-bulk-service.ts`, `specs/api/openapi.yaml`). Production-code tasks (T007 onward) stay on HOLD until the user confirms 025 is committed, stashed or otherwise isolated; the assistant must not run commit/stash/branch/reset operations to satisfy this.
- [ ] T002 [P] Obtain version-identifiable deployed create/status/result contracts and verified per-model/modality input, payload and response limits; record redacted evidence, scalar-versus-array model_id resolution and supported IMAGE/VIDEO matrix in new `specs/026-single-bulkselection-asset/verification/provider-contract.md` (E1); leave unsupported capabilities disabled and record unavailable evidence as blocked.
- [ ] T003 [P] Establish authoritative input/result identity, ordering independence, completeness, explicit zero-result and duplicate-source guarantees; record same-filename/reordered/missing/duplicate/unknown group evidence and whether independent groups can safely proceed in new `specs/026-single-bulkselection-asset/verification/correlation.md` (E2); do not infer guarantees from adapter tests.
- [ ] T004 [P] Verify object-scoped MinIO downloads from the actual AI-service network and document download timing, TTL, expiry and unreachable-source behavior in new `specs/026-single-bulkselection-asset/verification/source-access.md` (E3); use existing operator-approved topology, never persist signed links/credentials or alter env files.
- [ ] T005 Document supported submission reconciliation/idempotency/cancellation semantics and the fail-closed ambiguous-submission policy in new `specs/026-single-bulkselection-asset/verification/recovery-contract.md`; confirm known external IDs can be reused and distinguish definite no-submit failures from unknown acceptance without inventing provider endpoints.
- [ ] T006 Consolidate T001–T005 into `specs/026-single-bulkselection-asset/research.md`, `plan.md`, `data-model.md`, `contracts/ai-batch-api.md`, `contracts/ai-batch-worker.md`, `contracts/ai-batch-ui.md` and `quickstart.md`; publish the verified effective limit (at most 200), finalize per-Asset isolation and retry-owner design, document the missing agent-context updater disposition, and re-evaluate architecture gates. **T006 may be marked done only when** T002–T005 hold actual deployed-service/topology evidence (G1) and the I1/I2/U1 decisions in `research.md` are still consistent with that evidence. STOP if E1–E3 or design decisions remain unresolved; update `spec.md` only if verified evidence requires an explicit documented scope/limit change.

**Checkpoint**: Evidence is attached and draft decisions finalized, or remaining tasks stay blocked. The missing updater is a tooling limitation, not a reason to fabricate governance updates. Report the phase using AGENTS.md's seven fields before progressing.

## Phase 2: Foundational — Shared Input, Identity and Checkpoints

**Prerequisite**: T006 passed and applicable phase authorization. **Goal**: Establish contracts reused by every story without adding another execution pipeline.

- [ ] T007 Define versioned accepted targets/configuration, source identity digests, per-Asset result envelopes, checkpoint generation, safe reason codes, aggregate counts and allowlisted recovery references in new `packages/domain/src/ai-batch.ts`; export through `packages/domain/package.json`, preserving existing Job/AiTask enum values and unique externalTaskId ownership. **C2**: `packages/domain/package.json` has no `test` script today although `packages/domain/tests/*.test.ts` exist (025); add one matching the existing `node --import tsx --test` convention in this task (no new package) so T008 and T056 have a runnable command.
- [ ] T008 [P] Add domain validation/reconciliation tests in new `packages/domain/tests/ai-batch.test.ts` for bounded unique ordered targets, finite thresholds, explicit zero versus missing results, terminal count reconciliation, and secret-free projections using T007 schemas.
- [ ] T009 [P] Export Phase 022 selection schema from `apps/web/src/lib/validation/asset-bulk.ts` and extend `apps/web/src/lib/validation/ai-task.ts` with mutually exclusive current/bulk target and legacy assetIds branches, preview validation and safe errors; retain existing filter semantics and reject arbitrary source locations/full Asset records.
- [ ] T010 [P] Extend `packages/domain/src/ai-provider.ts` with explicit per-input completion groups and historical compatibility so an empty prediction list cannot imply missing inputs succeeded; retain submit/status adapter ownership and do not introduce another provider interface.
- [ ] T011 Add a bounded, transaction-aware strict mode to `apps/web/src/lib/assets/asset-bulk-service.ts`, reusing `apps/web/src/lib/workspace/workspace-assets.ts`: deduplicate before execution limits, reject missing/archived explicit members, order by id, and read filtered limit+1 in one query instead of count/read truncation; preserve existing bulk-operation callers.
- [ ] T012 Create shared worker checkpoint/finalization helpers in new `apps/worker/src/jobs/ai-batch-state.ts` using Prisma Job lease/status/cancel predicates and checkpoint generation in the same transaction; reconcile all accepted targets and existing Job/AiTask statuses without raw SQL or a new table.
- [ ] T013 Validate shared schemas, legacy compatibility and unchanged Phase 022 bulk behavior using `packages/domain/tests/ai-batch.test.ts` and `apps/web/tests/assets-bulk/selection-resolution.test.ts`; record commands/results including skips in new `specs/026-single-bulkselection-asset/verification/foundation.md`.

**Checkpoint**: Shared contracts compile, bounded resolution is authoritative, and state helpers expose the transaction boundary needed by persistence/recovery. No UI rollout yet.

## Phase 3: User Story 1 — Run AI on the Current Asset (P1)

**Goal**: Preserve current-Asset AI through the unified target/acceptance path and existing configuration controls.
**Independent test**: On an isolated editable IMAGE Asset, submit with no bulk selection, observe one durable operation and persisted outputs only on that Asset, reload, and compare equivalent legacy/current/one-member explicit inputs. Reject unsupported/inactive/incompatible cases before execution.

### Tests

- [ ] T014 [P] [US1] Extend `apps/web/tests/ai/ai-tasks-route.test.ts` for current/legacy/one-member target parity, ambiguous request rejection, initial eligibility, model/classes/thresholds, current access/concealment, versioned Job input and no Job on pre-acceptance rejection.
- [ ] T015 [P] [US1] Extend `apps/web/tests/ai/ai-preannotate-happy-path.test.ts` for atomic Job/AiTask acceptance, post-commit queue failure retaining references, immutable one-Asset snapshot, refresh and baseline canonical persistence; verify BullMQ payload contains only jobId.

### Implementation

- [ ] T016 [US1] Create `apps/web/src/lib/ai/ai-target-service.ts` to normalize all request variants into the shared strict resolver, validate Dataset annotation permission, editable source/modality/model capability and effective limit, and build ordered source identities plus advisory preview fingerprints; use canonical storage metadata only. **U1 decision (research.md D-U1)**: identity is a digest of `Asset.sourceFingerprint` (non-null), `currentVersionId`, `sourceRevision`, `sizeBytes`, `checksum`/`cacheChecksum` when present and the selected object locator, following the existing `ensure-media-processing-job.ts` precedent; require sourceFingerprint, sizeBytes and a storage locator (not a checksum), so no asset class becomes ineligible beyond what media processing already requires. Add a test proving how `sourceFingerprint` changes (or fails to change) when an UPLOAD-mode object is replaced (`upload-verification.ts`); if it does not change, include the checksum/locator in the digest and reject an asset whose bytes cannot be distinguished.
- [ ] T017 [US1] Refactor `apps/web/src/lib/ai/ai-task-service.ts` to use T016, perform remote catalog/class reads outside the transaction, recheck local authority/capability and snapshot inside a bounded-retry Prisma transaction, persist Job.input plus consistent AiTask projection, and retain durable references on enqueue interruption without duplicating accepted work.
- [ ] T018 [US1] Wire strict validation and safe success/error DTOs through `apps/web/src/app/api/ai/tasks/route.ts`, `apps/web/src/lib/ai/ai-task-api-client.ts` and new `apps/web/src/types/ai-batch.ts`; retain existing taskId/jobId compatibility for old callers. **C1**: add every new error code (`TARGET_EMPTY`, `TARGET_TOO_LARGE`, `TARGET_MIXED_MODALITY`, `TARGET_INELIGIBLE`, `TARGET_CHANGED`, `AI_CAPABILITY_UNVERIFIED`) to the closed `ApiErrorCode` union in `apps/web/src/lib/api-response.ts` and to `createErrorMessage` in `ai-detect-dialog.tsx`. **I3**: finalize HTTP statuses against existing conventions before coding — over-limit 422 (mirrors `SELECTION_TOO_LARGE`), whole-batch membership failure 409 `ASSET_NOT_IN_DATASET` (existing AI route), malformed/empty 400, mixed modality or ineligible 422 (mirrors `MEDIA_ASSET_INELIGIBLE`), `TARGET_CHANGED`/`AI_CAPABILITY_UNVERIFIED` 409 — then update `contracts/ai-batch-api.md` and T051 to match.
- [ ] T019 [US1] Update `apps/worker/src/jobs/ai-submit.processor.ts` to read versioned Job authority, reject mismatched projections, recheck every accepted source/access/workflow/model before dispatch, reject the whole dispatch when any input is invalid, and preserve a narrowly validated historical single-Asset path without weakening new schema checks.
- [ ] T020 [US1] Integrate current-target submission into `apps/web/src/components/workspace/ai-detect-dialog.tsx` with existing model/class/confidence/IoU controls, safe rejection reasons and durable operation links; preserve existing completion callbacks and never persist browser predictions as authority.
- [ ] T021 [US1] Run current-Asset regressions and refresh checks in `apps/web/tests/ai/ai-task-api-client.test.ts`, `apps/web/tests/ai/ai-preannotate-happy-path.test.ts` and existing worker pipeline suites; record evidence in new `specs/026-single-bulkselection-asset/verification/us1.md`.

**Checkpoint**: Current-Asset acceptance/configuration regression milestone. This is an internal integration MVP, not a release waiver for US4 safety or US3 recovery; re-run this test after later writer changes.

## Phase 4: User Story 2 — Run One AI Batch on Selected Assets (P1)

**Prerequisite**: US1 unified acceptance. **Goal**: Explicit/filtered cross-page selection uses the same panel and one provider batch.
**Independent test**: Select seven same-modality Assets across pages, including hidden explicit members, and confirm one Job plus one N-file external task. Repeat filtered membership over three pages. Empty/mixed/foreign/oversized selections never fall back or run a subset.

### Tests

- [ ] T022 [P] [US2] Add new `apps/web/tests/ai/ai-batch-targets.test.ts` for explicit deduplication/missing members, filtered multi-page limit+1 resolution, deterministic order, archive/access checks, same-count membership changes, stale fingerprints and acceptance snapshot isolation.
- [ ] T023 [P] [US2] Add new `apps/web/tests/workspace/ai-batch-selection.vitest.spec.ts` for NONE/EXPLICIT/FILTERED mapping, Dataset mismatch, hidden selections, sort independence, out-of-order previews, model-dependent limits and bulk modality differing from the open Asset.
- [ ] T024 [P] [US2] Extend `apps/worker/tests/jobs/aioz-provider-pipeline.test.ts` for N accepted targets yielding one reservation, one files[] POST and no fan-out; cover dispatch-time invalidity, conditional VIDEO capability and no unannounced smaller batch.

### Implementation

- [ ] T025 [US2] Implement read-only preview in new `apps/web/src/app/api/ai/tasks/preview/route.ts` using `apps/web/src/lib/ai/ai-target-service.ts`; return authorized mode/count/modality/limit/reason and opaque fingerprint without Job creation, target materialization in the browser or concealed-member details.
- [ ] T026 [US2] Enforce the new UI fingerprint at acceptance in `apps/web/src/lib/ai/ai-task-service.ts` and add preview client/types in `apps/web/src/lib/ai/ai-task-api-client.ts` and `apps/web/src/types/ai-batch.ts`; return TARGET_CHANGED before creating a Job, treating fingerprint equality only as freshness rather than permission.
- [ ] T027 [US2] Connect Phase 022 `apps/web/src/stores/asset-selection-store.ts` to `apps/web/src/components/workspace/ai-detect-dialog.tsx` and open that same panel from `apps/web/src/components/workspace/bulk-action-bar.tsx`; show verified count/mode/modality and “Run AI on N assets”, ignore stale responses, discover models by target modality, and require a new click after target changes.
- [ ] T028 [US2] Extend `apps/worker/src/providers/ai/aioz-task-resources.ts` to compare accepted source identities, create fresh verified-TTL object-scoped access, and reserve ordered unique digest/input mappings before HTTP; reject duplicate unresolved correlation and never persist signed URLs.
- [ ] T029 [US2] Adapt `apps/worker/src/providers/ai/aioz-annotation-services-provider.ts` to the T002 verified capability/request/limit matrix while retaining exactly one external create and recorded identity reuse; enforce verified payload/response budgets and safe failures without truncation or guessed model_id fields.
- [ ] T030 [US2] Run target/pipeline tests and browser cross-page/filtered/invalid-selection scenarios from `specs/026-single-bulkselection-asset/quickstart.md`; record counts, single POST proof and unsupported VIDEO behavior in new `specs/026-single-bulkselection-asset/verification/us2.md`.

**Checkpoint**: Selection and dispatch work on isolated fixtures. Full rollout waits for the following safety and recovery stories.

## Phase 5: User Story 4 — Correct Attribution and Workflow-Safe Predictions (P1)

**Ordering rationale**: All stories are P1; US4 precedes US3 because recovery depends on atomic outcomes. **Goal**: Every accepted Asset has an accurately attributed, atomic, workflow-safe result.
**Independent test**: Use distinguishable same-filename Assets with reordered/missing/duplicate/malformed groups, explicit zero output, concurrent review freeze/source/access changes and replay. Verify no wrong-Asset writes, no partial Asset commits, stale-review rejection and exact outcome reconciliation.

### Tests

- [ ] T031 [P] [US4] Extend `apps/worker/tests/providers/ai/aioz-annotation-services-normalization.test.ts` with verified correlation-envelope fixtures for reordered/same-filename/unknown/duplicate/missing/zero/malformed groups and fail-closed handling when independent attribution is unproven.
- [ ] T032 [P] [US4] Extend `apps/worker/tests/jobs/ai-prediction-writer.test.ts` for per-Asset rollback, unchanged manual/accepted annotations, unmapped-label accounting, zero-result no-op, concurrent Job lease/checkpoint writers, source/access changes and no duplicate revision on replay. **I2**: the existing test "late AI output preserves review-frozen Asset status, revision and workflow history" (`aioz-provider-pipeline.test.ts`) asserts only data safety (status, revision, zero annotations, zero workflow events) and must keep passing unchanged; add new assertions that the frozen Asset is reported `SKIPPED`/`WORKFLOW_FROZEN` and the aggregate Job/AiTask end FAILED (research.md D-I2), and list any other existing expectation that assumed SUCCEEDED for a skipped Asset as a deliberate, documented contract change — never silently edit an existing assertion.
- [ ] T033 [P] [US4] Extend `apps/web/tests/workflow/asset-revision-invalidation.test.ts` and `apps/web/tests/workflow/stale-review-race.test.ts` for delayed AI writes versus review freeze and stale reviewer decisions using real PostgreSQL transactions.

### Implementation

- [ ] T034 [US4] Preserve verified per-input envelopes in `apps/worker/src/providers/ai/aioz-annotation-services-provider.ts`, `apps/worker/src/providers/ai/aioz-annotation-services-normalization.ts` and `apps/worker/src/providers/ai/aioz-video-normalization.ts`; validate identity before writes, retain explicit empty groups, fail malformed Asset groups atomically and record missing groups without guessing.
- [ ] T035 [US4] Refactor `apps/worker/src/jobs/ai-prediction-writer.ts` around one Asset transaction using T012: fence lease/generation/cancellation, revalidate current permission and source, serialize with membership changes and guarded Asset workflow revision, prevalidate every prediction, append canonical AI/DRAFT annotations, and atomically persist the outcome with required content revision changes; do not replace existing work.
- [ ] T036 [US4] Apply the same transaction/checkpoint policy in `apps/worker/src/jobs/ai-video-prediction-writer.ts` for verified VIDEO support, preserving track/frame geometry, provenance and parent revisions; add replay/partial-failure coverage in `apps/worker/tests/jobs/aioz-video-pipeline.test.ts` without enabling unverified batch execution.
- [ ] T037 [US4] Integrate per-input write dispatch and terminal reconciliation in `apps/worker/src/jobs/ai-poll.processor.ts` and `apps/worker/src/jobs/ai-batch-state.ts`; preserve committed successes, finalize unresolved inputs on envelope/processing failure, report skipped policies explicitly, and map all-success to COMPLETED/SUCCEEDED versus any failure/skip to FAILED.
- [ ] T038 [US4] Extend `apps/web/src/lib/ai/ai-task-read-service.ts`, `apps/web/src/lib/ai/ai-prediction-results.ts` and `apps/web/src/app/api/ai/tasks/[aiTaskId]/predictions/route.ts` to project authorized per-Asset outcomes and committed predictions for failed/canceled aggregate tasks as well as success; gate any prediction-save action on that Asset's verified result, retain version checks and conceal revoked access.
- [ ] T039 [US4] Update `apps/web/src/components/workspace/ai-detect-dialog.tsx` to render reconciled success/failure/skip/cancel counts and individual outcomes, refresh only the affected open Asset from canonical reads even on aggregate failure, and never merge other Assets' outputs into its canvas/store.
- [ ] T040 [US4] Run correlation, writer, workflow race and partial-result read regressions, including `apps/web/tests/ai/ai-prediction-results.test.ts` and `apps/web/tests/ai/video-ai-results.test.ts`; record immutable manual work, zero/missing distinctions and count reconciliation in new `specs/026-single-bulkselection-asset/verification/us4.md`.

**Checkpoint**: Every final outcome is durable, source-correct and workflow-safe. No terminal operation has unaccounted pending targets; each successful replay is a no-op.

## Phase 6: User Story 3 — Recover and Inspect One Durable Batch (P1)

**Prerequisite**: US4 outcome/checkpoint integration. **Goal**: Submission, polling, refresh, authorized retry and cancellation retain original authority and completed outputs.
**Independent test**: Interrupt after acceptance, after reservation, after external ID persistence and after one Asset commit; repeat retry/cancel concurrently. Verify durable progress, one successor, known-task reuse, no blind POST after ambiguity, no duplicate writes, and visible earlier successes.

### Tests

- [ ] T041 [P] [US3] Add new `apps/web/tests/ai/ai-batch-retry.test.ts` for authorization, concealed predecessors, one unique successor under concurrent requests, immutable failed history, strict retry allowlists, original external-task ownership and denied ambiguous/historical recovery.
- [ ] T042 [P] [US3] Add new `apps/worker/tests/jobs/ai-batch-recovery.test.ts` for enqueue/poll recovery, crashed submission reservation, original-owner lookup, successor scanning with null local externalTaskId, replayed predecessor/successor delivery and inherited successes without revision changes.
- [ ] T043 [P] [US3] Extend `apps/worker/tests/jobs/ai-poll-cancellation.test.ts` for cancel-before-submit, cancel-during-HTTP and cancel-versus-Asset-transaction races, ensuring already committed results remain counted and subsequent commits are fenced.

### Implementation

- [ ] T044 [US3] Extend `apps/web/src/lib/jobs/retry-job.ts` with the reviewed AI allowlist, current job.retry and annotation.create checks, unique successor creation/reuse, versioned accepted target/configuration copy and server-derived successful checkpoint/original-task-owner references; preserve unique AiTask.externalTaskId on its original owner and deny ambiguous resubmission.
- [ ] T045 [US3] Teach `apps/worker/src/jobs/ai-submit.processor.ts` and `apps/worker/src/providers/ai/aioz-task-resources.ts` to resolve validated original-task ownership, inherit successful outcomes, reuse known external tasks and manifests, and submit only definite no-submit failures; never mutate terminal predecessor history or clear an uncertain reservation.
- [ ] T046 [US3] Extend `apps/worker/src/queue/ai-poll-scanner.ts` and `apps/worker/src/jobs/ai-poll.processor.ts` for successor-local scheduling/leases with owner-held external identity, idempotent checkpoint recovery and safe terminal failures after exhausted polling; no new queue or polling architecture.
- [ ] T047 [US3] Integrate cancellation finalization with `apps/web/src/lib/jobs/authorization.ts`, `apps/web/src/lib/ai/ai-task-service.ts` and `apps/worker/src/jobs/ai-batch-state.ts`; keep existing cancel authority, preserve finalized entries, mark remaining targets canceled and call remote cancellation only if T005 proves support.
- [ ] T048 [US3] Extend `apps/web/src/lib/ai/ai-task-read-service.ts` and `apps/web/src/app/api/ai/tasks/[aiTaskId]/route.ts` with common Job status, safe recovery availability/lineage and current authorization; project the same bounded summary through existing Job reads without exposing raw state, external identifiers or storage references.
- [ ] T049 [US3] Add server-backed operation reopening to `apps/web/src/components/workspace/ai-detect-dialog.tsx` using existing authorized Job views and `apps/web/src/lib/ai/ai-task-api-client.ts`; allow choosing a durable task reference after refresh, retain multiple-operation identity, and display retry/cancel results and successes under failed/canceled status without localStorage authority.
- [ ] T050 [US3] Execute recovery/cancellation tests plus task status and cancel route regressions in `apps/web/tests/ai/ai-task-status-route.test.ts` and `apps/web/tests/ai/ai-task-cancel-route.test.ts`; document actual injected interruptions, no duplicate external POST and immutable predecessor outputs in new `specs/026-single-bulkselection-asset/verification/us3.md`.

**Checkpoint**: All four stories now satisfy their independent acceptance criteria, including re-running US1 after writer/recovery changes.

## Phase 7: Polish and Cross-Cutting Release Verification

**Prerequisite**: All four stories. No phase is complete based solely on mocks or passing health checks.

- [ ] T051 [P] Update `specs/api/openapi.yaml` and feature contracts in `specs/026-single-bulkselection-asset/contracts/ai-batch-api.md`, `ai-batch-worker.md` and `ai-batch-ui.md` to match implemented preview/create/read/retry behavior, legacy compatibility, safe errors and published limits; run existing OpenAPI validation/bundling commands and record results in new `specs/026-single-bulkselection-asset/verification/contracts.md`.
- [ ] T052 [P] Audit browser DTOs, logs, queue payloads, Job/AiTask metadata, signed-link handling and revoked-access reads; exercise adversarial file-location/client-count inputs and record findings/remediation evidence in new `specs/026-single-bulkselection-asset/verification/security.md` using the boundaries in `AGENTS.md`.
- [ ] T053 [P] Run approved real PostgreSQL/Redis/MinIO/private-worker/provider acceptance at sizes 1, 2, 7 and verified maximum; capture sanitized one-create/N-file proof, same-filename reordered attribution, explicit zero and workflow-safe partial outcomes in new `specs/026-single-bulkselection-asset/verification/real-pipeline.md`; absent infrastructure or provider evidence is a failed release gate, never a skipped success.
- [ ] T054 [P] Run the documented 100-request/concurrency-five acceptance-latency experiment against isolated fixtures, record cold/warm discovery and dependency conditions and verify p95 at most five seconds in new `specs/026-single-bulkselection-asset/verification/performance.md`; do not confuse inference time with durable acceptance latency.
- [ ] T055 [P] Verify keyboard/focus behavior, latest-preview handling, count/modality/limit wording, cross-page selection, refresh, partial results and cancellation; conduct the five-annotator SC-009 usability check and record observed timing/failed-Asset identification in new `specs/026-single-bulkselection-asset/verification/browser-usability.md`. **A1**: this requires five real annotators; if participants are unavailable, record SC-009 as NOT MET/PENDING with the reason — never simulate participants, use the developers as stand-ins, or count fewer than five toward the "four of five" threshold — and carry that status into T057 and the release report.
- [ ] T056 Run the final typecheck/lint/domain/AI/selection/workflow/worker suites listed in `specs/026-single-bulkselection-asset/quickstart.md`, including the new domain test runner command, and record commands, failures and skips in new `specs/026-single-bulkselection-asset/verification/regression.md`; re-run US1 regression after all integrations and do not add packages to bypass missing infrastructure.
- [ ] T057 Reconcile every FR/SC against evidence in new `specs/026-single-bulkselection-asset/verification/completion.md`, update `specs/026-single-bulkselection-asset/quickstart.md` with actual runnable commands and outcomes, verify the `data-model.md` glossary (A2) is used consistently across spec, contracts, code identifiers and UI copy, and report files created/modified, commands, environment variable names, migration status, limitations and next phase; stop without deploying or implementing future phases implicitly.

## Dependencies and Execution Order

```text
T001 + (T002 || T003 || T004) + T005
                  |
                T006 evidence/design gate
                  |
T007 -> (T008 || T009 || T010) -> T011 -> T012 -> T013
                  |
US1: (T014 || T015) -> T016 -> T017 -> T018 -> T019 -> T020 -> T021
                  |
US2: (T022 || T023 || T024) -> T025 -> T026 -> T027 -> T028 -> T029 -> T030
                  |
US4: (T031 || T032 || T033) -> T034 -> T035 -> T036 -> T037 -> T038 -> T039 -> T040
                  |
US3: (T041 || T042 || T043) -> T044 -> T045 -> T046 -> T047 -> T048 -> T049 -> T050
                  |
(T051 || T052 || T053 || T054 || T055) -> T056 -> T057
```

All stories are P1; ordering reflects shared implementation dependencies, not a priority downgrade. No circular story dependencies: US1/US2 are acceptance/dispatch integration milestones; US4 establishes safe outcomes before US3 adds recovery. Their earlier successful-run acceptance checks remain independently repeatable, but release requires all four stories. Test authoring precedes implementation and final passing checks occur at each story checkpoint.

Within each phase, unmarked tasks run sequentially. `[P]` test tasks may be authored concurrently because they use separate files. Do not parallelize modifications of ai-detect-dialog, task service, provider, writers or poll processor across story phases. T053 and T054 are parallelizable only with separate isolated fixtures/dependency capacity; otherwise run sequentially to keep performance evidence reproducible. No parallel marker authorizes shared test database mutations that would interfere.

## Parallel Execution Examples by Story

- **US1:** After T013, author route contract coverage T014 alongside durable acceptance integration coverage T015; then execute T016–T021 in order.
- **US2:** After T021, author server selection tests T022, client selection tests T023 and one-POST pipeline tests T024 together; all three use distinct files. Implement the shared preview/service/UI changes sequentially.
- **US4:** After T030, author provider envelope tests T031, writer atomicity tests T032 and workflow race tests T033 together; coordinate fixtures before executing database suites.
- **US3:** After T040, author retry authorization tests T041, worker recovery tests T042 and cancellation tests T043 together; implement owner/scanner/cancel changes sequentially before the integrated fault tests.

These examples describe scheduling opportunities, not an instruction to spawn agents during task generation.

## Requirements Coverage

| Requirements | Primary tasks |
| --- | --- |
| FR-001–006 target intent, authority, UI and immutable snapshot | T009, T011, T014–018, T020, T022–023, T025–027 |
| FR-007–009 initial eligibility, modality and limits | T002, T006–007, T011, T014, T016–017, T019, T022, T024, T029 |
| FR-010–012 one operation, durable authority and delivery | T015, T017–019, T024, T028–029, T042, T045–046 |
| FR-013–017 provider evidence, identity and private access | T002–006, T010, T028–029, T031, T034, T052–053 |
| FR-018 dispatch revalidation | T019, T024, T028, T045 |
| FR-019–023 canonical atomic writes and workflow | T031–036, T040 |
| FR-024–026 reconciled outcomes and lifecycle | T007–008, T012, T037–040, T047–049 |
| FR-027 recovery and lineage | T005, T041–042, T044–046, T048–050 |
| FR-028 cancellation | T012, T043, T047, T050 |
| FR-029–030 authorization, concealment and secret boundaries | T014, T016, T019, T028, T032, T035, T038, T041, T048, T052 |
| FR-031 real regression/release evidence | T021, T030, T040, T050, T053, T056–057 |
| SC-001 current Asset equivalence | T014–015, T021, T056 |
| SC-002–004 batch cardinality, selection and rejection | T022–024, T030, T053 |
| SC-005–008 attribution, complete outcomes, workflow and replay | T031–043, T045–050, T053 |
| SC-009 usability | T055 |
| SC-010 acceptance latency | T054 |

## Implementation Strategy and MVP

1. Begin with evidence tasks T001–T005; close T006 or stop with precise missing evidence. Task generation itself does not resolve the plan's blocked status.
2. Complete foundation and US1 for the smallest internal regression milestone. Demo only on isolated fixtures after its tests pass; do not advertise feature 026 as released.
3. Add US2 selection/dispatch, then US4 persistence safety, then US3 recovery. Re-run earlier story checks after every shared-file change. The smallest releasable 026 scope includes all four P1 stories; IMAGE-only is acceptable when VIDEO evidence is absent and UI clearly disables it.
4. Complete cross-cutting real-service, security, browser/usability and performance evidence. Report each phase and stop at the governance boundary; no production rollout is implied.

## Generation Record

Used `.specify/scripts/bash/setup-tasks.sh --json` because no PowerShell counterpart is present. Resolved the repository tasks template and all feature design documents. Constitution remains an unratified placeholder; AGENTS.md and Phase 0 authorities govern. No extension configuration exists, so before_tasks/after_tasks hooks are skipped. This generation creates only tasks.md and performs no tests, application edits, environment changes, migrations or external provider requests.
