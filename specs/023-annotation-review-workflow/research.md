# Research: Annotation & Review Workflow (Phase 023)

**Feature dir**: `specs/023-annotation-review-workflow/`
**Date**: 2026-08-27
**Purpose**: Ground `spec.md` in the actual codebase — what already exists, what is genuinely missing, and what Phase 023 must add versus reuse. This document resolves the domain questions in the phase brief; anything not resolvable from the codebase is explicitly marked "Requires stakeholder decision" rather than invented.

## 1. Current annotation lifecycle

- Every `Annotation` is created with `status: DRAFT` (`annotation-service.ts`, `video-track-service.ts`, `video-temporal-label-service.ts`, `video-keyframe-service.ts`). No code path ever sets `IN_PROGRESS`, `COMPLETED`, `SUBMITTED`, or `ACCEPTED` on an `Annotation`.
- Geometry/label edits go through `mutateImageAnnotations` (`lib/annotations/annotation-service.ts`) and the video mutation services, all guarded by **`Annotation.revision`** optimistic locking: `updateMany({ where: { id, revision }, data: { ..., revision: { increment: 1 } } })`, treating `count !== 1` as `CONFLICT`. Autosave and the Canvas already depend on this contract — it is a protected boundary for this phase.
- Asset-level metadata (description) is independently guarded by **`Asset.revision`**, using the identical pattern in `lib/workspace/image-mutations.ts` and `lib/workspace/video-mutations.ts`. `Asset.revision` and `Annotation.revision` are two separate optimistic-lock counters today.

## 2. Current status models (audited, not assumed)

| Enum | Values | Actually used in app code today |
| --- | --- | --- |
| `AssetStatus` | NEW, PROCESSING, READY, IN_PROGRESS, COMPLETED, NEEDS_REVIEW, REVIEWED, REJECTED, SKIPPED, ARCHIVED, FAILED | `NEW` (import default) and `READY` (upload default) are set on creation. As of Phase 022's completed bulk Asset Browser (see §15), every value is *reachable* via its generic bulk "change status" action — but that action is transition-blind, revision-blind, and history-blind. No workflow-aware code path (transition-validated, revision-guarded, history-recorded) sets any of these values yet — that is what this phase adds. |
| `AnnotationStatus` | DRAFT, IN_PROGRESS, COMPLETED, SUBMITTED, REVIEWED, ACCEPTED, REJECTED | Only `DRAFT` is ever written (on create). `reviewAnnotationAction` (below) can write `ACCEPTED`/`REJECTED` but is never called from any UI. |
| `DatasetMemberRole` / `UserRole` | OWNER/MANAGER/LABELER/REVIEWER (dataset); ADMIN/MANAGER/LABELER/REVIEWER (system) | Fully wired into `lib/authorization.ts`'s `DATASET_ROLE_PERMISSIONS`. |
| `JobStatus`/`JobStage`/`AiTaskStatus`/`AssetSyncStatus` | (see schema) | All belong to unrelated subsystems (background jobs, AI provider tasks, repo sync) — not review state. |

**Finding**: a minimal per-**Annotation** review primitive already exists end-to-end but is dead/unwired:

- `apps/web/src/lib/validation/annotation.ts` defines `reviewAnnotationInputSchema` (`{ datasetId, annotationId, revision, status: "ACCEPTED" | "REJECTED" }`).
- `apps/web/src/app/(app)/workspace/[datasetId]/actions.ts` → `reviewAnnotationAction` checks the `annotation.review` permission, then does exactly the revision-guarded `updateMany` pattern, setting `status` and `reviewedById`.
- **No component calls `reviewAnnotationAction`.** It is Phase-017 foundation code, built ahead of a workflow UI, never wired up.

Separately, and more decisively: **Phase 022's spec** (`specs/022-asset-browser-dataset-management-workspace/spec.md` — completed during this audit; see §15 for what its implementation actually does to `Asset.status`) already made an explicit, stakeholder-confirmed product decision:

> "There is no separate review-status concept today; review-related filtering and display reuse the dataset's existing asset-status values (e.g. states representing 'needs review,' 'reviewed,' 'rejected') rather than introducing a second, parallel status machine." (022 spec, Assumptions)
> FR-017 treats `NEEDS_REVIEW` / `REVIEWED` / `REJECTED` as **Asset status** values, explicitly distinct from Annotation status, Job status, and AI task status, and requires that changing one never changes another.

