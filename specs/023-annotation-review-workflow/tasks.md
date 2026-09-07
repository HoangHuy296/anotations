---

description: "Task list for Annotation & Review Workflow (023)"

---

# Tasks: Annotation & Review Workflow

**Input**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [asset-workflow.md](./contracts/asset-workflow.md), and [quickstart.md](./quickstart.md)

**Tests**: Included. The specification explicitly requires preservation of existing annotation/autosave behavior and race, authorization, transition, history, and keyboard-workflow coverage (SC-001–SC-008 and contract tests).

**Organization**: Tasks are grouped by user story, while shared schema, concurrency, and authorization work is completed first.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Parallelizable after stated dependencies because it changes a distinct file.
- **[Story]**: Traceability to the corresponding user story in [spec.md](./spec.md).
- Every task names its exact target path.

---

## Phase 1: Setup

**Purpose**: Establish the documented baseline and test locations without adding dependencies or a new service boundary.

- [X] T001 Record the current typecheck/lint and workspace annotation regression baseline in `specs/023-annotation-review-workflow/quickstart.md` before implementation, preserving any pre-existing failures separately from Phase 023.
- [X] T002 [P] Create the focused workflow test directory and shared fixture helpers in `apps/web/tests/workflow/helpers.ts` for authorized labeler/reviewer/dataset/Asset setup and safe cleanup.
- [X] T003 [P] Add Phase 023 workflow contract paths and response schemas to `specs/api/openapi.yaml` and `specs/api/schemas/asset-workflow.yaml` from `specs/023-annotation-review-workflow/contracts/asset-workflow.md`.

---

## Phase 2: Foundational Integrity and Workflow Infrastructure

**Purpose**: Build the schema, server-side ownership, and content-version guarantees that block every user story.

**⚠️ CRITICAL**: No workflow UI or transition can ship before this phase is complete.

- [X] T004 Add `AssetWorkflowAction`, `AssetWorkflowEvent`, Asset/User relations, and indexes to `prisma/schema.prisma` exactly as specified in `specs/023-annotation-review-workflow/data-model.md`, without adding a parallel review-status field.
- [X] T005 Create the additive Phase 023 Prisma migration under `prisma/migrations/` for T004 and regenerate Prisma client files without modifying unrelated migrations.
- [X] T006 [P] Define strict workflow request/action/feedback schemas and safe response types in `apps/web/src/lib/validation/asset-workflow.ts` and `apps/web/src/types/workspace.ts`.
- [X] T007 [P] Extend the existing role-permission table in `apps/web/src/lib/authorization.ts` with submit-for-review and review-decision permissions, reusing dataset membership authorization rather than creating a new role model.
- [X] T008 Create `apps/web/src/lib/workflow/asset-workflow-service.ts` as the single owner of transition matrix, scoped Asset lookup, expected-revision comparison, conditional Asset update, and same-transaction event creation.
- [X] T009 Add `apps/web/src/app/api/datasets/[datasetId]/assets/[assetId]/workflow/route.ts` with authenticated GET history/state and POST action dispatch, Zod validation, safe error envelopes, and no client-trusted state transition.
- [X] T010 [P] Add `apps/web/tests/workflow/asset-workflow-contract.test.ts` covering malformed requests, rejection feedback validation, `401`/`403`/`404`, `409 INVALID_TRANSITION`, and the exact `409 CONFLICT` / `STALE_REVISION` response contract.
- [X] T011 Add Asset content-revision claiming and editability helpers in `apps/web/src/lib/workflow/asset-workflow-service.ts` so annotation writers can atomically reject writes when an Asset is non-editable and bump the parent revision once per successful transaction.
- [X] T012 Update batch image annotation mutations in `apps/web/src/lib/annotations/annotation-service.ts` to claim/increment parent `Asset.revision` before successful child create/update/delete writes and roll back the bump on any failed optimistic-lock operation.
- [X] T013 [P] Update legacy image mutation paths in `apps/web/src/lib/workspace/image-mutations.ts` to enforce the same Asset editability and atomic revision invalidation while preserving their existing Annotation revision responses.
- [X] T014 [P] Update video track mutation paths in `apps/web/src/lib/annotations/video-track-service.ts` to enforce Asset editability and atomic parent revision invalidation.
- [X] T015 [P] Update video keyframe mutation paths in `apps/web/src/lib/annotations/video-keyframe-service.ts` to enforce Asset editability and atomic parent revision invalidation.
- [X] T016 [P] Update video temporal-label mutation paths in `apps/web/src/lib/annotations/video-temporal-label-service.ts` to enforce Asset editability and atomic parent revision invalidation.
- [X] T017 [P] Update AI prediction annotation writes in `apps/worker/src/jobs/ai-prediction-writer.ts` to advance parent `Asset.revision` transactionally when they change a reviewable Asset, without changing queue payloads or worker API boundaries.
- [X] T018 Add `apps/web/tests/workflow/asset-revision-invalidation.test.ts` proving successful image/video annotation create, update, and delete advance Asset revision once, while stale/failed annotation writes do not advance it or change existing autosave behavior. (Image legacy and PostgreSQL-backed video track/keyframe/temporal-label coverage added.)
- [X] T019 Add `apps/web/tests/workflow/stale-review-race.test.ts` proving an annotation change after reviewer load makes both Approve and Reject return `409 CONFLICT` / `STALE_REVISION`, creates no workflow event, and leaves stored status unchanged.
- [X] T020 Restrict `CHANGE_STATUS` validation in `apps/web/src/lib/validation/asset-bulk.ts` and service behavior in `apps/web/src/lib/assets/asset-bulk-service.ts` so generic bulk mutation cannot enter or clear `IN_PROGRESS`, `NEEDS_REVIEW`, `REVIEWED`, or `REJECTED` and cannot partially mutate a mixed selection.
- [X] T021 [P] Update `specs/022-asset-browser-dataset-management-workspace/contracts/assets-bulk.md`, `specs/022-asset-browser-dataset-management-workspace/data-model.md`, and `specs/api/schemas/bulk-assets.yaml` with the `WORKFLOW_STATUS_REQUIRES_TRANSITION` compatibility boundary.
- [X] T022 Add `apps/web/tests/workflow/bulk-status-integrity.test.ts` proving bulk status updates reject workflow-governed targets/current states while preserving non-workflow operational status changes.

