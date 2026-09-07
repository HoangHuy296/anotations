# Feature Specification: Annotation & Review Workflow

**Feature Branch**: `023-annotation-review-workflow`

**Created**: 2026-08-27

**Status**: Draft

**Input**: User description: "Evolve the existing per-asset annotation editor (Annotate → Save → Autosave) into a governed annotation workflow: Annotate → Submit for Review → Review (Approve / Reject) → Rework → Resubmit → Review again, built as orchestration around the existing modality engines without redesigning them." Grounded in a full codebase audit — see `research.md` in this directory for the resolved architectural decisions this spec relies on.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Annotate and Submit for Review (Priority: P1)

A Labeler opens an asset that has never been worked on, begins drawing/labeling annotations exactly as they can today, and — once they consider the work ready — submits the asset for review instead of leaving it in an ambiguous "done" state that only they know about.

**Why this priority**: Without a submit step, review has nothing to act on. This is the foundation every other story depends on, and it must not disturb the existing, already-trusted editing/autosave behavior.

**Independent Test**: Starting from a never-annotated asset, a Labeler can draw/edit annotations (autosave behaving exactly as before), then submit the asset for review, and the asset moves to a review-ready state visible to reviewers — with no change to how annotation edits are saved.

**Acceptance Scenarios**:

1. **Given** an asset with no annotation work started, **When** a Labeler begins editing it, **Then** the asset's workflow state reflects that work is in progress.
2. **Given** an asset a Labeler has been editing, **When** they trigger autosave or manual save, **Then** the save behaves exactly as it does today and does NOT by itself change the asset's workflow state.
3. **Given** an asset in an editable workflow state, **When** an authorized Labeler submits it for review, **Then** the asset moves to a review-ready state and is no longer silently editable as "in progress" work.
4. **Given** an asset already in a review-ready or later state, **When** a user attempts to submit it again, **Then** the system rejects the duplicate submission rather than creating a second, ambiguous review-ready state.
5. **Given** an asset with zero annotations, **When** a user attempts to submit it, **Then** the system defines and enforces a clear, consistent rule for whether an empty submission is allowed (see Edge Cases).

---

### User Story 2 - Review Submitted Annotation (Priority: P1)

A Reviewer opens a review-ready asset, inspects its current annotations using the same viewing surface annotators use, and records a decision: approve the work, or reject it with feedback describing what needs to change.

**Why this priority**: This is the other half of the MVP — submission without a trustworthy decision step delivers no value. It must guarantee a reviewer can never approve or reject data that has since changed underneath them.

**Independent Test**: A Reviewer can open a review-ready asset, view its annotations without being able to edit them, and either approve it (asset becomes approved) or reject it with required feedback (asset becomes rejected, feedback is stored and visible) — using only server-enforced transitions.

**Acceptance Scenarios**:

1. **Given** a review-ready asset, **When** an authorized Reviewer opens it for review, **Then** they see its current annotations read-only, with no geometry-editing controls available to them in that mode.
2. **Given** a review-ready asset a Reviewer is inspecting, **When** they approve it, **Then** the asset moves to an approved state and the decision is recorded with the reviewer's identity and timestamp.
3. **Given** a review-ready asset a Reviewer is inspecting, **When** they reject it without providing feedback, **Then** the system rejects the action and requires non-empty feedback before the rejection can be recorded.
4. **Given** a review-ready asset a Reviewer is inspecting, **When** they reject it with feedback, **Then** the asset moves to a rejected state and the feedback is stored and later visible to the annotator.
5. **Given** a Reviewer has loaded a review-ready asset, **When** the annotator changes that asset's annotations before the Reviewer's decision is submitted, **Then** the Reviewer's approve/reject action is rejected as stale rather than silently applied, and the Reviewer is required to reload the current state before deciding again.
6. **Given** a user without review authorization for the dataset, **When** they attempt to approve or reject an asset, **Then** the action is rejected server-side regardless of what the client UI shows.

---

### User Story 3 - Rework and Resubmit (Priority: P2)

An annotator whose submitted work was rejected returns to the asset, sees the reviewer's feedback, corrects the annotations, and resubmits — without losing any prior annotation data or the record of what happened.

**Why this priority**: Closes the loop the product goal describes (Reject → Rework → Resubmit → Review again). Depends on US1 and US2 existing first.

**Independent Test**: Starting from a rejected asset with reviewer feedback attached, an authorized annotator can move it back to an editable state, see the feedback, edit its annotations, and resubmit it to a review-ready state — with the asset's annotation data and workflow history intact throughout.

**Acceptance Scenarios**:

