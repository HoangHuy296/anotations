# Feature Specification: Job APIs and Progress UI

**Feature Branch**: `009-job-apis-progress-ui`

**Created**: 2026-07-16

**Status**: Draft

**Input**: User description: "Provide authorized Job status, event, cancellation, retry, and progress UI. Local import commit is explicitly deferred to the next phase."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Monitor an authorized job (Priority: P1)

As a Dataset member, I can open a background job and understand its current stage, progress, safe outcome summary, and chronological activity so that I know whether to wait, intervene, or continue my work.

**Why this priority**: Visibility is the minimum useful experience for every background operation and must use the durable Job record rather than transport state.

**Independent Test**: An authorized member opens a Job with progress and events and sees only the safe status fields and allowlisted event information; a non-member cannot learn that the Job exists.

**Acceptance Scenarios**:

1. **Given** a member can read a Dataset, **When** they request one of its Jobs, **Then** they receive its current safe status, stage, progress counters, safe summary, and timestamps.
2. **Given** a member can read a Dataset, **When** they open the Job activity list, **Then** they see ordered, allowlisted events without raw event data or private execution details.
3. **Given** a user is not a member of a Job's Dataset, **When** they use a known Job identifier, **Then** the Job is not disclosed.
4. **Given** a Job is running, **When** its durable progress changes, **Then** the progress card reflects the latest saved state within 10 seconds of a refresh or poll.

---

### User Story 2 - Request safe cancellation (Priority: P1)

As an authorized Dataset operator, I can request cancellation of an in-flight background job so that unnecessary work stops without allowing a browser to take ownership of worker execution.

**Why this priority**: Users need a reversible control over long-running work while the worker safety boundary remains intact.

**Independent Test**: An authorized operator requests cancellation for an eligible Job; an unauthorized user is denied with no Job or event write, and the worker acknowledgement results in a cancelled outcome.

**Acceptance Scenarios**:

1. **Given** an authorized operator cancels an active Job, **When** the request is accepted, **Then** cancellation is durably requested and the UI shows cancellation is pending until the worker acknowledges it.
2. **Given** an eligible Job has not yet been claimed, **When** cancellation is accepted, **Then** it is finalized without requiring a worker to claim it.
3. **Given** a worker holds the active lease for a cancellation-requested Job, **When** it reaches a safe stopping point, **Then** it acknowledges the request and the Job becomes cancelled.
4. **Given** a terminal, already-cancelled, or unknown Job, **When** cancellation is requested, **Then** the caller receives a clear non-success result and no duplicate cancellation side effect occurs.

---

### User Story 3 - Retry a failed job safely (Priority: P2)

As an authorized Dataset operator, I can safely retry a failed background job so that recoverable work continues without duplicating durable work or exposing private execution context.

**Why this priority**: Recoverable operations need an explicit, auditable user action rather than ad hoc queue manipulation.

**Independent Test**: An authorized operator retries one failed Job; duplicate submissions do not create duplicate successor work, and unauthorized users make no changes.

**Acceptance Scenarios**:

1. **Given** an authorized operator retries a failed Job, **When** the retry is accepted, **Then** one new eligible Job is created from the server-held, safe retry context while the original failed Job remains unchanged.
2. **Given** the same retry action is submitted again, **When** a successor already exists for that retry request, **Then** no second successor Job is created.
3. **Given** a user lacks the Dataset permission for retry, **When** they submit the action, **Then** the system does not reveal or change the Job.

---

### User Story 4 - Understand a failed job (Priority: P2)

As a Dataset member, I can see a safe error panel for a failed job so that I can decide whether retrying is appropriate without being shown credentials, storage references, or internal diagnostic payloads.

**Why this priority**: A generic failure state without a safe explanation makes retry controls unreliable and creates support burden.

**Independent Test**: A failed Job with an allowlisted summary is displayed with its safe message; raw error details and private fields never appear in the status response, event list, or UI.

**Acceptance Scenarios**:

1. **Given** a Job has a safe user-facing failure summary, **When** an authorized member opens it, **Then** the error panel shows only the approved message and code/category.
2. **Given** a Job has raw diagnostic data, **When** an authorized member opens its status or events, **Then** that raw data is not returned or displayed.

### Edge Cases