**Checkpoint**: The database schema, status authority, transition service, asset-content revision, and status-bypass protection are in place. A stale reviewer decision is structurally unable to succeed.

**Phase 023 blocker classification**: T010 (HTTP contract), T018 (complete video revision proof), T019 (stale-review race), and T022 (bulk-status integrity) are **technical blockers**. T052 (manual acceptance) and T053 (security/closure audit) are **closure blockers**. Other unchecked UX/documentation refinements do not authorize redefining `Asset.status` or `Annotation.revision` and should not delay technical proof unless they affect these blockers.

**Closure sequence**: Existing architecture → HTTP boundary → Video writers → Concurrency race → Bulk integrity → Manual UX → Security audit → CLOSE. Do not advance to a later stage while an earlier technical or closure blocker is unresolved.

---

## Phase 3: User Story 1 — Annotate and Submit for Review (Priority: P1) 🎯 MVP

**Goal**: A labeler can start annotation work and submit an Asset without changing the established save/autosave workflow.

**Independent Test**: From a `NEW`/`READY` Asset, an authorized labeler starts, edits/autosaves, and submits an Asset; status moves to `IN_PROGRESS` then `NEEDS_REVIEW`, while ordinary saves do not change status.

- [X] T023 [P] [US1] Add `apps/web/tests/workflow/submit-for-review.test.ts` covering Start, Submit, empty submission allowed, duplicate submit rejection, expected-revision conflict, and unchanged annotation/autosave semantics.
- [X] T024 [US1] Implement Start and Submit/Resubmit action mappings in `apps/web/src/lib/workflow/asset-workflow-service.ts` using the shared guarded transition primitive and append-only events.
- [X] T025 [US1] Project safe workflow status/revision and permitted actions through `apps/web/src/lib/workspace/workspace-read.ts` and `apps/web/src/types/workspace.ts` for the selected Asset.
- [X] T026 [US1] Add the labeler-facing workflow status badge and Start/Submit affordance to `apps/web/src/components/workspace/workspace-header.tsx`, flushing existing autosaves before Submit without changing their behavior.
- [X] T027 [US1] Wire Image and Video properties-panel state refresh after Start/Submit in `apps/web/src/components/workspace/image-properties-tabs.tsx` and `apps/web/src/components/workspace/video-properties-tabs.tsx`.