1. **Given** a rejected asset, **When** an authorized annotator starts rework, **Then** the asset returns to an editable workflow state and its existing annotations remain exactly as they were, unmodified by the transition itself.
2. **Given** a rejected asset an annotator has reopened, **When** they view it, **Then** the reviewer's rejection feedback is visible to them.
3. **Given** an asset back in an editable state after rejection, **When** the annotator edits and then resubmits it, **Then** it returns to the review-ready state and can be reviewed again through the same decision flow as any other submission.
4. **Given** a rejected asset, **When** an unauthorized user attempts to start rework on it, **Then** the action is rejected server-side.

---

### User Story 4 - Workflow History and Feedback (Priority: P2)

Anyone authorized to view an asset can see the ordered sequence of everything that has happened to it in the review workflow: who submitted, who opened review, who approved or rejected (and why), who reworked, and who resubmitted.

**Why this priority**: Without visible history, rejection feedback and workflow accountability are lost the moment the UI moves on. This depends on submission and review (US1/US2) existing to have anything to show.

**Independent Test**: After a submit → reject → rework → resubmit → approve sequence on one asset, an authorized user can view an ordered list of every transition showing the actor, action, timestamp, prior state, resulting state, and any feedback attached to it, with nothing missing or out of order.

**Acceptance Scenarios**:

1. **Given** an asset that has gone through submit, reject, rework, resubmit, and approve, **When** an authorized user views its workflow history, **Then** every one of those transitions appears in chronological order with actor, action, timestamp, and before/after state.
2. **Given** a rejection with feedback, **When** the workflow history is viewed, **Then** that feedback is attached to and visible on that specific rejection entry.
3. **Given** an asset with no workflow activity yet, **When** its workflow history is viewed, **Then** the system shows a clear empty state rather than an error.
4. **Given** the asset's annotation data changes through ordinary editing, **When** the workflow history is viewed, **Then** it shows only review-lifecycle transitions — it is never conflated with, or used to reconstruct, annotation-geometry edit history.

---

### User Story 5 - Workflow Permissions and Integrity (Priority: P1)

Regardless of what any client sends, the system never allows a workflow action that the acting user isn't authorized for, that isn't a valid transition from the asset's current state, or that acts on data staler than what the actor last saw.

**Why this priority**: This is the safety net for every other story — without it, the workflow's guarantees are cosmetic. It must hold from the very first story onward, which is why it shares P1.

**Independent Test**: Attempts to (a) perform a workflow action without the required role, (b) perform a workflow action that is not a valid transition from the asset's current state, and (c) perform an approve/reject/submit using a stale revision, are each independently rejected server-side with no change to the asset's stored state or annotation data.

**Acceptance Scenarios**:

1. **Given** a user with only annotator-tier permission, **When** they attempt to approve or reject an asset, **Then** the system rejects the action server-side even if the request bypasses the UI.
2. **Given** an asset in an approved state, **When** any user attempts to approve or reject it again without an intervening rework/resubmit, **Then** the system rejects the action as an invalid transition.
3. **Given** a user attempting a workflow action on an asset outside their authorized dataset, **When** the request is made directly against the backend, **Then** it is rejected exactly as if the asset did not exist.
4. **Given** a workflow action submitted with a revision older than the asset's current revision, **When** it is processed, **Then** it is rejected as a conflict and no state is changed.
5. **Given** a rejected workflow action of any kind, **When** it fails, **Then** the asset's annotation data is left completely unmodified.

---

### User Story 6 - Keyboard Workflow (Priority: P3)

A user working through many assets can trigger the workflow actions available to them (submit, approve, reject, next/previous asset) from the keyboard, without those keys doing something unexpected while they are actively drawing or editing.

**Why this priority**: A pure efficiency improvement on top of a working, mouse-driven workflow (US1–US5). Lowest priority because the underlying actions must exist and be correct before shortcuts to trigger them matter.

**Independent Test**: An authorized user can trigger each workflow action available to their current role and mode via a documented keyboard shortcut, and those shortcuts have no effect (or a clearly inert effect) when the user's role or the asset's current state does not permit that action.

**Acceptance Scenarios**:

1. **Given** an annotator with an asset in an editable state, **When** they use the submit shortcut, **Then** the same submission behavior as the on-screen action occurs.
2. **Given** a reviewer inspecting a review-ready asset, **When** they use the approve or reject shortcut, **Then** the same behavior as the on-screen action occurs (reject still requires feedback before completing).
3. **Given** a user without permission for an action, **When** they press that action's shortcut, **Then** nothing happens beyond, at most, a visible "not permitted" indication — no server mutation is attempted.
4. **Given** a user actively drawing or editing an annotation, **When** they press a key already meaningful to that editing interaction, **Then** the existing editing behavior takes precedence and no workflow shortcut is triggered.

