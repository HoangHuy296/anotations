# Quickstart: Validate Annotation & Review Workflow

## Prerequisites

- Run the project’s normal PostgreSQL-backed environment and apply the additive Phase 023 Prisma migration.
- Use a labeler and a reviewer authorized for the same dataset.
- Start from an Asset with at least one existing annotation.

No workflow-specific environment variable is required. Do not put database, provider, MinIO, or queue credentials in browser requests or fixtures.

## Focused validation

```bash
pnpm --filter @annotationplatform/web typecheck
pnpm --filter @annotationplatform/web test -- workflow
pnpm --filter @annotationplatform/web test -- annotation-locking
pnpm --filter @annotationplatform/web test -- autosave
```

Use [data-model.md](./data-model.md) for persistence/concurrency rules and [asset-workflow.md](./contracts/asset-workflow.md) for API responses.

## Baseline recorded before Phase 023 implementation

- `pnpm --filter @annotationplatform/web lint`: passed.
- `pnpm --filter @annotationplatform/web typecheck`: passed after restoring the intentionally safe `410 IMAGE_CONTENT_DEPRECATED` compatibility tombstone for the legacy route test.
- Existing workspace annotation-locking, annotation-mutations, autosave-state, and image-navigation test files passed without changes.

## Acceptance flow

1. Start an Asset, draw/edit annotations, and allow normal autosave. Verify autosave alone does not change Asset status.
2. Submit it and verify `NEEDS_REVIEW` plus a Submit history event.
3. As a reviewer, load the Asset at revision N. In another session mutate an annotation. Approve or reject using N and verify `409 CONFLICT` / `STALE_REVISION`, with no decision event or status change.
4. Reload at N+1; approve successfully and verify `REVIEWED`, one revision increment, and one event.
5. Repeat through rejection: blank feedback fails; non-empty feedback creates the Rejected event. Start rework, edit, resubmit, and ensure history remains complete.
6. Attempt a Phase 022 bulk status change to or from a workflow-governed state; verify it is refused. Confirm non-workflow operational status behavior remains available.

## Keyboard shortcuts

- `S` submits an `IN_PROGRESS` Asset when the actor has submit permission.
- `A` approves a `NEEDS_REVIEW` Asset when the actor has review permission.
- Shortcuts are suppressed while focus is in an input, textarea, or select and
  have no effect when the server rejects the underlying action. Rejection
  remains feedback-first and has no keyboard shortcut.

## Manual acceptance record

| Scenario | Status | Evidence / finding |
| --- | --- | --- |
| Workflow history rendering and successful review decision | Partial pass | Workspace evidence on 2026-09-04 shows `REVIEWED`, the Properties Panel workflow history, `START` (`READY → IN_PROGRESS`), `SUBMIT` (`IN_PROGRESS → NEEDS_REVIEW`), and `APPROVE` (`NEEDS_REVIEW → REVIEWED`) for the selected image. |
| Repeated Open Review entries | Expected | `OPEN_REVIEW` is intentionally append-only and non-state-changing. Each explicit click records a separate inspection entry; the repeated entries shown do not alter the Asset revision or status. |
| Autosave and submission | Pending | Run acceptance steps 1 and 2 in a browser. |
| Two-session stale decision race | Pending | Run acceptance step 3; verify HTTP `409` / `STALE_REVISION` and no decision event. |
| Reload and successful approval | Pending | Run acceptance step 4 with the latest revision. |
| Reject, feedback, rework, and resubmit | Pending | Run acceptance step 5. |
| Bulk workflow-state guard | Pass | Browser test on 2026-09-04: explicit bulk `CHANGE_STATUS` for asset `cms5yfslq000nmr0kijvid1f8` attempted `REVIEWED → READY` and was refused with “Workflow statuses must be changed through the asset workflow action.” This is the required Phase 022/023 integrity behavior. |

T052 remains open until every pending scenario above has browser evidence.

## Regression expectations

- Existing image/video Canvas drawing, pan/zoom, autosave, and Annotation revision conflict behavior pass unchanged.
- Failed workflow actions never alter geometry, Annotation status, Job state, or AI task state.
- Stale review actions are never retried automatically.

## Final automated validation (local Docker PostgreSQL)

- Applied `20260903000000_add_asset_workflow_events` successfully with Prisma.
- Workflow lifecycle, stale-decision, concurrent-decision, parent-revision,
  authorization, and video-track revision tests passed against PostgreSQL.
- Existing workspace locking, mutation, autosave, conflict, and navigation
  regression suite passed (10 tests).
- `pnpm --filter @annotationplatform/web lint`, `pnpm docs:validate-openapi`,
  and `pnpm docs:bundle-openapi` passed.
- `pnpm --filter @annotationplatform/web typecheck` and lint pass.
- Authorization (role tiers, self-review policy, cross-dataset concealment,
  deleted assets), transaction-integrity, and keyboard-shortcut tests pass;
  PostgreSQL-backed workflow authorization and integrity suites were run in
  the Compose web container.
