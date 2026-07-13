# Feature Specification: Prisma Core Schema

**Feature Branch**: `002-prisma-core-schema`  
**Created**: 2026-07-13  
**Status**: Draft  
**Input**: User description: "Define Phase 2 core schema for a multi-modal annotation MVP. The prepared Prisma schema is the source of truth; do not modify the schema or migrations while creating this specification."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Organize multi-modal annotation work (Priority: P1)

As a dataset owner, I need one dataset to organize image, video, text, and
audio assets so each asset is sent to the appropriate annotation workspace and
can retain labels and annotations.

**Why this priority**: Multi-modal data is the core product boundary and every
later import, workspace, and review capability depends on it.

**Independent Test**: Validate the approved schema and confirm a dataset can
contain assets of multiple modalities, while every asset has a required
modality and source fingerprint.

**Acceptance Scenarios**:

1. **Given** a dataset contains image and audio assets, **When** it is read,
   **Then** both assets are represented in the same dataset and each has an
   explicit modality.
2. **Given** a dataset does not designate one preferred modality, **When** it
   is created, **Then** it remains valid as a multi-modal dataset.
3. **Given** an annotation is updated, **When** a stale version is supplied,
   **Then** the canonical geometry cannot be silently overwritten.

---

### User Story 2 - Connect external sources without leaking credentials (Priority: P1)

As an operator, I need to associate datasets and assets with external
repositories and source connections while ensuring repository records never
contain access tokens.

**Why this priority**: Source provenance is required for import and sync, and
credential separation is a non-negotiable security boundary.

**Independent Test**: Inspect the approved schema definition and confirm that
an external repository has no token-bearing field while a source connection has
an encrypted-token field.

**Acceptance Scenarios**:

1. **Given** a private source is connected, **When** its metadata is stored,
   **Then** the repository record contains identity/provenance only and no
   token field.
2. **Given** a source connection requires authentication, **When** a token is
   persisted, **Then** the persisted value is designated as encrypted.

---

### User Story 3 - Track background work durably (Priority: P1)

As an operator, I need one durable record and event trail for every background
operation so queue delivery can be observed without becoming the authority for
job state.

**Why this priority**: Imports, exports, and repository work require a common,
auditable lifecycle and retry-safe queue linkage.

**Independent Test**: Validate the approved schema and confirm it has one
common Job entity with queue transport fields and JobEvent history, without
specialized import/export/repository-sync job entities.

**Acceptance Scenarios**:

1. **Given** work has been submitted, **When** it is queued, **Then** its
   durable record can retain the queue name, queue job identifier, enqueue
   timestamp, and dequeue timestamp.
2. **Given** an operation emits lifecycle messages, **When** they are stored,
   **Then** they are associated with the common Job event trail.

### Edge Cases

- An asset is received without a modality or source fingerprint.
- A multi-modal dataset has no primary modality.
- A label applies across all modalities and therefore has no modality value.
- A stale annotation update uses a prior version.
- A queue message is retried or delivered after its Job is terminal.
- A source repository record is populated with a token-bearing field.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Phase 2 schema baseline MUST include the core entities User,
  AuthSession, Dataset, DatasetMember, Asset, ImageAsset, VideoAsset,
  TextDocument, AudioAsset, Label, Annotation, ExternalRepository,
  SourceConnection, Job, and JobEvent.
- **FR-002**: Dataset MUST support multi-modal organization; its primary
  modality designation MUST be optional.
- **FR-003**: Asset MUST require a modality and a source fingerprint, and MUST
  support modality-specific detail records for image, video, text, and audio.
- **FR-004**: Label modality MUST be optional so a label may apply generally or
  be scoped to one modality.
- **FR-005**: Annotation geometry MUST be the canonical JSON representation of
  the annotation shape, and Annotation version MUST provide the concurrency
  value used to prevent stale overwrites.
- **FR-006**: ExternalRepository MUST contain no token-bearing field.
- **FR-007**: SourceConnection MUST support encrypted token storage without
  placing credentials in ExternalRepository, Asset, Dataset, Job, or JobEvent.
- **FR-008**: Job MUST be the common durable entity for asynchronous work and
  MUST include queue name, queue job identifier, enqueue timestamp, and dequeue
  timestamp as transport metadata.
- **FR-009**: JobEvent MUST provide an ordered event history associated with a
  common Job.
- **FR-010**: The schema MUST NOT define ImportJob, ExportJob, or
  RepositorySyncJob as separate entities.
- **FR-011**: The schema MUST support a valid migration and schema validation
  for the approved core model set.
- **FR-012**: For this specification step, `prisma/schema.prisma` and every
  migration are read-only; the prepared schema remains the source of truth for
  planning and is not changed by this feature-specification work.

### Key Entities

- **User and AuthSession**: A person and their revocable authenticated session.
- **Dataset and DatasetMember**: The central multi-modal work container and
  its access membership.
- **Asset and modality details**: A source or derived item with mandatory
  modality, source fingerprint, and image/video/text/audio detail records.
- **Label and Annotation**: Annotation taxonomy and canonical, versioned shape
  data associated with an asset.
- **ExternalRepository and SourceConnection**: Repository provenance separated
  from encrypted source credentials.
- **Job and JobEvent**: One durable background-work record and its event trail.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All 15 required core entities are represented in the approved
  schema baseline with their required relationships.
- **SC-002**: A review of 100% of repository fields confirms ExternalRepository
  has zero token-bearing fields and SourceConnection provides encrypted token
  storage.
- **SC-003**: A review of the Asset and Annotation definitions confirms every
  asset has one required modality and source fingerprint, and every annotation
  has canonical geometry plus a concurrency version.
- **SC-004**: A review of the Job definition confirms all four queue transport
  fields exist and zero specialized import/export/repository-sync Job entities
  exist.
- **SC-005**: Schema validation and the approved migration complete without
  errors when Phase 2 implementation is explicitly authorized.

## Assumptions

- The current prepared `prisma/schema.prisma` is the source of truth used to
  plan this work. This specification does not edit it or migrations.
- Existing supporting entities beyond the 15 required core entities may remain
  when they preserve the Phase 0 architecture lock.
- `Dataset.primaryModality` is the optional preferred modality; it does not
  restrict the modalities of the dataset's assets.
- `Annotation.version` is an integer-like optimistic concurrency value that is
  incremented on successful durable updates; its exact migration mechanics are
  decided only in the approved implementation phase.
- Queue transport fields describe linkage only. PostgreSQL Job state remains
  authoritative and the queue payload remains limited to `jobId`.