**Checkpoint**: A labeler can independently start and submit an Asset, with annotation editing and autosave regression coverage intact.

---

## Phase 4: User Story 2 — Review Submitted Annotation (Priority: P1)

**Goal**: A reviewer can inspect a submitted Asset read-only and approve or reject its current annotation set with required feedback and stale-decision protection.

**Independent Test**: An authorized reviewer reads a `NEEDS_REVIEW` Asset, sees no edit controls, approves or rejects at the current revision, and receives `STALE_REVISION` after a concurrent annotation change.

- [X] T028 [P] [US2] Add `apps/web/tests/workflow/review-decision.test.ts` covering authorized approve/reject, mandatory rejection feedback, read-only review mode, concurrent one-winner decision behavior, and `STALE_REVISION` loser behavior.
- [X] T029 [US2] Implement Open Review, Approve, and Reject mappings plus feedback persistence in `apps/web/src/lib/workflow/asset-workflow-service.ts`, keeping `OPEN_REVIEW` non-state-changing and all decisions in one transaction.
- [X] T030 [US2] Expose review-mode and workflow-action capability state in `apps/web/src/lib/workspace/workspace-engine-registry.tsx` and `apps/web/src/components/workspace/workspace-engine.tsx` without creating a separate route or modality workspace.
- [X] T031 [US2] Suppress annotation create/edit/delete controls in review mode in `apps/web/src/components/workspace/image-engine.tsx`, `apps/web/src/components/workspace/video-engine.tsx`, and the shared toolbar/toolbox components that invoke them.
- [X] T032 [US2] Add reviewer Open Review, Approve, Reject-with-feedback, stale-reload, and success-refresh UI states to `apps/web/src/components/workspace/workspace-header.tsx`.

**Checkpoint**: Review decisions are server-authorized, revision guarded, and read-only in the existing workspace; no stale review decision can be applied.

---

## Phase 5: User Story 5 — Workflow Permissions and Integrity (Priority: P1)

**Goal**: Every server-side workflow mutation rejects unauthorized, cross-dataset, stale, and invalid-state requests with no partial state or annotation write.

**Independent Test**: Direct API attempts using wrong role, wrong dataset, invalid source state, deleted Asset, and old revision all fail deterministically and leave data unchanged.

- [X] T033 [P] [US5] Add `apps/web/tests/workflow/workflow-authorization.test.ts` covering submit vs review role tiers, self-review policy, cross-dataset concealment, and deleted-Asset behavior.
- [X] T034 [P] [US5] Add `apps/web/tests/workflow/workflow-integrity.test.ts` covering stale-before-invalid error precedence, concurrent submit, no partial event/state writes, and server rejection of delayed annotation writes after review freeze.
- [X] T035 [US5] Harden error classification and rollback assertions in `apps/web/src/lib/workflow/asset-workflow-service.ts` and `apps/web/src/app/api/datasets/[datasetId]/assets/[assetId]/workflow/route.ts` so all failure paths satisfy `STALE_REVISION`, `INVALID_TRANSITION`, and concealment rules.
- [X] T036 [US5] Add workflow mutation audit logging with allowlisted fields only in `apps/web/src/lib/workflow/asset-workflow-service.ts` and `packages/domain/src/log.ts`, excluding feedback content, credentials, URLs, and annotation geometry.

**Checkpoint**: Workflow integrity is independently verifiable at the API boundary even when the browser UI is bypassed.

---

## Phase 6: User Story 3 — Rework and Resubmit (Priority: P2)

**Goal**: An annotator can reopen a rejected Asset, see the feedback, edit normally, and resubmit without losing annotation data or workflow history.

**Independent Test**: Reject an Asset with feedback, start rework, edit it, resubmit—even if unchanged—and verify the correct state sequence and retained prior data.

