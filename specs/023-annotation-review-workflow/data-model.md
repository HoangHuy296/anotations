# Phase 1 Data Model: Annotation & Review Workflow

## Asset state and revision

`Asset.status` is the sole persisted workflow state. It maps to `NEW`/`READY` (not started), `IN_PROGRESS` (authoring/rework), `NEEDS_REVIEW` (submitted), `REVIEWED` (approved), and `REJECTED` (rejected). No `ReviewStatus`, Submission, or Review model owns the state.

`Asset.revision` is the optimistic-concurrency version for the reviewable Asset content. It increments exactly once in a successful workflow transition and exactly once for each successful annotation mutation transaction for that Asset. `Annotation.revision` stays separate and continues to guard existing autosave/edit updates.

## New `AssetWorkflowEvent`

| Field | Type | Rules |
| --- | --- | --- |
| `id` | `String` cuid | primary key |
| `assetId` | `String` | required FK to Asset, cascade delete |
| `actorId` | `String` | required FK to User |
| `action` | `AssetWorkflowAction` | `START`, `SUBMIT`, `OPEN_REVIEW`, `APPROVE`, `REJECT`, `START_REWORK`, `RESUBMIT` |
| `fromStatus` | `AssetStatus?` | prior state; null only when not applicable |
| `toStatus` | `AssetStatus?` | resulting state; null for `OPEN_REVIEW` |
| `assetRevision` | `Int` | revision after state change, or revision observed for `OPEN_REVIEW` |
| `feedback` | `String?` | required, non-blank, bounded only for `REJECT` |
| `createdAt` | `DateTime` | default now |

Indexes: `[assetId, createdAt]` for history and `[actorId, createdAt]` for audit. Events are append-only and are created only in the workflow service transaction.

## Transition and concurrency rules

| Action | Current status | Result | Permission |
| --- | --- | --- | --- |
| Start | `NEW`, `READY` | `IN_PROGRESS` | submit tier |
| Submit / Resubmit | `IN_PROGRESS` | `NEEDS_REVIEW` | submit tier |
| Open Review | `NEEDS_REVIEW` | unchanged | review tier |
| Approve | `NEEDS_REVIEW` | `REVIEWED` | review tier |
| Reject | `NEEDS_REVIEW` | `REJECTED` | review tier + feedback |
| Start Rework | `REJECTED` | `IN_PROGRESS` | submit tier |

For every state-changing action, a Prisma transaction conditionally updates the Asset with id, dataset scope, expected source status, and `expectedRevision`, increments revision, then inserts the event. If the persisted revision differs, return `409 CONFLICT` / `STALE_REVISION` before classifying the transition. If the revision matches but the source status is wrong, return `409 CONFLICT` / `INVALID_TRANSITION`. Neither failure changes an Asset, Annotation, or event.

## Invariants

- Annotation mutation writes increment Asset revision only after their own optimistic-lock condition succeeds, and roll back together on failure. To close the review/edit race, they claim the Asset revision before child writes in the same transaction and enforce status eligibility at the server mutation boundary.
- Worker AI annotation writes follow the same invalidation rule where they affect a reviewable Asset.
- Annotation status, geometry, Job state, and AI task status never act as review state and are never changed by review transitions.
- Generic Phase 022 `CHANGE_STATUS` cannot set a workflow-governed target or clear a workflow-governed current status. Operational statuses remain governed by Phase 022 behavior.