This is a real, already-approved architectural decision Phase 023 must not contradict.

## 3. Resolved: where does workflow state live?

**Decision: `Asset.status`, reusing the existing `AssetStatus` enum. No new enum. No new dedicated Submission/Review entity for state itself.**

Rationale:
- Matches the 022 decision above (Asset status = the one review-state carrier).
- `AssetStatus` already has every value the product's lifecycle needs, with no gaps: `NEW`/`READY` (unannotated), `IN_PROGRESS` (authoring/rework), `NEEDS_REVIEW` (submitted, awaiting review), `REVIEWED` (approved), `REJECTED` (rejected). Zero new enum members are required.
- The competing per-Annotation primitive (`AnnotationStatus` SUBMITTED/REVIEWED/ACCEPTED/REJECTED + `reviewedById` + `reviewAnnotationAction`) is unused dead code and operates at the wrong granularity for this product (see §4). Phase 023 leaves it untouched and does not repurpose it — reconciling or removing it is an explicit non-goal of this phase (documented in Out of Scope).

Mapping used throughout `spec.md`:

| Conceptual state | `AssetStatus` value |
| --- | --- |
| Unannotated | `NEW` / `READY` (asset imported, no annotation work started) |
| In Progress / Rework | `IN_PROGRESS` |
| Ready for Review / Submitted | `NEEDS_REVIEW` |
| In Review | *(no persisted value — see §5)* |
| Approved | `REVIEWED` |
| Rejected | `REJECTED` |

## 4. Review unit definition

**Decision: the reviewable unit is the whole Asset and its current annotation set together, not each individual `Annotation`.**

Rationale:
- The workspace is asset-centric everywhere: `/workspace/[datasetId]` navigation, `Previous`/`Next`, the Properties Panel, and the Canvas all operate on "the current asset" and render its entire annotation set at once. There is no existing UI concept of navigating or acting on one annotation independently of its asset.
- A per-annotation review model (submit/approve/reject each bounding box separately) has no product surface today and no partial precedent beyond the single unused `reviewAnnotationAction`.
- Multiple annotations on one asset therefore do **not** carry independent workflow states in this phase; they share their parent Asset's workflow state.

## 5. Submission model / Review model / History model decisions

**No dedicated `Submission` entity. No dedicated `Review` entity.** `Asset.status` (the transition target) plus one new minimal, append-only workflow-event log is sufficient to satisfy every requirement in the brief (submit, approve, reject with feedback, rework, resubmit, ordered history).

Why not reuse `JobEvent`: `JobEvent` is scoped to the unrelated Job/BullMQ processing subsystem (`jobId` FK, `JobStage`/`JobEventLevel` semantics tied to background processing). Reusing it would conflate two unrelated lifecycles (background job processing vs. human review workflow) and would require a nullable/polymorphic FK — exactly the kind of duplicate-but-different system this audit is meant to avoid creating. Instead, Phase 023 introduces **one** new entity, shaped like `JobEvent` (actor, action, before/after state, timestamp, free-form context) but scoped to the Asset workflow:

- one row per transition: actor, action (Start / Save is NOT a transition — see §6 / Submit / Approve / Reject / Start Rework / Resubmit), the Asset's `status` before and after, the `Asset.revision` at the time of the event, an optional feedback/reason string, and a timestamp.
- this is simultaneously the answer to "review history" (US4) and "review feedback" (§9) — the rejection's required feedback text is a field on its own transition event, not a separate Comment entity, since no comment/thread infrastructure exists anywhere in the codebase today (`Comment`, `Feedback`, `Discussion`, `Thread` — zero matches).

This event log is explicitly **not** the same thing as `Annotation` revision history: it answers "what happened in the review lifecycle," never "what changed in the geometry/label data." The two must stay conceptually separate even though both are, loosely, "history."

## 6. Save vs. Submit

