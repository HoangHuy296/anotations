# Implementation Plan: Single-Asset and Bulk-Selection AI Preannotation

**Feature**: `026-single-bulkselection-asset` | **Date**: 2026-09-24 | **Spec**: [spec.md](spec.md)
**Git branch**: `025-text-workspace-engine` (unchanged). Setup's BRANCH is the configured feature identifier, not a new Git branch.
**Input**: `specs/026-single-bulkselection-asset/spec.md` and [planning constraints](planning-constraints.md).
**Status**: Draft prepared; **ERROR: research/provider evidence gate not passed**. Implementation is not authorized by this document; v1 (IMAGE detection) is blocked only by HG-1 (contractual correlation); HG-2 (Phase 025 isolation) is released. `tasks.md` exists as a conditional breakdown: T006 is the sole stop gate, and no task from T007 onward may run while E1–E3 are open or while the Phase 025 working tree is unisolated (see the gate register at the top of tasks.md). Design artifacts are provisional review material until E1–E3 in [research.md](research.md) close. Phase 1 design cannot be signed off before that closure.

## Summary

Extend the existing AI Detection panel and durable Job/AiTask pipeline to resolve the current Asset or a Phase 022 explicit/filtered selection into one immutable ordered target. Authorize and validate the entire selection before acceptance, submit one external files array, and persist independently verified results through the existing canonical writers with atomic per-Asset outcomes. Keep common Job lifecycle values, private storage, queue payload `{ jobId }`, safe successor retries, and workflow revision checks.

## Technical Context

**Language/Version**: TypeScript 5, React 19.2.4, Next.js 16.2.9 App Router; existing Node/tsx runtime.
**Primary Dependencies**: Prisma 6.19.3, Zod 4.4.3, Zustand 5, BullMQ 5, ioredis 5, MinIO 8; reuse installed dependencies, no new packages.
**Storage**: PostgreSQL Job input/state/summary, existing AiTask and canonical Annotation/VideoObjectTrack records; private MinIO source binaries; Redis transport only.
**Testing**: Existing node:test/tsx database integration suites; Vitest for selection/client logic; real dependency and browser acceptance checks. Mocks prove code behavior, not provider guarantees.
**Target Platform**: Existing browser workspace, Next.js server, private worker and PostgreSQL/Redis/MinIO deployment.
**Project Type**: Single-repository web application with private asynchronous worker.
**Performance Goals**: p95 acceptance within five seconds at documented load; no inference wait in the request. Test 100 valid submissions with concurrency five, rotating sizes 1/2/7/effective maximum, prepared fixtures and healthy dependencies; report actual hardware, versions, model/class-cache condition and external latency. Separate cold catalog discovery from submission measurements and report both.
**Constraints**: Effective limit = min(platform selection ceiling 200, provider-verified `AI_BATCH_VERIFIED_MAX_ASSETS`, initially 3); v1 is IMAGE detection only; bounded JSON metadata; no raw SQL or new Job states; preserve manual/accepted work and current revision semantics. Provider limit, download window and deployed identity guarantees are unresolved evidence gates E1–E3.
**Scale/Scope**: One Dataset and one modality per accepted operation, one external task; current/explicit/filtered targets; IMAGE detection baseline, VIDEO tracking only after verified batch support. AUDIO/TEXT inference, mixed partitioning, global Job Center redesign and new realtime behavior excluded.

## Constitution Check

The constitution file is an unfilled template, not adopted policy. Binding gates derive from AGENTS.md and the five Phase 0 authority documents.

| Gate | Before research | Post-design review |
| --- | --- | --- |
| Next.js public boundary/private worker | PASS | PASS: existing routes and processors only |
| Common PostgreSQL Job authority / Prisma only | PASS | PASS: versioned Job input and bounded outcome checkpoints; no extra Job table |
| Redis transports only jobId | PASS | PASS: target/manifest stays in PostgreSQL |
| Private binaries and credentials | PASS | PASS by design: transient signed links, safe projections; E3 runtime proof outstanding |
| Canonical geometry/revisions/workflow | PASS | PASS by design: guarded per-Asset writer transaction and replay checkpoint |
| Retry lineage/idempotency/cancel | PASS as constraint | PASS by design; implementation race tests required, current AI retry gap explicitly addressed |
| No unapproved packages/migrations/phase skipping | PASS | PASS: planning documents only; earlier-phase completion not inferred |
| Verified provider contract and real execution (FR-013/031) | OPEN | **PARTIAL.** Hard gates for v1 (IMAGE detection): **HG-1** deterministic/contractual correlation (OPEN) and **HG-2** Phase 025 isolation (RELEASED — committed as d95a5c5). Other E1–E3 items are closure evidence; safety invariants DI-1…DI-6 are decided in research.md and enforced by tests. |

No architecture exceptions are proposed. `tasks.md` was generated at the user's request but is conditional; do not execute past T006 or claim the research/design gate passed while E1–E3 remain open.

## Project Structure

### Documentation

```text
specs/026-single-bulkselection-asset/
├── spec.md                     # unchanged product requirements
├── planning-constraints.md     # unchanged evidence requirements
├── plan.md
├── research.md
├── data-model.md               # provisional design
├── quickstart.md               # validation guide, not execution evidence
├── verification/audit.md       # Phase 0 primitive audit (reusable / extend / blocker)
└── contracts/
    ├── ai-batch-api.md
    ├── ai-batch-worker.md
    └── ai-batch-ui.md
```