- [X] T037 [P] [US3] Add `apps/web/tests/workflow/rework-resubmit.test.ts` covering authorized Start Rework, unauthorized rejection, retained feedback/annotations, unchanged-content resubmission, and revision-guarded Resubmit.
- [X] T038 [US3] Implement Start Rework and Resubmit paths in `apps/web/src/lib/workflow/asset-workflow-service.ts` using the same conditional update/event transaction as initial submission.
- [X] T039 [US3] Render rejection feedback and rework/resubmit actions in `apps/web/src/components/workspace/workspace-header.tsx` and refresh selected-Asset state after each transition.
- [X] T040 [US3] Restore editable workspace controls only for the re-entered `IN_PROGRESS` state in `apps/web/src/components/workspace/image-engine.tsx`, `apps/web/src/components/workspace/video-engine.tsx`, and their existing toolbars.

**Checkpoint**: Rework is a complete, independently testable loop with retained feedback, annotations, and safe re-submission.

---

## Phase 7: User Story 4 — Workflow History and Feedback (Priority: P2)

**Goal**: Authorized users can see a complete ordered lifecycle history distinct from annotation geometry history.

**Independent Test**: A submit → reject → rework → resubmit → approve sequence exposes every event in order, with rejection feedback attached to only its rejection event and an empty-state display for new Assets.

- [X] T041 [P] [US4] Add `apps/web/tests/workflow/workflow-history.test.ts` covering chronological order, actor/action/state/revision fields, feedback association, empty history, and authorized read access.
- [X] T042 [US4] Implement ordered workflow-history reads and safe actor projection in `apps/web/src/lib/workflow/asset-workflow-service.ts` and `apps/web/src/app/api/datasets/[datasetId]/assets/[assetId]/workflow/route.ts`.
- [X] T043 [US4] Add a workflow-history and feedback panel inside `apps/web/src/components/workspace/properties-panel.tsx` and `apps/web/src/components/workspace/image-properties-tabs.tsx` without using Annotation history or creating a review route.
- [X] T044 [US4] Add the equivalent Video workflow-history presentation in `apps/web/src/components/workspace/video-properties-tabs.tsx` and a supported read-only fallback in `apps/web/src/components/workspace/placeholder-properties-tabs.tsx`.

**Checkpoint**: Workflow accountability and feedback are visible and independently testable without conflating them with annotation edits.

---

## Phase 8: User Story 6 — Keyboard Workflow (Priority: P3)

**Goal**: Permitted Submit, Approve, and Reject actions are available by keyboard without overriding annotation-editing input behavior.

**Independent Test**: In permitted states, shortcuts invoke the same action as the UI; when focus/edit interaction owns the key or the actor is unauthorized, they perform no mutation.

- [X] T045 [P] [US6] Add `apps/web/tests/workflow/workflow-shortcuts.test.tsx` covering allowed shortcuts, unauthorized no-op, rejection-feedback prompt requirement, and suppression during editable fields and active annotation interaction.
- [X] T046 [US6] Create the minimal shared workflow-shortcut hook in `apps/web/src/components/workspace/use-workflow-shortcuts.ts`, scoped to current permission/state and without introducing a general shortcut framework.
- [X] T047 [US6] Wire the hook to existing workflow controls in `apps/web/src/components/workspace/workspace-header.tsx` and prevent shortcut handling while `apps/web/src/components/workspace/canvas-stage.tsx` owns an active annotation interaction.
- [X] T048 [US6] Document the delivered shortcuts and their suppression rules in `specs/023-annotation-review-workflow/quickstart.md`.

**Checkpoint**: Keyboard operation matches the guarded on-screen workflow behavior and cannot bypass permissions, feedback, or Canvas interactions.

---

## Phase 9: Polish and Cross-Cutting Verification

**Purpose**: Complete contract/docs alignment and confirm the protected annotation/workspace behavior remains unchanged.

