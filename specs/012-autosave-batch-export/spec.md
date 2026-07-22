# Feature Specification: Autosave, Batch Navigation, and Dataset Export

**Feature Branch**: `012-autosave-batch-export`  
**Created**: 2026-07-21  
**Status**: Draft  
**Input**: User description: "Complete daily labeling workflow with safe autosave, asset search/filter/batch navigation, and annotated Dataset export through the existing durable Job system."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Preserve annotation work while navigating (Priority: P1)

An authorized annotator can work through a Dataset's images without losing changes, can see whether a save is pending or complete, and is clearly protected when another session has changed the same record.

**Why this priority**: Daily labeling is not trustworthy unless users can move quickly between assets while knowing that their work is durable and that stale edits cannot overwrite newer work.

**Independent Test**: An authorized annotator changes an annotation and an image description, waits for autosave, reloads the asset, and sees the durable changes. A second session then creates a conflicting edit; the stale client retains its draft and cannot overwrite the newer version.

**Acceptance Scenarios**:

1. **Given** an authorized annotator changes an eligible annotation or image description, **When** they make no further change for 1.5 seconds, **Then** the workspace saves the change and presents a truthful pending, saving, saved, or error state.
2. **Given** an edit is pending, **When** the user selects a different asset, changes the active filtered list, or leaves the workspace, **Then** the system finishes the pending save or presents a safe choice to resolve the error or conflict before navigation proceeds.
3. **Given** two authorized sessions edit the same annotation or description, **When** the older revision attempts to save after the newer revision succeeds, **Then** the stale save is rejected, the durable newer value remains unchanged, and the stale local draft stays available for explicit reload, discard, or reconciliation.
4. **Given** a save fails for a non-conflict reason, **When** the workspace remains open, **Then** it clearly identifies the failed state, preserves the local edit, and does not claim that it was saved.

---

### User Story 2 - Find and work through the right batch (Priority: P1)

An authorized Dataset member can search and filter assets, understand Dataset progress, and use previous/next navigation that follows the visible filtered result set.

**Why this priority**: Large labeling collections require predictable discovery and batch traversal rather than a single unfiltered asset list.

**Independent Test**: In a Dataset containing at least 250 assets with varied names and statuses, a member searches for a substring, applies a status filter, selects an asset beyond the first page, and uses previous/next controls that remain within the matching ordered result set.

**Acceptance Scenarios**:

1. **Given** a member enters a filename query, **When** the query is applied, **Then** matching assets are found case-insensitively across the full authorized Dataset and an empty result is shown safely when there is no match.
2. **Given** a member applies one or more available asset-status filters, **When** the result list updates, **Then** every visible asset satisfies the selected filters and the active selection is handled safely if it no longer matches.
3. **Given** a filtered result set spans multiple batches, **When** the member changes batch or selects a result, **Then** the UI shows no more than 100 assets per batch and preserves the filter, search, and batch context in navigation.
4. **Given** a filtered result set has a current asset, **When** the member chooses previous or next, **Then** navigation follows that filtered ordered set and does not silently drop a pending edit.
5. **Given** an authorized member views a Dataset, **When** progress is displayed, **Then** it reports safe aggregate progress derived from the Dataset's assets without exposing another Dataset's data.

---

### User Story 3 - Start and monitor a Dataset export (Priority: P1)

An authorized Dataset member can request an export of annotation metadata, follow its progress, and download the finished export without receiving source binaries or storage credentials.

**Why this priority**: Export is the handoff from completed labeling work to downstream consumers and must use the product's durable background-work boundary.

**Independent Test**: An authorized user starts an export for a Dataset with assets, labels, and annotations; the user observes its status, waits for completion, downloads the resulting JSON, and verifies that it contains the requested metadata but no binary content or credentials.

**Acceptance Scenarios**:

1. **Given** a user has permission to export a Dataset, **When** they request an export with a valid configuration, **Then** one durable export job is created for that Dataset and the user receives only its safe identifier and safe status projection.
2. **Given** an export is waiting or running, **When** the user views its status, **Then** progress, stage, counters, and a safe summary are available from the durable Job record; private job input, raw events, queue internals, and secrets are not returned.
3. **Given** an export completes, **When** the requesting authorized user downloads it, **Then** they receive a short-lived authorized download capability for the finished artifact and no storage credential, raw private object key, or provider configuration.
4. **Given** a user lacks Dataset export permission or knows another Dataset's identifiers, **When** they try to create, read, or download that export, **Then** access is denied without creating a Job, queue delivery, artifact, or other durable side effect.

---

### User Story 4 - Produce a portable annotation manifest (Priority: P2)

An export consumer receives a consistent JSON manifest that describes the Dataset, its assets, taxonomy, and annotations without embedding binary files.

**Why this priority**: A stable metadata-only manifest enables review, analytics, and later integration while honoring the platform's binary-storage and secrecy boundaries.

**Independent Test**: Export a Dataset containing multiple asset modalities and annotations, then validate that the JSON references each permitted metadata entity once, preserves canonical annotation geometry and properties, and contains neither binary payloads nor credentials.