Confirmed: **Save is not a workflow transition.** Autosave already exists per-annotation (image) and per-track/keyframe (video), guarded by `Annotation.revision`, and must continue exactly as-is. "Start annotation" (`NEW`/`READY` → `IN_PROGRESS`) and "Submit for Review" (`IN_PROGRESS` → `NEEDS_REVIEW`) are the only annotator-side transitions this phase adds; ordinary geometry/label saves never touch `Asset.status`.

## 7. Optimistic locking: the critical gap

`Asset.revision` is a real, already-proven optimistic-lock column (used today for description edits: `image-mutations.ts`, `video-mutations.ts`). **It is not currently bumped by any annotation create/update/delete** — `mutateImageAnnotations` and the video mutation services only increment `Annotation.revision`. This means, today, `Asset.revision` cannot detect "the annotation set changed since I last read the asset."

**Decision**: Phase 023 must close this gap as a minimal integration hook (not a Canvas redesign): every annotation create/update/delete for an Asset must also invalidate that Asset's revision, in the same transaction as the existing annotation mutation. This makes `Asset.revision` a true content-version for "this Asset's reviewable state" (metadata + annotation set combined), and lets every workflow transition reuse the exact same `updateMany({ where: { id, revision, status: expectedStatus }, data: { status: nextStatus, revision: { increment: 1 } } }).count === 1` contract already proven elsewhere in this codebase. No new locking mechanism is invented — the existing contract is extended to cover a case it currently misses.

This directly answers the race in the brief: Annotator A edits → Asset revision advances. Reviewer B, holding an older revision, attempts Approve → the guarded update matches 0 rows → 409 Conflict → reviewer must reload before deciding. Stale approval is structurally impossible, not policy-enforced.

`Submit`/`Approve`/`Reject`/`Start Rework`/`Resubmit` all pass the client's last-known `Asset.revision` and are rejected as stale (never silently reapplied) if it no longer matches. `Open Review` performs no mutation and needs no lock — it is a permission-gated read.

## 8. Workspace integration point

`apps/web/src/lib/workspace/workspace-engine-registry.tsx` already supplies one `{ Component, Toolbox, Tabs, StatusFields }` entry per modality, consumed by `WorkspaceEngine`, `DatasetSidebar`, `PropertiesPanel`, and `WorkspaceHeader` — this is the seam Phase 022 already established for adding cross-cutting, modality-neutral surface without a `switch(modality)` anywhere else. The Properties Panel already has a tab strip (`description | labels | shapes | assets` for IMAGE) that is the natural home for a new review/history tab, and `WorkspaceHeader`'s shared status/save-state area (currently save/conflict indicator + per-engine `StatusFields`) is the natural home for the Submit/Approve/Reject action affordance and the current workflow-status badge.

**Decision**: Annotation Mode and Review Mode live inside the existing `/workspace/[datasetId]` shell via this registry — no `/review/...` route, no separate Review App. The Canvas component itself (`image-engine.tsx`, `video-engine.tsx`, `canvas-stage.tsx`) is untouched.

## 9. Keyboard shortcuts

Audited for any existing shortcut/keybinding manager: **none exists.** There is no global `keydown` listener, no tool-shortcut table, no hotkey dispatcher — only scattered per-`<input>` "Enter submits" handlers and one `Escape`-closes-menu listener in `workspace-header.tsx`. `Label.hotkey` is a stored field with no runtime consumer found.

**Decision**: because there is nothing to integrate with, and because inventing a full shortcut framework is explicitly out of scope for this phase, keyboard shortcuts for workflow actions are **P3, minimal-scope**: a small number of high-value bindings (Submit, Approve, Reject) behind one shared hook usable by both modes — not a parallel/standalone manager, and structured so a future shortcut system can absorb it rather than compete with it.

## 10. Authorization model

`apps/web/src/lib/authorization.ts` already has everything needed:

- `DatasetPermission` type + `DATASET_ROLE_PERMISSIONS` table, keyed by `DatasetMemberRole` (`OWNER: ["*"]`, `MANAGER`, `REVIEWER`, `LABELER`).
- `annotation.review` is already granted to `OWNER`, `MANAGER`, `REVIEWER` — **not** `LABELER`. This already expresses "annotators cannot review" with zero new code.
- `requireDatasetPermission` / `assertAnnotationPermission` already perform server-side dataset-scoped authorization (never client-trusted).

