# Feature Specification: Local Folder Import and Commit Signal

**Feature Branch**: `010-local-folder-import-commit-signal`

**Created**: 2026-07-17

**Status**: Draft

**Input**: User description: "Create a Dataset from a browser-selected local folder through preflight, direct uploads, and an explicit import commit signal."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Prepare and upload a local folder (Priority: P1)

As an authorized user, I can select a local folder, review its eligible files, and upload them into a new Dataset without the application backend receiving my local path or file bytes.

**Why this priority**: Safe browser-owned transfer is the core value of local folder import.

**Independent Test**: A user selects a mixed-modality folder, starts an import, uploads eligible files through authorized object-scoped capabilities, and observes durable per-file progress without the backend receiving file bodies or an absolute local path.

**Acceptance Scenarios**:

1. **Given** a user selects a folder, **When** it is preflighted, **Then** eligible files, size, MIME type, modality, and safe logical relative name are assessed without transmitting an absolute local path, drive name, browser file handle, or binary.
2. **Given** preflight is valid, **When** the user starts the import, **Then** one new Dataset, one durable prepared import, and one durable `IMPORT_DATASET` Job are created.
3. **Given** an approved file, **When** the browser uploads and completes it, **Then** the binary reaches private object storage directly and exactly one Asset plus matching modality metadata is created or reconciled.
4. **Given** a file is unsupported, too large, or differs from its preflight metadata, **When** it is submitted, **Then** it is rejected with a safe reason and no untrusted Asset is persisted.

---

### User Story 2 - Commit a complete import (Priority: P1)

As the user who started an import, I can explicitly commit it after browser uploads finish so that the Dataset is completed only when every expected file is durably accounted for.

**Why this priority**: Explicit user intent prevents a disconnected browser session from being mistaken for a completed import.

**Independent Test**: A user prepares an import, uploads all expected files, commits it, and receives one completed Job whose durable counts match the preparation; repeating commit creates nothing new.

**Acceptance Scenarios**:

1. **Given** the current user is authorized for the Job and Dataset, **When** they commit a running or retrying import, **Then** the system validates ownership, type, preparation, expected total, and completed Asset count.
2. **Given** every expected item is complete, **When** commit succeeds, **Then** the Job becomes completed exactly once and the Assets appear in the Dataset list.
3. **Given** items are missing, **When** commit is requested, **Then** it returns `IMPORT_INCOMPLETE`, leaves the Job non-terminal, and shows durable progress.
4. **Given** a valid commit is repeated, **When** completion was already recorded, **Then** the same durable outcome is returned without duplicate Assets, objects, Jobs, or events.

---

### User Story 3 - Recover from an interrupted import (Priority: P2)

As a user whose browser closes or disconnects, I can see that an incomplete import timed out or failed rather than appearing complete.

**Why this priority**: Browser interruption is expected during large local uploads and partial data must never be misrepresented as complete.

**Independent Test**: A prepared import receives no commit before its deadline; one durable failed Job is recorded with `IMPORT_COMMIT_TIMEOUT`, safe partial progress remains visible, and recovery creates no duplicates.

**Acceptance Scenarios**:

1. **Given** no commit signal arrives before the deadline, **When** stale detection runs, **Then** it records one failed Job with `IMPORT_COMMIT_TIMEOUT` and an allowlisted safe summary.
2. **Given** an import is only partially uploaded, **When** its deadline expires, **Then** it remains visibly failed/timed-out and is never reported completed.
3. **Given** stale detection or retry runs repeatedly, **When** it handles the same preparation, **Then** it does not duplicate an Asset, object, Job, or terminal event.

---

### User Story 4 - Enforce import ownership (Priority: P2)

As a Dataset user, I can access only imports and resulting Assets I am authorized to access, while a non-member cannot use known identifiers to inspect or alter an import.

**Why this priority**: One import spans preparation, Dataset, Job, Assets, and objects; each boundary must retain existing IDOR protections.

**Independent Test**: Owner, permitted member, forbidden member, and non-member tests cover preparation, upload capability, completion, commit, timeout, and retry; denied actions make no writes.

**Acceptance Scenarios**:

1. **Given** a non-member knows an import-related identifier, **When** they read or mutate it, **Then** they receive a safe not-found result and no metadata, object, queue, or event side effect occurs.
2. **Given** a permitted actor requests upload or commit, **When** browser-supplied ownership conflicts with durable ownership, **Then** the server rejects the request.
3. **Given** an upload capability is issued, **When** it is used or expires, **Then** it remains limited to one authorized object and never grants storage credentials, listing, or access to another import.

### Edge Cases

