# Implementation Plan: Annotation & Review Workflow

**Branch**: `023-annotation-review-workflow` | **Date**: 2026-09-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/023-annotation-review-workflow/spec.md`

## Summary

Implement the existing workspace's single-asset review lifecycle: Start, Submit, Open Review, Approve, Reject, Start Rework, and Resubmit. `Asset.status` remains the only workflow state carrier: `IN_PROGRESS`, `NEEDS_REVIEW`, `REVIEWED`, and `REJECTED` are not mirrored by a ReviewStatus or other parallel state model. A minimal append-only `AssetWorkflowEvent` records workflow action, actor, before/after state, feedback, and resulting Asset revision.

The primary integrity rule is optimistic concurrency. Every successful annotation create/update/delete must atomically invalidate its parent `Asset.revision` while retaining all existing `Annotation.revision` checks and autosave behavior. A state-changing workflow request conditionally updates an Asset by id, dataset scope, expected status, and the client's expected Asset revision. An Approve or Reject using an older revision must return `409 CONFLICT` with `STALE_REVISION`, and must write no status change, annotation change, or history event.

## Technical Context

**Language/Version**: TypeScript; Next.js 15 App Router (`apps/web`); Node.js worker (`apps/worker`).

**Primary Dependencies**: Prisma 6/PostgreSQL, Zod, Zustand, React, react-konva; no new dependency.

**Storage**: PostgreSQL/Prisma for workflow events and transitions. Redis/BullMQ and MinIO are not involved in review transitions.

**Testing**: Vitest/node:test integration tests and existing workspace, autosave, and annotation-locking tests.

**Target Platform**: Linux/Docker Compose web application.

**Project Type**: Next.js application plus private worker in a pnpm monorepo.

**Performance Goals**: One Asset transition is a bounded Prisma transaction with interactive latency; it never fetches the full annotation set merely to make a decision.

**Constraints**: Prisma only; server-side authorization and Zod validation; no status model duplication; no Canvas redesign; preserve Annotation revision/autosave semantics; generic bulk status changes cannot bypass workflow states.

**Scale/Scope**: One Asset and its whole current annotation set per action. No bulk review, standalone review app, comments, notifications, or background workflow Job.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is an unfilled template; [AGENTS.md](../../AGENTS.md) is the binding governance.

| Gate | Status | Plan response |
| --- | --- | --- |
| `Asset.status` is lifecycle authority | PASS | The design reuses its existing values; no ReviewStatus, Submission, or Review state model. |
| Prisma/PostgreSQL domain authority | PASS | Events and transitions use Prisma transactions; no raw SQL or Redis state. |
| Canvas/annotation concurrency boundary | PASS | Existing geometry, interaction, autosave, and Annotation optimistic locking are preserved; only successful mutations invalidate parent Asset revision. |
| Next.js public API and server authorization | PASS | Dataset-scoped Route Handler validates action, actor, state, and revision server-side. |
| Existing bulk operations cannot undermine review integrity | PASS | Phase 022 generic status mutation is blocked from entering, leaving, or targeting workflow-governed states. |

No gate violations require a complexity exception.

## Project Structure

```text
specs/023-annotation-review-workflow/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/asset-workflow.md

prisma/schema.prisma                                      # AssetWorkflowEvent + relations/enums
apps/web/src/app/api/datasets/[datasetId]/assets/[assetId]/workflow/route.ts
apps/web/src/lib/workflow/asset-workflow-service.ts       # transition/OCC/history owner
apps/web/src/lib/validation/asset-workflow.ts             # strict Zod request schema
apps/web/src/lib/authorization.ts                          # reuse existing role table permissions
apps/web/src/lib/annotations/*.ts                          # atomic Asset revision invalidation
apps/web/src/components/workspace/*                        # status/actions/history/read-only review mode
apps/web/src/lib/assets/asset-bulk-service.ts              # guard generic status updates
apps/web/tests/workflow/*                                  # contract/race/history/auth tests
```

**Structure Decision**: The existing Next.js workspace remains the only browser-facing review surface. A single server-side workflow service owns the transition matrix; per-modality engines and Canvas components are not duplicated or redesigned.

## Implementation Slices

1. Add the additive workflow-event schema, migration, and safe read projection.
2. Add the transition service and API contract: state validation, role authorization, expected revision, event insertion, and explicit conflict codes.
3. In every successful annotation writer (image, legacy image, video track/keyframe/temporal, and worker AI writer where relevant), claim/increment the parent Asset revision in the same transaction before the child write. Preserve existing annotation request/response and autosave semantics.
4. Enforce server-side write eligibility so a delayed annotation save cannot commit after a concurrent transition freezes the Asset for review or approval.
5. Prevent Phase 022 generic `CHANGE_STATUS` from targeting or clearing workflow-governed states; update its contract/OpenAPI documentation.
6. Add existing-workspace UI affordances, read-only review mode, history, and guarded keyboard actions; then run stale-race and regression suites.

## Post-Design Constitution Re-Check

PASS. One append-only workflow-event entity adds history without duplicating state; Asset revision is extended as the existing optimistic-lock version rather than inventing a lock. The design uses Prisma transactions, creates no new public service boundary, and preserves Canvas/autosave behavior.

## Complexity Tracking

No Constitution Check violations; table intentionally omitted.

## Final Security and Closure Audit (2026-09-04)

- `Asset.status` remains the sole lifecycle field. `AssetWorkflowEvent` is
  append-only history only; it does not mirror or independently drive state.
- Workflow mutations use server-side actor resolution, dataset-scoped
  permission checks, strict Zod input validation, and a Prisma transaction.
  Conditional revision/state writes make stale review decisions return
  `STALE_REVISION` without a status or event write.
- Browser workflow projections contain only Asset identifiers, current status,
  revision, permitted action names, safe actor identity, and optional reviewer
  feedback. They expose no credentials, provider URLs, storage references, or
  annotation geometry.
- Workflow logs use a closed allowlist: actor/dataset/asset IDs, action,
  before/after status, and revision. Feedback, URLs, credentials, and geometry
  are excluded.
- Review-mode UI is advisory only; server-side frozen-Asset writer checks are
  authoritative for image and video annotation writes.

Remaining closure requirement: perform and record the six browser/manual
acceptance scenarios in `quickstart.md` (T052) before declaring Phase 023
closed.