- [X] T049 Merge the finalized workflow endpoint contract and Phase 022 bulk-status compatibility update into `specs/api/openapi.yaml` and run `pnpm docs:validate-openapi` plus `pnpm docs:bundle-openapi`.
- [X] T050 [P] Run focused workflow tests and all existing annotation/autosave/locking/workspace authorization suites listed in `specs/023-annotation-review-workflow/quickstart.md`; record outcomes in `specs/023-annotation-review-workflow/quickstart.md`.
- [X] T051 [P] Run `pnpm typecheck` and `pnpm lint`, fixing only violations introduced by Phase 023 and recording unrelated pre-existing failures in `specs/023-annotation-review-workflow/quickstart.md`.
- [ ] T052 Perform the six manual acceptance scenarios in `specs/023-annotation-review-workflow/quickstart.md`, including the reviewer stale-revision race, and record any UI-specific findings there.
- [X] T053 Review every Phase 023 route, DTO, log event, and UI projection against `AGENTS.md` security rules and update `specs/023-annotation-review-workflow/plan.md` with the final phase report.

---

## Dependencies and Execution Order

### Phase dependencies

- **Setup (Phase 1)** has no dependencies.
- **Foundational (Phase 2)** depends on setup and blocks all stories.
- **US1, US2, and US5 (Phases 3–5)** all require Phase 2. US2's service work may begin after T008/T009, but its UI uses the safe workflow projection from US1. US5 can run in parallel once the foundational service exists.
- **US3 (Phase 6)** depends on US2 rejection behavior and feedback.
- **US4 (Phase 7)** depends on transition events produced by US1–US3; its read/UI work can proceed after the schema and route exist.
- **US6 (Phase 8)** depends on delivered UI actions from US1–US3.
- **Polish (Phase 9)** depends on completed desired stories.

### User-story order

`Foundation → US1 → US2 → US5 → US3 → US4 → US6 → Polish`

US5 API hardening may be staffed in parallel with the US1/US2 UI work after Phase 2. US4 history reads can be prepared after Phase 2 but should be completed after transition producers are available.

### Parallel opportunities

- T002 and T003 can run in parallel.
- T006, T007, and T010 can run in parallel after T004/T005 establish generated schema types.
- T013–T017 are separate writer paths and can run in parallel after T011.
- T018, T019, and T022 can run in parallel after their related service/mutation work lands.
- Within stories, test tasks T023, T028, T033/T034, T037, T041, and T045 can be implemented independently before their feature code.

## Parallel Examples

### Foundational annotation writer coverage

```text
Task: "Update apps/web/src/lib/workspace/image-mutations.ts for atomic Asset revision invalidation"
Task: "Update apps/web/src/lib/annotations/video-track-service.ts for atomic Asset revision invalidation"
Task: "Update apps/web/src/lib/annotations/video-keyframe-service.ts for atomic Asset revision invalidation"
Task: "Update apps/web/src/lib/annotations/video-temporal-label-service.ts for atomic Asset revision invalidation"
Task: "Update apps/worker/src/jobs/ai-prediction-writer.ts for atomic Asset revision invalidation"
```

### Review integrity coverage

```text
Task: "Add apps/web/tests/workflow/workflow-authorization.test.ts"
Task: "Add apps/web/tests/workflow/workflow-integrity.test.ts"
Task: "Add apps/web/tests/workflow/stale-review-race.test.ts"
```

## Implementation Strategy

### MVP first

1. Complete Setup and Foundational phases, including T019 stale-race coverage.
2. Complete US1: Start, normal editing/autosave, and Submit.
3. Complete US2: read-only review plus Approve/Reject at a current revision.
4. **Stop and validate**: run US1/US2 tests and the stale-review quickstart scenario before adding rework, history UI, or shortcuts.

### Incremental delivery

1. Foundation → no stale decision can be committed and generic bulk status cannot bypass workflow states.
2. US1 + US2 → usable annotation/submit/review MVP.
3. US5 → adversarial API integrity gate.
4. US3 + US4 → closed feedback/rework/accountability loop.
5. US6 → optional keyboard efficiency.
6. Polish → complete contract, regression, and manual acceptance verification.

## Notes

- Every task follows the required checkbox, sequential ID, optional parallel marker, story label, and exact-path format.
- `Asset.status` remains the sole workflow state. `Annotation.status`, Job state, and AI task state are not workflow substitutes.
- `STALE_REVISION` is not a generic validation error: it is the required `409 CONFLICT` response for a reviewer decision using an old Asset revision.
- Existing Canvas geometry, drag/transform behavior, and autosave semantics must not be redesigned while adding the parent Asset revision invalidation hook.