- The folder is empty, has no eligible files, duplicate logical names, or exceeds import limits.
- Preflight and upload disagree about MIME type, size, or modality.
- The browser crashes after upload but before completion acknowledgement or commit.
- Commit races with a final upload, cancellation, stale timeout, or retry.
- An object is orphaned; cleanup must not delete an object referenced by a durable Asset.
- A Dataset is archived or permission is revoked while uploads are pending.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a local-folder import entry experience for creating a new Dataset.
- **FR-002**: Browser preflight MUST send only validated import metadata; it MUST NOT send absolute paths, drive identifiers, file handles, or binary bytes to the backend.
- **FR-003**: An accepted start MUST create one durable prepared import, one Dataset, and one common `IMPORT_DATASET` Job; separate import Job tables are prohibited.
- **FR-004**: A prepared import MUST bind requester, Dataset, Job, expected safe manifest/count, expiry/deadline, and idempotency context.
- **FR-005**: Every preparation, upload capability, completion acknowledgement, commit, retry, cleanup, and read MUST enforce current actor and Dataset/import authorization; browser owner/worker values are ignored.
- **FR-006**: File transfer MUST use short-lived object-scoped browser capabilities. The browser MUST NOT receive provider credentials, storage listing rights, reusable broad access, or another import's object reference.
- **FR-007**: A completed upload MUST verify its object and create or reconcile exactly one Asset and exactly one matching modality-specific row. Binary data MUST NOT enter PostgreSQL.
- **FR-008**: `Asset.modality` MUST remain the source of truth. `Dataset.primaryModality` is optional UI/import default and MUST NOT prohibit mixed modalities.
- **FR-009**: Browser-visible import status/events MUST omit raw manifest data, local paths, storage keys/private URLs, credentials, queue/lock state, and binary data.
- **FR-010**: Commit MUST require an authorized actor, Job type `IMPORT_DATASET`, and Job status `RUNNING` or `RETRYING`.
- **FR-011**: Commit MUST compare completed Asset count with the durable expected total; a mismatch MUST return `IMPORT_INCOMPLETE` without completion.
- **FR-012**: Valid commit MUST persist one terminal completed outcome and safe event. Duplicate commit/retry MUST reconcile the same state without duplicate Assets, objects, Jobs, or deliveries.
- **FR-013**: Without a valid commit before the durable deadline, stale detection MUST fail the Job with `IMPORT_COMMIT_TIMEOUT` while preserving safe partial progress.
- **FR-014**: Job/preparation state in PostgreSQL is authoritative. Queue transport carries exactly `{ jobId }` and never holds import state or binary data.
- **FR-015**: The private worker MUST reload durable state, honor claim-lock/cancellation rules, and never serve browser requests.
- **FR-016**: Cleanup and compensation MUST be idempotent: an orphan object may be removed only when no durable Asset references it.
- **FR-017**: Authorized users MUST see partial, cancelled, failed, and timed-out import progress until normal retention rules apply.

### Key Entities

- **Prepared Import**: Expiring durable preparation linking requester, Dataset, expected safe manifest, import Job, and idempotency/commit state.
- **Import Manifest Item**: Safe metadata for one expected browser-selected file; never an absolute local path or binary.
- **Import Job**: The common durable `IMPORT_DATASET` Job recording lifecycle, progress, timeout, and safe events.
- **Imported Asset**: The single reconciled Asset metadata record for a verified upload.
- **Commit Signal**: Authorized idempotent action that requests final validation and permits completion only for a complete import.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In authorization tests, 100% of non-member preparation, upload, completion, commit, timeout, and retry attempts disclose no import data and create no side effect.
- **SC-002**: In browser contracts, 100% of requests/responses omit absolute local paths, binary data, credentials, private object references, and queue/lock state.
- **SC-003**: In a complete-folder test, 100% of expected eligible files appear once in the new Dataset with correct Asset modality before the Job reports completed.
- **SC-004**: In incomplete-folder tests, 100% of mismatched commits return `IMPORT_INCOMPLETE` and leave the Job non-completed.
- **SC-005**: In disconnect tests, 100% of imports without commit reach one failed timeout outcome and never appear completed.
- **SC-006**: In duplicate start/completion/commit/stale/retry tests, no logical item creates more than one Asset and no Job creates more than one terminal outcome.
- **SC-007**: A user can preflight and start an import with up to 1,000 eligible files without the backend receiving a binary byte or absolute local path.

## Assumptions

- Existing authentication, Dataset authorization, direct-upload capability, safe Job status, queue contract, and claim-lock rules are reused.
- The import deadline is configurable; the planning default is 30 minutes after start or the last valid progress update.
- A safe logical relative name may be retained for Dataset organization, but no absolute path, drive name, or browser handle is retained or sent.
- The initial scope supports image, video, text, and audio; unsupported types are reported per item.

## Scope Boundaries

- **In scope**: durable preparation, Dataset/import Job creation, folder preflight, batch controlled upload/completion, Asset persistence, commit, timeout, worker processing, progress, cleanup/compensation, idempotent retry, and end-to-end tests.
- **Out of scope**: backend local filesystem access, backend binary proxying, binary in PostgreSQL, credential exposure, repository/Gitea import, annotation or taxonomy creation, modality-specific routes, and Redis/BullMQ as canonical state.