---

### Edge Cases

- **Empty submission**: an asset with zero annotations MUST be handled by one clear, consistently-enforced rule (either: submission is blocked until at least one annotation exists, or: submission is allowed and an empty annotation set is a legitimate reviewable outcome) — the system MUST NOT behave inconsistently between these two outcomes. *(See Assumptions for the default chosen.)*
- **Concurrent submit**: what happens if two authorized annotators attempt to submit the same asset at nearly the same time? Exactly one submission MUST succeed; the other MUST fail as an invalid-transition or stale-revision conflict, never as a silent double-submit.
- **Reviewer and annotator are the same person**: if a user holds both submit-for-review and review-decision permission on a dataset, what stops them from approving their own submission? The system MUST still enforce all standard transition/permission checks; whether self-review is additionally blocked is a policy decision recorded in Assumptions, not left ambiguous.
- **Asset deleted mid-review**: what happens if an asset is deleted (per existing dataset/asset deletion behavior) while it is in a review-ready or in-review state? Any pending workflow action against it MUST fail as not-found, never partially apply.
- **Rejection with no subsequent rework**: a rejected asset MUST remain queryable/visible indefinitely in its rejected state with its feedback intact; rejection MUST NOT be an implicit deletion or archival of the asset or its annotations.
- **Resubmission identical to the rejected version**: if an annotator resubmits without changing any annotation, the system MUST still accept the resubmission as a valid transition (the workflow does not enforce that content must differ, only that the transition itself is valid and non-stale).
- **Existing image/video/audio/text engines**: none of the above changes any per-modality editing, drawing, pan/zoom, or autosave behavior for any modality — Edge Cases here concern the workflow layer only.
- **Generic bulk/administrative status changes**: a dataset manager using an existing general-purpose bulk status-change capability (unrelated to this feature) MUST NOT be able to force an asset directly into, or out of, this feature's workflow-governed states — doing so would silently bypass every transition, permission, revision, and history guarantee this feature defines for those same states (see FR-025).

## Requirements *(mandatory)*

### Functional Requirements

**Workflow state and transitions**

- **FR-001**: The system MUST represent every Asset's annotation-workflow state using the Asset's existing lifecycle status concept — not a new, separate, parallel status model — with distinct values for: not yet started, in progress, submitted/awaiting review, approved, and rejected.
- **FR-002**: The system MUST support exactly these annotator-initiated transitions, each independently authorized and validated server-side: Start (not-yet-started → in progress), Submit (in progress → awaiting review), Start Rework (rejected → in progress), and Resubmit (in progress → awaiting review).
- **FR-003**: The system MUST support exactly these reviewer-initiated actions, each independently authorized and validated server-side: Open Review (a read/inspection action on an awaiting-review asset that changes no state), Approve (awaiting review → approved), and Reject (awaiting review → rejected).
- **FR-004**: The system MUST reject, server-side, any attempted transition that does not match the Asset's actual current workflow state (an invalid transition), independent of and distinguishable from a stale-revision conflict.
- **FR-005**: Rejecting an asset MUST require non-empty feedback text describing what needs to change; the system MUST refuse to record a rejection without it.
- **FR-006**: "Reject" and "Request Changes" MUST be treated as the same transition and the same resulting state — the system MUST NOT introduce a second, separate rejection-like state.
- **FR-007**: Ordinary annotation save/autosave MUST NOT itself change an Asset's workflow state; only the explicit transitions in FR-002/FR-003 change workflow state.

**Concurrency and integrity**

- **FR-008**: Every workflow-state-changing action (Submit, Approve, Reject, Start Rework, Resubmit) MUST be guarded by the same kind of revision check the platform already uses for other optimistic-locking (i.e., an actor's action MUST be evaluated against the Asset's revision as the actor last observed it) and MUST fail as a conflict — with no partial or silent effect — if the Asset has changed since.
- **FR-009**: A change to an Asset's annotation set (creating, updating, or deleting an annotation on it) MUST be treated as changing that Asset's revision for the purposes of FR-008, so that a Reviewer's Approve or Reject can never succeed against annotation data older than what the Reviewer actually reviewed.
- **FR-010**: A failed or rejected workflow action (invalid transition, unauthorized, or stale-revision) MUST leave the Asset's stored workflow state and its annotation data completely unchanged.
- **FR-011**: The existing per-annotation autosave and optimistic-locking contract (independent revision tracking on each Annotation) MUST continue to function exactly as it does today, unaffected by workflow-state changes.