**Acceptance Scenarios**:

1. **Given** a completed export, **When** its manifest is inspected, **Then** it includes Dataset metadata, Asset metadata, label taxonomy, annotations, canonical annotation geometry, annotation properties, and safe storage-reference metadata.
2. **Given** any source asset or prior export artifact contains binary content, **When** the manifest is generated, **Then** the binary content itself is excluded.
3. **Given** the Dataset contains a modality that has no specialized workspace in the current product, **When** it is exported, **Then** its safe Asset metadata is retained without inventing modality-specific processing behavior.

### Edge Cases

- A user navigates or closes the page while autosave is in progress, offline, failed, or conflicted.
- The selected Asset is archived, removed from the result set, or becomes unauthorized while a save or navigation request is pending.
- A search query or status filter has no matching assets, and a requested batch is outside the matching result range.
- A concurrent edit deletes an annotation or changes its label before a stale client saves.
- An export is requested for an empty Dataset, an archived Dataset, a Dataset whose permission changes mid-job, or a Dataset containing assets without annotations.
- Queue delivery fails after the durable export Job is created; the Job remains recoverable by the existing queue recovery policy rather than being represented as completed.
- The worker fails, is cancelled through an authorized existing boundary, or cannot create the export artifact; no partial artifact is presented as a completed download.
- A finished download capability expires, is replayed, or is requested by a user outside the Dataset scope.

## Requirements *(mandatory)*

### Functional Requirements

#### Phase 012.1 — Autosave, Search, Filters, and Batch Navigation

- **FR-001**: The system MUST autosave eligible annotation and image-description edits after 1.5 seconds of inactivity. It MUST expose distinct dirty, saving, saved, error, and conflict states to the user.
- **FR-002**: A successful annotation save MUST use and advance its current optimistic revision exactly once. A successful description save MUST use and advance the Asset revision exactly once.
- **FR-003**: A stale, missing, deleted, unauthorized, or otherwise invalid save MUST not overwrite a newer durable value or partially mutate another field.
- **FR-004**: Before changing the selected asset, filtered result set, batch, or workspace location, the system MUST flush an eligible pending save. If that save cannot safely complete, it MUST preserve the local draft and require explicit user action before discarding it.
- **FR-005**: The system MUST preserve local drafts during a revision conflict and offer explicit safe choices to reload current durable data, discard the local draft, or reconcile it. It MUST NOT silently retry a stale overwrite.
- **FR-006**: Authorized Dataset members MUST be able to search Asset filenames by a case-insensitive substring across the full Dataset scope.
- **FR-007**: Authorized Dataset members MUST be able to filter the Asset list by supported Asset status values. Search, filters, ordering, current page, and selected asset MUST remain mutually consistent.
- **FR-008**: The Asset list MUST display at most 100 assets in a batch. Previous and next asset navigation MUST follow the active filtered and searched ordered result set rather than the unfiltered Dataset list.
- **FR-009**: The workspace MUST show safe Dataset progress aggregates derived from authorized assets and must not expose another Dataset's asset counts, names, or statuses.
- **FR-010**: Search, filter, batch, navigation, and save operations MUST enforce the existing Dataset membership and per-resource authorization policy. A known identifier outside the actor's scope MUST not disclose protected data.

#### Phase 012.2 — Export through the Durable Job System

- **FR-011**: An authorized user MUST be able to request a Dataset export through `POST /api/export`. The request MUST identify only an authorized Dataset and a validated export configuration; browser input MUST NOT set ownership, queue transport fields, worker identity, storage location, or terminal Job state.
- **FR-012**: Starting an export MUST create one common durable Job with type `EXPORT_DATASET`, initial status `QUEUED`, and a validated export configuration in the Job's durable input. The Job is the canonical record of the export lifecycle.
- **FR-013**: Queue delivery for an export MUST contain exactly `{ jobId }`. Queue transport is not an export state store and MUST NOT receive full export input, manifest data, credentials, or storage references.
- **FR-014**: If queue delivery cannot be recorded after durable Job creation, the Job MUST remain recoverable according to the existing queued-Job recovery policy; it MUST NOT be reported as completed or duplicated by a retry.
- **FR-015**: The private worker MUST resolve the export Job from the durable record, generate one JSON metadata manifest, and update the same Job with safe progress and terminal outcome. It MUST not serve browser traffic or perform unrelated business processing.
- **FR-016**: A completed manifest MUST contain Dataset metadata, safe Asset metadata, label taxonomy, annotations, canonical `Annotation.geometry`, annotation properties, and safe storage-reference metadata. It MUST exclude binary files, raw source binaries, credentials, provider tokens, private object keys or URLs, raw Job input, queue internals, and server-only configuration.
- **FR-017**: The completed artifact MUST be retained in private binary storage and be downloadable only through an authorized, short-lived backend-generated capability. The public application MUST expose `GET /api/export/[jobId]` as a safe authorized export-status and completed-download boundary.
- **FR-018**: Export status reads MUST use the existing safe Job-status projection. The optional summary MUST be a sanitized, explicitly whitelisted UI-safe DTO and may remain null; no raw Job events, errors, result, input, state, source-connection data, repository data, queue internals, credentials, or binary data may be returned.
- **FR-019**: Export authorization MUST apply the existing effective permission model (system role, Dataset ownership, and Dataset membership). A user without export permission, including a user outside the Dataset, MUST not create, view, download, cancel, or otherwise affect that Dataset's export.
- **FR-020**: Export creation, recovery, worker delivery, retries, and artifact persistence MUST be idempotent for the same durable Job. They MUST NOT create duplicate artifact records, queue deliveries, or downloadable assets on retry.
- **FR-021**: Authorization denials, validation failures, revision conflicts, cancellation, and failed export processing MUST not cause unintended changes to Dataset metadata, Assets, annotations, labels, unrelated Jobs, queue state, or storage objects.