- A Job changes between status refreshes, including from running to cancelled or failed; the latest durable state wins.
- A cancellation request races with a worker completion or failure; only one valid durable terminal outcome is retained.
- A retry request races with another retry request; at most one successor is created for the same failed Job.
- A queued Job cannot be delivered after it has been cancelled.
- A retry is requested for a non-failed, cancelled, or already-retried Job.
- The event list is empty, contains more events than one screen can display, or contains only events not suitable for user display.
- A safe summary is absent; the UI continues to render status and progress without inventing an error message.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide authorized reads for one Job and its event history at the listed Job status and event endpoints.
- **FR-002**: Job status reads MUST be authorized through the Job's Dataset membership boundary. A non-member lookup MUST not disclose Job existence or metadata.
- **FR-003**: A Job status response MUST use the established safe Job status projection, including only identifier, Dataset identifier, type, status, stage, progress counters, safe summary, and timestamps.
- **FR-004**: The status response MUST NOT expose full Job input, state, result, raw summary JSON, raw errors, raw event data, queue internals, lock values, source connections, repositories, credentials, private storage references, private URLs, or binary data.
- **FR-005**: Job event reads MUST return a bounded, ordered safe event projection. Each event may contain only its time, level, stage when safe, allowlisted message, and allowlisted scalar context.
- **FR-006**: The progress UI MUST show status, stage, progress, processed/total counts when available, outcome counts when available, and a safe summary or safe failure panel when available.
- **FR-007**: The progress UI MUST present controls only when the durable Job state and actor permission make them applicable; the backend remains authoritative for every action.
- **FR-008**: An authorized cancellation request MUST record who requested it and when. Active work MUST enter a pending-cancellation state; unclaimed eligible work MUST be cancelled without being claimed solely to acknowledge cancellation.
- **FR-009**: Cancellation and retry actions MUST enforce Dataset-scoped authorization server-side and MUST ignore any browser-supplied owner, worker, lock, queue, or storage authority.
- **FR-010**: A retry MUST be permitted only for an eligible failed Job, retain the original Job as history, and create or return exactly one successor for a given retry intent.
- **FR-011**: A retry successor MUST be authorized and prepared from server-held safe context. It MUST NOT copy credentials, encrypted values, raw errors, private storage locations, or arbitrary browser-provided Job input.
- **FR-012**: Every successful retry MUST follow the existing durable create-then-enqueue rule; queue delivery carries only the resulting Job identifier.
- **FR-013**: The worker-side cancellation acknowledgement, claim lock, and lifecycle token rules established in Phase 008 MUST remain unchanged.
- **FR-014**: Job progress, status, event history, cancellation state, and retry eligibility displayed to users MUST be derived from durable Job records and safe events, not from queue transport state.
- **FR-015**: The feature MUST add no repository cloning, direct local filesystem access by the backend, binary storage in the database, worker business processing, import commit endpoint, import staging, or modality-specific workspace route.

### Key Entities

- **Safe Job Status**: The browser-visible, allowlisted representation of a Dataset Job and its progress; it is not the internal Job record.
- **Safe Job Event**: A bounded user-visible activity item containing only approved operational context.
- **Cancellation Request**: The durable operator request to stop eligible work, distinct from the worker's later cancellation acknowledgement.
- **Retry Successor**: The single new eligible Job created from a failed Job's safe server-held retry context while preserving the failed Job as history.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In authorization tests, 100% of known Job identifiers outside the actor's Dataset boundary return no Job data and produce no action side effect.
- **SC-002**: In status and event contract tests, 100% of browser-visible responses omit all prohibited private Job, queue, credential, storage, and binary fields.
- **SC-003**: In a running-job acceptance test, a user sees a newly saved stage or progress update within 10 seconds of requesting a refresh.
- **SC-004**: In cancellation tests, 100% of authorized eligible cancellation requests result in exactly one durable cancellation outcome, while unauthorized or ineligible attempts leave durable state unchanged.
- **SC-005**: In concurrent retry tests, 100% of duplicate submissions create no more than one successor Job.
- **SC-006**: In UI acceptance tests, users can identify a Job's status, stage, progress, safe events, applicable action, and safe failure explanation without access to internal diagnostic data.

## Assumptions

- The existing Dataset membership and Job authorization rules are reused; administrators retain their established system-wide access.
- The existing safe Job status projection is the sole status contract and an absent safe summary is rendered as no summary.
- The current worker has no business processor in this phase; cancellation acknowledgement behavior is exercised through existing lifecycle safety primitives or a controlled test flow.
- Retry controls are limited to users with the corresponding Dataset-scoped authorization; exact role mapping follows the existing permission matrix.
- Progress refresh may use polling or another existing application refresh mechanism, provided it reads durable state and meets the stated visibility target.
- `Dataset.primaryModality` remains a UI/default fallback only. Asset modality remains the source of truth and is outside this Job UI phase.

## Scope Boundaries

- In scope: safe Job status/event reads, Dataset-authorized cancellation/retry actions, durable retry idempotency, and Job progress UI.
- Out of scope: `POST /api/jobs/[jobId]/commit-import`, PreparedImport, local-folder staging, IMPORT_DATASET processing, manifest/Asset persistence, staged-file cleanup, import-specific compensation, worker business workflows, repository cloning, browser filesystem access, new binary storage, realtime transport requirements, new modality-specific workspaces, and changes to queue payload or PostgreSQL Job authority.
