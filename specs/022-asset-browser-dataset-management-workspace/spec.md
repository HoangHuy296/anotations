# Feature Specification: Asset Browser & Dataset Management Workspace

**Feature Branch**: `022-asset-browser-dataset-management-workspace`

**Created**: 2026-08-27

**Status**: Draft

**Input**: User description: "022-asset-browser-dataset-management-workspace — elevate Dataset and Asset management from database + basic browsing into a reusable Asset Browser capability (Discover → Inspect → Select → Organize → Act) inside the existing Properties Panel / Properties Tabs / Workspace Toolbox, without changing the annotation Canvas."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Discover and inspect assets in a large dataset (Priority: P1)

A labeler or dataset manager opens a dataset with thousands of assets and needs to find a specific subset — e.g. all IMAGE assets with status "Needs Review" updated in the last week — without scrolling through every asset or waiting for the whole dataset to load. They search, filter, and sort the asset list, then click an asset to inspect its modality-specific details without leaving the workspace.

**Why this priority**: This is the foundation every other capability in this phase builds on. Without reliable discovery, selection and bulk actions have nothing meaningful to act on. It also stands alone as a real improvement over today's filename-only, single-status browsing.

**Independent Test**: Can be fully tested by opening a dataset, combining search text with modality/status/label/date filters and a sort order, confirming the result set and pagination are correct, and confirming clicking a result shows that asset's details — with no selection or bulk-action capability required.

**Acceptance Scenarios**:

1. **Given** a dataset with more assets than one page holds, **When** the user enters search text, **Then** only matching assets are shown and paging controls reflect the filtered count.
2. **Given** a dataset with assets of mixed modality, status, and labels, **When** the user applies modality, status, and label filters together, **Then** only assets matching every active filter are shown.
3. **Given** an active search/filter/sort combination, **When** the user pages forward and back, **Then** the same query keeps producing consistent, stable results.
4. **Given** a result set, **When** the user opens an asset, **Then** the details shown match that asset's modality (image, video, audio, or text) and reflect its current data.

---

### User Story 2 - Select assets and organize them in bulk (Priority: P2)

A dataset manager narrows the asset list to a meaningful subset (e.g. all unlabeled IMAGE assets) and needs to act on many of them at once: tag them with a label, correct their status, or note who should work on them — without opening each asset individually.

**Why this priority**: Bulk organization is the core new value this phase delivers on top of discovery. It depends on User Story 1's query/selection foundation but is independently demonstrable once selection exists.

**Independent Test**: Can be fully tested by selecting a mix of individually-chosen assets and a "select all matching the current filter" selection, applying a label add/remove and a status change to each, and confirming only the selected assets were affected, with a clear success/failure summary shown.

**Acceptance Scenarios**:

1. **Given** a filtered result set of 2,000+ assets, **When** the user chooses "select all filtered", **Then** the interface reports the full matching count as selected without the browser having to load every asset record.
2. **Given** a selection of assets, **When** the user adds a label to the selection — choosing an existing dataset label or creating a new one with a name and color — **Then** the label appears as metadata on each selected asset, any newly created label follows the same naming/color/uniqueness rules as the existing Labels tab, and no new annotation is created on any selected asset.
3. **Given** a selection of assets where some have annotations using a label, **When** the user removes that label from the assets, **Then** the user is warned that existing annotations are not affected, and after confirming, the label is removed from asset metadata only while annotations remain unchanged.
4. **Given** a selection of assets, **When** the user changes their asset status, **Then** only asset-level status changes — annotation status, review status, job status, and AI status for those assets are untouched.
5. **Given** any selection (filtered or explicit), **When** the user changes only the sort order (no change to search or filter), **Then** the selection's membership and selected count remain exactly unchanged — sort never affects which assets are selected, only the order they're displayed in.
6. **Given** a "select all filtered" selection, **When** the user changes search or filter criteria, **Then** the selection automatically re-represents the new query and the displayed count updates to match, with a visible indication that the selection's scope changed.
7. **Given** an explicit (individually-chosen) selection, **When** the user changes search or filter criteria such that some selected assets no longer appear in the visible list, **Then** those assets remain selected and counted, and the interface distinguishes "currently visible and selected" from "selected but hidden by the current filter."
8. **Given** a selection and an intent to assign it to a person, **When** the user opens the assign action, **Then** the interface presents an assignment entry point even if full assignment workflows are limited, and does not apply the action to assets outside the current selection.