**Authorization**

- **FR-012**: The system MUST authorize every workflow-state-changing action server-side using the dataset's existing role/membership model; no workflow action may be enforced only in the browser.
- **FR-013**: Users without review-decision authorization for a dataset MUST NOT be able to Approve or Reject assets in that dataset, regardless of what a client request contains.
- **FR-014**: Users without submit-for-review authorization for a dataset MUST NOT be able to Start, Submit, Start Rework, or Resubmit assets in that dataset.
- **FR-015**: A workflow action targeting an asset outside the acting user's authorized dataset scope MUST be rejected identically to a request for a non-existent asset.
- **FR-016**: While inspecting an asset in Review mode, a Reviewer MUST NOT be able to create, edit, or delete that asset's annotations through that surface.

**History and feedback**

- **FR-017**: The system MUST record every workflow transition (including Open Review) as an ordered, append-only history entry capturing at minimum: the acting user, the action taken, the prior and resulting workflow state, the time it occurred, and any feedback text attached to it.
- **FR-018**: Authorized users MUST be able to view an asset's complete workflow history in chronological order.
- **FR-019**: Rejection feedback MUST be retrievable from an asset's workflow history and MUST remain associated with the specific rejection it was given for.
- **FR-020**: Workflow history MUST remain a distinct concept from annotation-geometry edit history — the system MUST NOT merge, alias, or reconstruct one from the other.

**Workspace integration and Canvas boundary**

- **FR-021**: All workflow UI (submit/approve/reject controls, workflow-status display, workflow history, review feedback) MUST be delivered inside the existing single workspace surface used for annotation today — the system MUST NOT introduce a separate review application or a separate top-level route for review.
- **FR-022**: The existing annotation Canvas — rendering, drawing/editing interactions, pan/zoom, annotation selection, per-annotation autosave, and existing optimistic-locking behavior, for every modality that has it today — MUST behave exactly as it does today. This feature MUST NOT redesign, replace, or duplicate that behavior.
- **FR-023**: Every existing automated test protecting annotation editing, autosave, per-annotation optimistic locking, asset navigation, and dataset/workspace authorization MUST continue to pass unmodified in its expected behavior after this feature ships.
- **FR-024**: The current asset-status values used for filtering/browsing assets (introduced independently of this feature) MUST continue to mean exactly what they mean today; this feature MUST NOT redefine, repurpose, or add a competing meaning to any status value already in use elsewhere in the product.
- **FR-025**: Any general-purpose, non-review-aware capability elsewhere in the product that can set an asset's status directly (e.g., an administrative bulk status-change action) MUST NOT be able to set or clear this feature's workflow-governed states (in progress, awaiting review, approved, rejected) — those values MUST become reachable only through this feature's own validated, authorized, revision-guarded transitions. Status values this feature does not govern remain unaffected and MUST continue to work exactly as they do today.

**Keyboard shortcuts**

- **FR-026**: The system MUST provide keyboard shortcuts for, at minimum, Submit, Approve, and Reject, each usable only when the acting user's role and the asset's current state permit that action.
- **FR-027**: A workflow keyboard shortcut MUST NOT trigger, or MUST be suppressed, while the user is actively engaged in an annotation-editing interaction where the same key already has an existing meaning.
- **FR-028**: A workflow keyboard shortcut MUST have no server-side effect when the acting user lacks permission for that action — pressing it MUST behave identically to attempting the action through the UI while unauthorized.

### Key Entities

