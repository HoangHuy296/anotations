# Feature Specification: Dataset, Label, and Asset Metadata Foundation

**Feature Branch**: `005-dataset-label-asset-metadata-foundation`  
**Created**: 2026-07-14  
**Status**: Draft  
**Input**: Dataset and label management with authorized asset metadata browsing.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Manage a dataset (Priority: P1)

As an authenticated user, I need to create, view, update, and archive datasets I own so that I can organize annotation work.

**Why this priority**: Dataset is the central workspace boundary for labels, assets, annotations, and access control.

**Independent Test**: An owner creates a multi-modal dataset, lists it, views it, updates safe metadata, and archives it; a non-owner cannot discover or change it.

**Acceptance Scenarios**:

1. **Given** an authenticated user, **When** they create a dataset, **Then** they become its owner and it may be multi-modal without requiring one primary modality.
2. **Given** a dataset owner, **When** they view or update their dataset, **Then** the safe metadata reflects their change.
3. **Given** a non-owner/non-member, **When** they provide another user's dataset identifier, **Then** the dataset is not disclosed and no change occurs.
4. **Given** an owner, **When** they delete a dataset, **Then** the dataset is archived rather than unintentionally hard-deleted.

---

### User Story 2 - Manage a dataset label taxonomy (Priority: P1)

As an authorized dataset manager, I need to create, update, and remove labels so that annotations use a consistent taxonomy.

**Why this priority**: Labels are the reusable metadata vocabulary for annotation work.

**Independent Test**: An authorized manager creates a label, updates it, and removes an unused label; a duplicate normalized name and an unauthorized mutation are rejected.

**Acceptance Scenarios**:

1. **Given** an actor with label-management permission, **When** they create a label, **Then** it belongs to the selected authorized dataset.
2. **Given** two label names that differ only by case or surrounding whitespace, **When** they are created in the same dataset, **Then** only one is accepted.
3. **Given** an actor without label-management permission, **When** they try to change a label, **Then** the taxonomy remains unchanged.

---

### User Story 3 - Browse asset metadata (Priority: P1)

As an authorized dataset member, I need a paginated, filterable list of asset metadata so that I can find work without loading binary content.

**Why this priority**: Asset metadata is the safe operational view needed before annotation workflows expand.

**Independent Test**: A dataset member requests consecutive asset pages and applies supported filters; results contain only assets in that dataset and no binary payload.

**Acceptance Scenarios**:

1. **Given** a dataset member, **When** they list assets, **Then** the response contains only safe metadata for that dataset plus pagination information.
2. **Given** an asset filter, **When** it is valid, **Then** only matching assets are returned; invalid filters are rejected safely.
3. **Given** a non-member, **When** they list another dataset's assets, **Then** no asset metadata is disclosed.

### Edge Cases

- A dataset has no assets or labels.
- A requested page is beyond the available asset results.
- A label is still referenced by annotations when deletion is requested.
- A dataset is archived while a member has its detail page open.
- A client sends owner, dataset, or label identifiers that conflict with the authorized route scope.
- A filter would expose provider credentials, source URLs, object storage keys, or binary content.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide the requested dataset, label, and asset-list operations at the specified browser-facing paths.
- **FR-002**: Dataset create MUST derive the owner from the authenticated actor and MUST ignore any browser-supplied owner identifier.
- **FR-003**: Dataset create and update MUST support multi-modal datasets; a primary modality remains optional.
- **FR-004**: Dataset delete MUST archive the dataset and MUST NOT perform an ordinary hard delete.
- **FR-005**: Dataset list/detail/update/archive MUST enforce the existing ownership and membership policy, including safe non-disclosure for outsiders.
- **FR-006**: Label create/update/delete MUST enforce dataset-scoped label-management permission.
- **FR-007**: Each label MUST have a normalized name derived consistently from its display name; duplicate normalized names within one dataset MUST be rejected.
- **FR-008**: Asset listing MUST be dataset-scoped, paginated, and support a safe scaffold of status, modality, and text-search filters.
- **FR-009**: Asset list and dataset-detail responses MUST exclude binary bodies, provider tokens, encrypted connection values, storage credentials, and private object-storage access details.
- **FR-010**: All mutations MUST validate input, derive authorization from the server session, and make no durable change when denied.
- **FR-011**: This phase MUST use the existing Dataset, Label, Asset, and access-control schema; any schema or migration change requires separate approval.

### Key Entities

- **Dataset**: Central owned or shared workspace; may be multi-modal.
- **Label**: Dataset-scoped annotation taxonomy entry with a normalized unique name.
- **Asset**: Dataset-scoped metadata record; its binary remains private storage content.
- **Dataset membership**: Role-based entitlement controlling dataset and label operations.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of tested owners can create, view, update, and archive their datasets without a hard delete.
- **SC-002**: 100% of tested duplicate label names that normalize to the same value are rejected within one dataset.
- **SC-003**: 100% of tested non-member dataset, label, and asset-list requests return no protected metadata or durable side effect.
- **SC-004**: In acceptance testing, every asset-list response includes a bounded page of metadata and pagination information, with no binary or secret field.
- **SC-005**: 100% of tested authorized asset filters return records only from the requested authorized dataset.

## Assumptions

- Phase 004 authentication and ownership guards are complete and verified before this phase is implemented.
- `UserRole` is system-wide. `ADMIN` may manage every Dataset; `MANAGER` may create Datasets but has no implicit access to another user's Dataset. `LABELER` and `REVIEWER` cannot create Datasets.
- For an existing Dataset, effective permission is the system-wide role plus Dataset ownership plus `DatasetMemberRole`: an ADMIN is a system override; all non-admin access still requires ownership or membership and the finalized Dataset permission matrix.
- The asset filter scaffold is limited to metadata filters and does not fetch/download binary content.
- Dataset detail is a browser-facing page/API view; bulk import, repository sync, export processing, and annotation editing remain out of scope.