---

### User Story 3 - Safely delete assets in bulk (Priority: P3)

A dataset manager removes assets that were imported by mistake or are no longer needed, selecting many at once, with confidence that unrelated data and storage will never be affected.

**Why this priority**: Deletion is high-value but higher-risk than organization actions, and depends on User Stories 1–2's discovery/selection foundation.

**Independent Test**: Can be fully tested by selecting a batch of assets, confirming the delete warning, executing the delete, and verifying the assets disappear from the dataset while assets outside the selection and their storage objects remain fully intact — including for another user's concurrently-referenced assets.

**Acceptance Scenarios**:

1. **Given** a selection of assets belonging to the user's authorized dataset, **When** the user requests deletion, **Then** they are shown a confirmation describing what will happen before anything is removed.
2. **Given** a confirmed deletion, **When** the operation completes, **Then** the deleted assets no longer appear in the dataset and their record-level data is gone, even if any related storage cleanup is still finishing in the background.
3. **Given** a large deletion request, **When** it exceeds the immediate-processing threshold, **Then** the user is informed the operation will run in the background and can check on its outcome.
4. **Given** an asset outside the requesting user's authorized dataset scope, **When** included in a manipulated or malformed request, **Then** the system rejects it and does not delete it.
5. **Given** a deletion is retried after a partial failure, **When** it runs again, **Then** already-deleted assets are handled safely without errors or duplicate side effects.

---

### User Story 4 - Export the current selection's metadata (Priority: P4)

A dataset manager selects a meaningful subset of assets and exports their metadata and annotations for use outside the platform (e.g. a partner deliverable), without exporting the entire dataset or any binary files.

**Why this priority**: Valuable but narrower in audience than organize/delete; depends on selection from User Story 1–2.

**Independent Test**: Can be fully tested by selecting a subset of assets, running "Export Selected", and confirming the resulting output contains exactly the selected assets' metadata and annotations, contains no binary content, and that the existing full-dataset export is unaffected by this action.

**Acceptance Scenarios**:

1. **Given** a selection of assets, **When** the user runs "Export Selected", **Then** the exported output includes those assets' metadata, labels, and annotation records and excludes any image/video/audio binary content.
2. **Given** a "select all filtered" selection spanning thousands of assets, **When** the user exports it, **Then** the export completes without the browser downloading every asset record first.
3. **Given** an existing full-dataset export capability, **When** a user runs "Export Selected" instead, **Then** the full-dataset export's behavior and output are unaffected.

---

### User Story 5 - Understand dataset health and progress at a glance (Priority: P5)

A dataset manager opens a dataset's overview to understand its overall state: how many assets it has by modality, how annotation work is progressing, and whether there are any data integrity problems (missing files, failed imports) needing attention.

**Why this priority**: Valuable management/reporting capability, but depends on nothing else in this phase and delivers value on its own once asset data exists.

**Independent Test**: Can be fully tested by opening a dataset's overview and confirming displayed counts, modality breakdown, progress, and health signals match the dataset's actual known state, including a dataset deliberately seeded with a missing-storage-reference asset.

**Acceptance Scenarios**:

1. **Given** a dataset with assets across multiple modalities, **When** the user opens the dataset overview, **Then** they see total asset count, per-modality counts, annotation progress, and created/updated timestamps.
2. **Given** a dataset containing an asset with a missing or invalid storage reference, **When** the user views dataset health, **Then** that issue is surfaced as a data-integrity signal.
3. **Given** a dataset with no data-integrity problems, **When** the user views dataset health, **Then** no annotation-quality-style metrics (e.g. annotator agreement, review acceptance rate) appear — only integrity/operational signals.

---

### Edge Cases

- What happens when a user's search/filter query matches zero assets? The result area must clearly communicate "no matches" rather than appearing broken or empty-by-error.
- What happens when a bulk action is submitted, the query it depends on is still valid, but by execution time some matched assets have been deleted or changed by another user? The result summary must report those as skipped/failed rather than silently succeeding on fewer items than expected.
- What happens when a user tries to run two bulk actions on overlapping selections concurrently? The system must not apply an action against stale selection state from a completed or superseded action.
- What happens when a background bulk job (large delete or large export) fails partway through? The user must be able to see that it failed (not "stuck") and that partial progress is reported.
- What happens when a label targeted for bulk removal was already removed from some selected assets (e.g. by another user)? That asset is reported as skipped, not as a failure.
- What happens when a user tries to create a new label during "Add Label" whose name already exists in the dataset (case/whitespace-insensitive)? The system must reuse the existing label rather than creating a duplicate, consistent with existing label-creation uniqueness rules.
- What happens when storage cleanup for a deleted asset fails or storage is temporarily unavailable? The asset's removal from the dataset must not be blocked or rolled back; cleanup must be retryable independently.
- What happens if a user attempts to select assets or apply a bulk action outside a dataset they're authorized to access? The request must be rejected server-side regardless of what the client sends.
- What happens when a dataset has zero assets? Overview, counts, and health must show a valid empty state, not an error.
- What happens when an asset status change is requested to the asset's current status (no-op)? It must complete successfully without side effects, not be treated as an error.

## Requirements *(mandatory)*

### Functional Requirements

**Discovery**

- **FR-001**: Users MUST be able to search assets within a dataset by name/filename with results returned without loading the full dataset into the browser.
- **FR-002**: Users MUST be able to filter assets by modality, asset status, label, and created/updated date ranges, in combination with each other and with search.
- **FR-003**: Users MUST be able to filter assets by annotation status and by review-related state, using the dataset's existing status concepts rather than a new, separate parallel status model.
- **FR-004**: The system MUST provide an assignment-filtering entry point in the interface and API even where a complete assignment workflow is not part of this phase, so it can be extended later without rework.
- **FR-005**: Users MUST be able to sort the asset list by created date, updated date, and name/filename; sorting MUST work together with any active search, filters, pagination, and selection, and MUST NOT itself define or alter selection membership — changing sort order re-orders displayed results only, it never changes which assets match the current query or which assets are selected.
- **FR-006**: The asset list MUST be paginated at a fixed page size of 10 assets per page, server-enforced, with existing Previous/Next navigation continuing to work.
- **FR-007**: The system MUST enforce a maximum page size server-side; it MUST NOT allow a client to request an arbitrarily large page or unlimited results.

**Selection**