- **Asset**: The existing central entity. Gains no new fields at the specification level beyond continuing to carry its own workflow status (from FR-001) and revision (used for FR-008/FR-009). Its workflow status and its existing annotation/job/AI-task-status concepts remain distinct — changing one is never observed to change another.
- **Annotation**: The existing geometry/label record attached to an Asset. Continues to autosave and optimistic-lock exactly as today (FR-011). Its own status/authoring fields are not the review-workflow driver in this feature; annotations on an Asset collectively share that Asset's workflow state.
- **Workflow History Entry**: A new, minimal, append-only record of one workflow transition (or the Open Review inspection action) on one Asset: actor, action, prior state, resulting state, timestamp, and optional feedback text (required and non-empty for Reject). This is the sole new persisted concept this feature introduces; it is not a general-purpose comment thread and not an annotation-data revision history.
- **Dataset Member / Role**: The existing membership and role model, extended only in what it authorizes (two workflow-permission tiers — submit-for-review and review-decision — layered onto the existing role table), not in its shape.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An authorized annotator can take a never-annotated asset through Start → edit/autosave → Submit without any change in the autosave behavior they experience today.
- **SC-002**: An authorized reviewer can process a submitted asset to either Approved or Rejected (with feedback) using only actions the system allows for their role and the asset's current state.
- **SC-003**: 100% of attempted workflow actions that are unauthorized, invalid for the asset's current state, or based on a stale revision are rejected server-side with no change to stored workflow state or annotation data, across repeated adversarial attempts.
- **SC-004**: A rejected asset can be rewritten and resubmitted, and reviewed again to a final Approved or Rejected outcome, without any loss of prior annotation data or any gap in its recorded workflow history.
- **SC-005**: 100% of an asset's workflow transitions (submit, open review, approve, reject, start rework, resubmit) are visible, in order, with correct actor/timestamp/state/feedback, to every user authorized to view that asset.
- **SC-006**: 100% of existing annotation editing, autosave, per-annotation optimistic-locking, and dataset/workspace authorization tests continue to pass unmodified after this feature ships.
- **SC-007**: A reviewer can never successfully approve or reject an asset whose annotation content changed after the reviewer last loaded it — verified by deliberately racing an annotator's edit against a reviewer's pending decision.
- **SC-008**: Every keyboard shortcut introduced by this feature performs identically to its on-screen equivalent, and produces no effect when the acting user or asset state does not permit the underlying action.

## Assumptions

- **Empty submission**: an asset with zero annotations MAY be submitted for review; the workflow treats "reviewed and found to need no annotations" as a legitimate, representable outcome. This is a policy default chosen because no existing validation rule requires a non-zero annotation count for any other asset-status transition; it should be confirmed with stakeholders if a dataset actually requires at least one annotation before submission.
- **Self-review**: a user who holds both submit-for-review and review-decision permission on a dataset (e.g., a Manager or Owner who also authors annotations) is not blocked from approving or rejecting their own submitted work. This matches the existing permission model, where `MANAGER`/`OWNER` already hold every relevant permission; introducing a same-actor restriction would be a new authorization concept this phase does not add.
- **Reviewable unit**: review applies to an Asset and its entire current annotation set as a whole, not to individual annotations. A dormant, unused per-Annotation review primitive already exists in the schema (separate annotation-level status/review fields and a disconnected review action) and is left exactly as-is; this feature does not repurpose, wire up, or remove it.
- **Manager/Owner override**: no separate "override" action is introduced. Because `MANAGER` and `OWNER` already carry review-decision-tier permission in the existing role table, they can already act as reviewers on any submission using the same Approve/Reject actions as a dedicated Reviewer — no additional capability is added on top of that.
- **Existing asset-status values used for browsing/filtering** (introduced independently of this feature) retain their current meaning; this feature's transitions are additive uses of that same status concept, not a redefinition of it.
- **Single-asset scope**: this feature operates on one asset at a time. Bulk submit/approve/reject is not available even where a multi-asset selection capability exists elsewhere in the product.
- **Workflow history retention**: workflow history is retained indefinitely alongside its Asset, with no automatic pruning or expiry defined by this feature.

## Out of Scope

The following are explicitly excluded from this feature:

- New annotation geometry types or new modality/annotation engines.
- Any change to Canvas rendering, drawing/editing interactions, pan/zoom, or annotation selection behavior for any modality.
- Reviewer-side editing of annotations (Review mode is inspect/approve/reject/feedback only).
- A full collaboration system, task assignment management, or reviewer/annotator workload distribution.
- Annotator agreement metrics, annotation quality scoring, or reviewer quality scoring.
- AI-assisted review or AI-assisted correction of annotations.
- Bulk approve/reject of multiple assets in a single action.
- Withdraw Submission (returning a submitted asset to editable state without a reviewer's rejection) — no existing behavior supports this and it is not added by this feature.
- Threaded discussion/comment systems beyond the single feedback field attached to a rejection.
- Any notification system (in-app, email, or chat/Slack-style) triggered by workflow events.
- A separate review application or a separate top-level route outside the existing workspace.
- Binary dataset export of any kind.
- Any change to the existing Asset Browser / bulk asset-selection capability's browsing, filtering, labeling, assignment, deletion, or export behavior. (The one narrow exception is FR-028: preventing that capability's generic status-change action from bypassing this feature's workflow guarantees — an integrity boundary of this feature, not a redesign of Asset Browser functionality.)
- Reconciling, repurposing, or removing the existing (unused) per-Annotation review fields and action described in the Assumptions section.