**Decision**: extend the same table with two workflow permissions (submit-for-review; review-decision) rather than a parallel authorization system:
- Submit-for-review: same tier as `annotation.create` (LABELER, MANAGER, REVIEWER, OWNER).
- Review-decision (Approve/Reject): same tier as the existing `annotation.review` (MANAGER, REVIEWER, OWNER — not LABELER).
- MANAGER/OWNER already sit at the review-decision tier, so "manager override" needs no new mechanism — it is already the existing permission shape.
- All transitions are enforced server-side using this table; the frontend only reflects it (hides/disables actions) for UX, never as the enforcement point.

## 11. State-transition matrix

| From | Action | To | Actor permission | Locking |
| --- | --- | --- | --- | --- |
| NEW / READY | Start | IN_PROGRESS | submit-for-review tier | none (first transition) |
| IN_PROGRESS | Save/autosave | IN_PROGRESS | (unchanged — not a transition) | `Annotation.revision` only |
| IN_PROGRESS | Submit | NEEDS_REVIEW | submit-for-review tier | `Asset.revision` |
| NEEDS_REVIEW | Open Review | *(no status change)* | review-decision tier | none (read-only) |
| NEEDS_REVIEW | Approve | REVIEWED | review-decision tier | `Asset.revision` |
| NEEDS_REVIEW | Reject (+ required feedback) | REJECTED | review-decision tier | `Asset.revision` |
| REJECTED | Start Rework | IN_PROGRESS | submit-for-review tier | `Asset.revision` |
| IN_PROGRESS (post-rework) | Resubmit | NEEDS_REVIEW | submit-for-review tier | `Asset.revision` |

Any transition attempted from a status not listed as its "From" (e.g. Approve on an asset that is `IN_PROGRESS`, or Submit on an asset already `REVIEWED`) MUST be rejected server-side as an invalid transition, distinct from a stale-revision conflict.

## 12. Comment/feedback decision

No `Comment`/`Feedback`/`Discussion`/`Thread` model exists anywhere in the schema or app code. **Decision**: review feedback is a field on the Reject transition's workflow-event record (§5) — required and non-empty when rejecting, optional/absent for every other transition. No threaded discussion, no standalone comment entity, no notification fan-out.

## 13. Single-review vs. bulk-review boundary

Phase 022's bulk asset-selection capability (`specs/022-asset-browser-dataset-management-workspace/`) is now implemented, including a generic bulk status-change action (see §15). **Decision**: Phase 023 still ships single-asset submit/review/approve/reject only — bulk *review decisions* (approve/reject many submissions in one action, with per-transition validation and history) are out of scope for this phase and left for a future phase, even though Phase 022's bulk primitives now exist. The one exception is the narrow §15 fix: workflow-governed statuses must stop being settable through Phase 022's generic (non-review-aware) bulk status action, which is an integrity fix, not a bulk-review feature.

## 14. Canvas regression boundary

Confirmed unchanged: Konva rendering (`canvas-stage.tsx`), drawing/editing tools, pan/zoom, annotation selection, per-annotation autosave, and `Annotation.revision` optimistic locking. The only touch point this phase requires inside the annotation-mutation code path is the `Asset.revision` bump described in §7 — an additive side effect inside the existing transaction, not a change to geometry logic, drawing interactions, or the Canvas component tree.

Existing regression-guard tests identified (must keep passing): `tests/workspace/annotation-locking.test.ts`, `tests/workspace/annotation-mutations.test.ts`, `tests/workspace/description-locking.test.ts`, `tests/workspace/autosave-state.test.ts`, `tests/workspace/image-navigation.test.ts`, `tests/workspace/asset-navigator-pagination.test.ts`, `tests/workspace/workspace-authorization.test.ts`, `tests/workspace/workspace-shell-boundary.test.ts`, `tests/annotation-api/*`, `tests/annotations/video-*`, `tests/auth-ownership/*`.

## 15. Discovered conflict: Phase 022's bulk status change bypasses workflow integrity

Phase 022 (Asset Browser) landed in the working tree during this audit (it was mid-implementation when audit began; it is now complete — see updated §16). Its bulk `CHANGE_STATUS` action (`changeStatusBulk` in `lib/assets/asset-bulk-service.ts`) is a raw, unconditional setter:

```
db.asset.updateMany({ where: { id: { in: assetIds }, datasetId }, data: { status } })
```

It accepts **any** `AssetStatus` value, requires only `dataset.update` permission (OWNER/MANAGER), performs **no transition validation** (any status → any status, including jumping straight to `REVIEWED` from `NEW`), touches **no revision field** (no optimistic lock, no staleness check), and records **no history entry**. This is a real, audit-discovered conflict, not a hypothetical one: left as-is, it lets a Manager/Owner silently bypass every guarantee Phase 023 makes about `Asset.status` (FR-004 invalid-transition rejection, FR-008/FR-009 revision guard, FR-017 history) for the exact same field.

**Decision**: Phase 023 MUST close this gap by scoping which statuses the generic bulk status-change capability may set, without touching Phase 022's browsing, filtering, labeling, assignment, deletion, or export behavior:

- The four workflow-governed values this feature introduces transitions for — `IN_PROGRESS`, `NEEDS_REVIEW`, `REVIEWED`, `REJECTED` — MUST become reachable **only** through this feature's governed transitions (Start/Submit/Approve/Reject/Start Rework/Resubmit), never through the generic bulk status-change action.
- The remaining values (`NEW`, `PROCESSING`, `READY`, `COMPLETED`, `SKIPPED`, `ARCHIVED`, `FAILED`) are unaffected and remain freely settable in bulk exactly as Phase 022 built them — these are operational/housekeeping states, not workflow states.

This is captured as FR-025 in `spec.md` and is the one place this feature reaches outside the workspace/canvas boundary into Phase 022's territory — narrowly, and only because the audit found it actively undermines this feature's own integrity requirements for a field both features share.

## 16. Unresolved / explicitly deferred (not invented)

- **Withdraw Submission**: no existing primitive (no unsubmit/withdraw action anywhere in the codebase), and the product-goal lifecycle diagram doesn't request it. **Marked out of scope**, not invented, per instruction.
- **Reviewer editing during review**: default-safe NO, consistent with "Review Mode renders no editing controls." If a future phase wants reviewers to fix minor issues inline, that is a new decision, not a default of this phase.
- **Whether `IN_PROGRESS` should be split into an "authoring" vs. "reworking" sub-state** for reporting purposes: no existing signal needs this distinction (the workflow-event log already records whether the transition into `IN_PROGRESS` came from `Start` or `Start Rework`), so no additional status value is introduced. **Requires stakeholder decision** only if future reporting needs a persisted (not event-derived) distinction.
- **Reconciling the dead per-Annotation review primitive** (`AnnotationStatus` review values, `Annotation.reviewedById`, `reviewAnnotationAction`): left untouched. **Requires stakeholder decision** on whether to remove it in a later cleanup phase; Phase 023 does not depend on or extend it.

## 17. Final concurrency decision: stale review decisions are an explicit API contract

**Decision**: `STALE_REVISION` is the required conflict response for every state-changing workflow action submitted with an old `Asset.revision`; for reviewer `APPROVE` and `REJECT` it is the primary, non-negotiable outcome. The workflow service compares revision before classifying an invalid state transition, so a reviewer who loaded an older revision is told to reload even if the current state has also changed.

**Writer coverage**: the parent Asset revision must be atomically claimed/incremented in every successful reviewable annotation-set writer: image batch mutation, legacy image mutation path, video track/keyframe/temporal mutation paths, and worker AI prediction annotation writes where they alter a reviewable Asset. The increment is performed in the same Prisma transaction before child writes; a failed child optimistic-lock write rolls it back. This avoids the race where a reviewer could approve while an annotation write is in flight. Server-side mutation eligibility also prevents a delayed annotation write from committing after the workflow has moved an Asset into a non-editable state.

**Bulk-status integrity**: Phase 022's generic bulk status path must reject a request when it targets a workflow-governed value *or* tries to clear an Asset already in one of those values. It must not partially update a mixed selection. Operational status changes remain available for Assets outside the governed workflow states.

**Alternatives considered**: a separate review-version column or an annotation-set checksum. Rejected: both add a second concurrency authority while `Asset.revision` already exists and is proven for optimistic updates. A post-write asynchronous revision bump was also rejected because it leaves a window in which a stale reviewer decision can succeed.