`tasks.md` was produced by speckit-tasks at the user's request as a conditional breakdown; execution stays gated at T006. Decisions I2/U1/E1 are recorded in research.md.

### Source Code: planned changes, not implemented

```text
apps/web/src/
  app/api/ai/tasks/route.ts                       # extend existing create
  app/api/ai/tasks/preview/route.ts               # new read-only target preview
  app/api/ai/tasks/[aiTaskId]/route.ts            # safe outcomes
  app/api/ai/tasks/[aiTaskId]/predictions/route.ts # preserve partial results
  components/workspace/ai-detect-dialog.tsx       # shared target-aware UI
  components/workspace/bulk-action-bar.tsx        # open same panel
  lib/ai/ai-target-service.ts                    # new shared AI validation orchestration
  lib/ai/ai-task-service.ts
  lib/ai/ai-task-read-service.ts
  lib/ai/ai-task-api-client.ts
  lib/ai/ai-prediction-results.ts
  lib/assets/asset-bulk-service.ts               # strict, transaction-aware reuse
  lib/validation/asset-bulk.ts                    # export reusable selection schema
  lib/validation/ai-task.ts
  lib/jobs/retry-job.ts                          # AI retry allowlist
  lib/jobs/                                     # safe summary/retry projections
  stores/asset-selection-store.ts                # reuse existing semantics
  types/ai-batch.ts                              # new browser-safe types
apps/worker/src/
  jobs/ai-submit.processor.ts
  jobs/ai-poll.processor.ts
  jobs/ai-prediction-writer.ts
  jobs/ai-video-prediction-writer.ts
  providers/ai/aioz-task-resources.ts
  providers/ai/aioz-annotation-services-provider.ts
  providers/ai/aioz-annotation-services-normalization.ts
  providers/ai/aioz-video-normalization.ts
  queue/ai-poll-scanner.ts
packages/domain/src/
  ai-provider.ts                                # preserve per-input results
  ai-batch.ts                                   # new versioned input/outcome schemas
apps/web/tests/{ai,assets-bulk,workflow}/
apps/worker/tests/{jobs,providers/ai}/
specs/api/                                      # extend documented AI contracts
```

**Structure Decision**: Extend existing orchestration and shared selection code. Extract writer internals only as needed to retain current image/video behavior; do not introduce another execution pipeline. No Prisma migration is planned: existing JSON checkpoints and uniqueness constraints suffice. Reassess only if implementation proves a specific invariant cannot be maintained; never silently introduce a new table or lifecycle.

## Sequenced implementation outline (after evidence and phase gates)

1. Close E1–E3 with versioned service evidence and topology proof; publish effective limit and enabled capability matrix. Preserve older confirmed observations separately from current deployment proof.
2. Define versioned domain input/result schemas; export Phase 022 selection schema; add transaction-aware ordered resolution, strict eligibility, preview and legacy normalization. Atomically persist authoritative Job input plus AiTask projection and return durable references even if delivery needs recovery.
3. Extend provider resource checks/reservation and normalized per-input envelopes. Keep one external POST, durable unique correlation and fail-closed ambiguous submission. Validate source/permission/model before dispatch without reducing accepted membership.
4. Refactor existing writer completion into per-Asset transactions plus final aggregate reconciliation. Guard current Job lease/cancellation, Dataset permission, source identity and workflow state; commit annotations, required parent revision, and result checkpoint atomically. Preserve manual/accepted work and existing label-resolution policy.
5. Add AI successor allowlist and original task-owner reference; update submit/poll scanner/read projections together. Reuse successful checkpoints/external outputs and retain immutable failure history. Expose successes even when aggregate status is failed/canceled.
6. Integrate target preview and run count in the existing AI panel, reuse model/class/threshold controls and Phase 022 store, and expose refreshable progress/per-Asset results through existing operation views. Update API documentation and backward-compatibility coverage.
7. Execute regression, database race, real-service and browser validation in [quickstart.md](quickstart.md), including p95 and five-person usability criteria. Stop with the required phase completion report; do not declare deployment or earlier phases complete.

## Principal risks

- Missing deployed provider contract/limits/download evidence blocks implementation sign-off.
- AiTask.externalTaskId uniqueness requires owner references across retries, not copying or moving the ID.
- Replacing whole Job.state JSON without transaction fencing can lose outcomes; every checkpoint write must use the same conditional generation protocol.
- Workflow permission revocation and cancellation must serialize with writes; pre-transaction checks alone are insufficient.
- Existing writers use task-level completion; preserving manual annotations, labels and revision behavior needs focused regression coverage.
- Existing tests/provider fixtures are not proof of service network access or maximum-scale support.

## Planning workflow record

Ran `.specify/scripts/bash/setup-plan.sh --json` because the named PowerShell script is absent. No extension configuration exists; before_plan and after_plan hooks are skipped. Worker/provider research was delegated, but the delegate was blocked by the sandbox; its design cautions were consolidated, and repository evidence was audited locally by the primary agent. Agent-context update script is absent after repository search, so that step could not run; AGENTS.md was not rewritten. No runtime tests, migrations, live inference or agent-context automation were executed during planning.

## Complexity Tracking

No constitutional/architecture exceptions. Bounded per-Asset JSON checkpoints and a retry owner reference extend the existing Job model; they do not create another lifecycle authority.