- **FR-008**: Users MUST be able to select an individual asset, select all assets currently visible on the page, and clear the current selection.
- **FR-009**: Users MUST be able to select all assets matching the current search/filter/sort query ("select all filtered"), including when the matching count is far larger than one page.
- **FR-010**: "Select all filtered" MUST NOT require downloading every matching asset's record to the browser; the system MUST resolve which assets match, and act on them, without full-dataset transfer to the client.
- **FR-011**: The interface MUST clearly display selection state at all times: no selection, an explicit count of individually selected assets, or "all N matching assets selected" for a filtered selection.
- **FR-012**: Selection state MUST persist across pagination within the same query (navigating pages must not silently lose a user's selections).
- **FR-013**: Selection reconciliation on query change MUST follow one predictable rule per selection mode, and sort order is never part of what defines selection membership:
  - **Filtered selection** ("select all filtered"): when search or filter criteria change, the selection automatically re-represents "everything matching the new search/filter," and the displayed selected count updates immediately to reflect it. This is expected behavior, not data loss, and the interface must make the scope change visible (e.g. the count changing).
  - **Explicit selection** (individually chosen assets): when search or filter criteria change, previously selected assets remain selected even if some no longer appear in the current result list. The selected count MUST continue to reflect the true full selection, and the interface MUST distinguish assets that are both selected and currently visible from ones that are selected but currently hidden by the active filter.
  - **Sort order**: changing sort alone, with no change to search or filter, MUST NOT alter the membership of either a filtered or explicit selection under any circumstance — it only reorders how the (unchanged) result set is displayed.
  - In no case does changing the query ever silently clear or silently narrow a selection without this being visible to the user.

**Bulk organization**

- **FR-014**: Users MUST be able to add a label to every asset in the current selection, recorded as metadata on the asset itself — not as a new annotation or geometry. Users MUST be able to choose an existing dataset label or create a new one (name and color) as part of this action, using the same naming/uniqueness rules as the dataset's existing label creation (no duplicate label per dataset by normalized name).
- **FR-015**: Users MUST be able to remove a label from every asset in the current selection, affecting asset metadata only; this action MUST NOT delete or modify the Label itself, only its association with the selected assets.
- **FR-016**: Before removing a label, if any selected asset has annotations that reference that label, the system MUST warn the user that annotations will not be modified or deleted, and require confirmation before proceeding.
- **FR-017**: Users MUST be able to change the asset-level status of every asset in the current selection. The following status concepts MUST remain distinct and MUST NOT be merged, aliased, or driven off one another by this feature:
  1. **Asset status** — lifecycle/operational state of the Asset itself (what this action changes; review-related states such as "needs review" / "reviewed" / "rejected" are represented as values within Asset status, per the Assumptions below, not as a separate status).
  2. **Annotation status** — completion state of an individual Annotation.
  3. **Job status** — background processing state of a Job.
  4. **AI task status** — state of an AI provider task.
  Changing Asset status via this action MUST leave Annotation status, Job status, and AI task status for the affected assets completely unchanged.
- **FR-018**: The system MUST provide an assign-to-user action entry point operating on the current selection, reusing existing dataset membership/role concepts where applicable, without requiring a full collaboration/assignment system to exist yet.
- **FR-019**: Every bulk organization action MUST be safe to retry: repeating an already-applied action (e.g. adding a label already present, removing one already absent, setting a status already set) MUST NOT create duplicates or corrupt state.

**Bulk deletion**

- **FR-020**: Users MUST be able to delete every asset in the current selection from its dataset.
- **FR-021**: The system MUST verify, server-side, that the requesting user is authorized for the target dataset and that every asset being deleted actually belongs to it — regardless of what the client submits.
- **FR-022**: Record-level deletion MUST succeed independent of whether related storage cleanup succeeds immediately; storage cleanup MAY complete asynchronously and MUST be retryable.
- **FR-023**: The system MUST NOT delete a storage object that is still referenced by any active database record, and MUST err toward not deleting when reference status is uncertain.
- **FR-024**: Deletions exceeding a defined size threshold MUST run as a background operation, with the user informed that it will run in the background rather than complete immediately.
- **FR-025**: Users MUST see a confirmation step describing the impact before a deletion is executed.

**Export Selected**

- **FR-026**: Users MUST be able to export the current selection's metadata, labels, and annotation records from the Workspace Toolbox, without exporting any binary asset content (image/video/audio files).
- **FR-027**: Export Selected MUST be presented and behave as distinct from the dataset's existing full-dataset export, and MUST NOT change that existing export's behavior, output, or availability.
- **FR-028**: Exports exceeding a defined size threshold MUST run as a background operation producing a downloadable result rather than returning a large payload synchronously.
- **FR-029**: Exporting a "select all filtered" selection MUST resolve the matching assets on the system side rather than requiring the browser to first collect every matching record.

**Item-level inspection**

- **FR-030**: Selecting any single asset MUST show that asset's modality-specific details (image, video, audio, or text), reusing the dataset's existing per-modality details presentation rather than a second, separate details system.
- **FR-031**: Audio and text assets MUST show real descriptive metadata (e.g. duration/format for audio; length/language for text, as available) rather than a placeholder with no asset-specific content; this MUST NOT include building new annotation-editing capability for those modalities.

**Dataset overview**

- **FR-032**: Users MUST be able to view, for a dataset: total asset count, per-modality asset counts, annotation count, annotation/completion progress, and created/updated timestamps.
- **FR-033**: Users MUST be able to view and, where already permitted by existing authorization rules, edit the dataset's description.
- **FR-034**: The system MUST surface data-integrity and operational health signals for a dataset (e.g. assets with missing/invalid storage references, failed imports, incomplete uploads) distinct from and never combined with annotation-quality-style metrics (annotator agreement, review acceptance rate, AI accuracy).

**Operation transparency**

- **FR-035**: Every bulk operation MUST report processed, succeeded, failed, and skipped counts to the user; partial failure MUST be visible, never silently hidden as full success.
- **FR-036**: After a successful bulk operation, the asset list, selection state, and dataset-level counts/progress MUST refresh to reflect the change — no stale rows or counts left visible.
- **FR-037**: The system MUST log key bulk-operation events (start, completion, partial failure, failure) with enough information to audit who did what to how many assets, without ever logging credentials, signed URLs, or sensitive asset content.

**Workspace boundary**

- **FR-038**: All new capability in this feature MUST be delivered within the existing Properties Panel, Properties Tabs, Workspace Toolbox, and dataset-level overview surfaces, and their supporting backend APIs.
- **FR-039**: The existing annotation canvas — rendering, drawing/editing interactions, pan/zoom, autosave, and optimistic-locking behavior for image and video — MUST behave exactly as it did before this feature, with no observable regression.

### Key Entities

- **Asset**: An imported item belonging to a Dataset with a modality (image/video/audio/text), a lifecycle status, storage references, and timestamps. Central subject of browsing, selection, and bulk actions in this feature. Its status is exclusively the Asset's own lifecycle state (review-related states included) — never a stand-in for Annotation, Job, or AI task status.
- **Dataset**: The container of Assets; source of aggregate counts, modality breakdown, progress, and health signals shown in the overview.
- **Label**: An existing, dataset-scoped, named and colored tag. This feature does not change how Labels are named, colored, or created — it adds one more way to attach an existing (or newly created, via the same rules) Label to an Asset.
- **Asset-Label attachment**: The association between an Asset and a Label, representing "this Label classifies this Asset" as metadata. It is created and removed independently of Annotations: attaching one never creates an Annotation, and removing one never deletes or alters an Annotation, even when an Annotation on that Asset happens to reference the same Label. How this association is modeled is left to the planning phase, but it MUST satisfy this invariant: a given Label may be attached to a given Asset at most once (no duplicate attachments), and a Label may only be attached to Assets within the same Dataset the Label belongs to.
- **Annotation**: An existing geometry/label record attached to an Asset, referenced (read-only, for warnings) by the label-removal flow in this feature but never created or altered by it.
- **Selection**: A user's current working set of Assets, expressed either as an explicit list of chosen Assets or as a saved search/filter query representing "everything currently matching" — sort order is display-only and never part of what a Selection matches.
- **Bulk Operation**: A single organize/delete/export action applied to a Selection, producing a processed/succeeded/failed/skipped result and, for large operations, running as a trackable background job.
- **Assignment (boundary only)**: A reference from a Selection/Asset to a responsible dataset member, exposed as an interface/API entry point in this feature; the full assignment workflow is out of scope.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can locate a specific subset of assets in a multi-thousand-asset dataset (by combining search, filters, and sort) in under 10 seconds of interaction, without the page loading the entire dataset.
- **SC-002**: A user can select "all assets matching the current filter" for a dataset with thousands of matching assets, and the selection is confirmed on-screen without a full-dataset download occurring.
- **SC-003**: A user can add or remove a label across 50+ selected assets in a single action and see a correct processed/succeeded/failed/skipped result within normal interactive response time.
- **SC-004**: Zero storage objects still referenced by an active asset are ever deleted as a result of a bulk delete operation, verified across repeated/retried delete attempts.
- **SC-005**: A user can export a selected subset of assets and receive metadata and annotations only — zero binary file bytes — in the exported output.
- **SC-006**: A dataset manager can determine a dataset's asset counts, modality mix, annotation progress, and any data-integrity issues from the dataset overview alone, without contacting engineering or querying the database directly.
- **SC-007**: 100% of existing image and video annotation workflows (draw, edit, pan/zoom, autosave, optimistic-locking conflict handling) continue to pass their existing tests unchanged after this feature ships.
- **SC-008**: No bulk operation ever reports "success" while silently failing to apply to part of the selection — every partial failure is visible in the operation result.
- **SC-009**: A user can distinguish Asset status (including its review-related states), Annotation status, Job status, and AI task status from the interface at all times — changing one is never observed to change another.

## Assumptions

- **Selection UI placement**: The existing single-select asset list embedded in the Properties Panel's Assets tab is extended in place with checkboxes, "select visible," "select all filtered," and a bulk-action bar, rather than building a separate standalone browser surface. Confirmed with stakeholder.
- **Asset-Label attachment**: No direct Asset-to-Label association exists today (Labels currently attach only to Annotations). This feature introduces one, as a plain metadata relationship — an Asset can have zero or more attached Labels, a Label can be attached to zero or more Assets within its dataset, and attaching/detaching never touches Annotation data. How this is modeled is a planning-phase decision, not a specification-level one; the specification only requires the invariant defined under Key Entities (at-most-once attachment, same-dataset scoping) to hold.
- **Label creation during Add Label**: Creating a new Label while adding it to a selection follows the exact same rules as the dataset's existing standalone label creation (dataset-scoped uniqueness by normalized name, name + color, no separate "asset-only" label type).
- **Audio/Text item-level details**: The audio/text "details" presentation currently shows only filename; this feature populates it with real, available descriptive metadata (e.g. duration, format, size, transcript/waveform availability) while leaving disabled sub-tabs (annotation-related) untouched, since editable audio/text annotation is out of scope. Confirmed with stakeholder.
- **Review status**: There is no separate review-status concept today; review-related filtering and display reuse the dataset's existing asset-status values (e.g. states representing "needs review," "reviewed," "rejected") rather than introducing a second, parallel status machine. This is why FR-017 and SC-009 treat review-related states as part of Asset status rather than as an independent fifth concept — it is not merged with Annotation, Job, or AI status.
- **Assignment**: Dataset-level membership/roles already exist; per-asset assignment does not. This feature only establishes the selection-to-assignee interface/API boundary, not a full assignment/notification workflow.
- **Bulk operation execution threshold**: Synchronous processing is assumed suitable for small-to-moderate selections; selections beyond a size threshold (to be finalized during planning) automatically run as a background operation instead of blocking the request. The exact threshold is an implementation detail, not a user-facing requirement.
- **Existing full-dataset export**: The current full-dataset export capability remains fully in place, unmodified in behavior, contract, and availability; "Export Selected" is an additive, separate capability.
- **Out of scope for this feature**: full collaboration/reviewer-assignment workflows, annotation quality scoring or agreement metrics, new annotation geometry or engines, new AI provider integrations, and any change to the annotation canvas's rendering or interaction behavior.