### Key Entities

- **Save State**: User-visible state for a local annotation or description draft: dirty, saving, saved, failed, or conflict. It is separate from the durable annotation and Asset revisions.
- **Filtered Asset Result Set**: The authorized, ordered collection defined by one Dataset, a filename query, selected status filters, and a batch position; it determines previous/next navigation.
- **Dataset Progress**: Safe aggregate counts and completion indicators calculated from assets accessible in one Dataset.
- **Export Request**: An authorized request for one Dataset and a validated configuration that determines which metadata-only manifest is produced.
- **Export Job**: The existing common durable Job representing an export lifecycle, its progress, safe summary, attempt history, and terminal result; it is not a separate export-specific Job table.
- **Export Manifest**: A JSON artifact containing permitted Dataset, Asset, label, and annotation metadata with canonical geometry and properties, but no binary content or secrets.
- **Download Capability**: A short-lived, object-scoped authorization to retrieve a completed export artifact. It is not a storage credential and cannot list, administer, or access other objects.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In autosave integration tests, 100% of eligible edits made idle for 1.5 seconds persist successfully or surface a truthful failure/conflict state; no test case silently loses an unsaved draft.
- **SC-002**: In concurrent-edit tests, 100% of stale saves are rejected without changing the newer durable annotation or description, and the stale client retains a recoverable local draft.
- **SC-003**: In a Dataset with at least 250 assets, 100% of displayed batches contain no more than 100 assets; filename searches and status filters apply across the full authorized Dataset and previous/next stays within the active result set.
- **SC-004**: An authorized user can begin an export and see its durable progress state within 10 seconds of requesting it under a healthy local runtime.
- **SC-005**: In export integration tests, 100% of completed manifests contain required Dataset, Asset, label, and annotation metadata while containing zero binary payloads, credentials, provider tokens, raw private object keys, or raw queue/Job internals.
- **SC-006**: In authorization and denial-side-effect tests, 100% of unauthorized export, status, and download attempts are denied without creating a Job, queue delivery, artifact, or other business-state mutation.
- **SC-007**: In retry and recovery tests, each durable export Job produces at most one completed artifact and no duplicate queue delivery or export record attributable to retry.

## Assumptions

- Phase 011's image workspace, versioned annotation/Asset saves, and authorized Dataset workspace are the dependency for Phase 012.1; this phase completes their daily-workflow behavior rather than introducing new shape types or workspace routes.
- The current effective Dataset permission matrix remains authoritative. The existing permission that permits creating an export determines which owner/member roles may start one; this specification does not grant all managers access to all Datasets.
- The existing common Job, safe Job-status projection, queue factory, private worker lifecycle, claim lock, cancellation protocol, retry lineage, and recovery scanner are the dependencies for Phase 012.2.
- JSON is the first and only export format in this phase. The manifest carries safe logical storage references (for example, asset identity and modality) rather than private storage keys, bucket names, or URLs.
- Asset status values already supported by the application define the available status filters. New status taxonomy, custom saved searches, offline synchronization, and cross-Dataset search are out of scope.
- The existing private storage topology provides short-lived authorized artifact download capabilities without exposing credentials.

## Scope Boundaries

- **In scope**: reliable 1.5-second autosave, flush-before-navigation, save and conflict UI, Asset search and status filters, 100-item batch navigation, safe Dataset progress, metadata-only Dataset JSON export, durable export Job lifecycle, safe status/download reads, worker processing, private artifact storage, authorization, retry/recovery behavior, and integration coverage.
- **Out of scope**: new annotation shapes, video/audio/text workspace engines, bulk annotation edits, configurable export formats, binary bundling, public storage access, local-folder preparation/commit workflow changes, source-connection features, AI processing, a new Job table, raw queue state in the UI, or any replacement of PostgreSQL as the Job source of truth.
- **Data and security boundaries**: binary data remains in private object storage; export manifests and browser-visible responses never contain credentials, provider tokens, private storage keys/URLs, raw Job input/state/result/event data, queue internals, or binary content. Queue payloads remain exactly `{ jobId }`.
