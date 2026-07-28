# Feature Specification: Repository Import Request + Queue Enqueue

**Feature Branch**: `015-repository-import-request-queue-enqueue`  
**Created**: 2026-07-27  
**Status**: Draft  
**Input**: User description: "Phase 015 — Repository Import Request + Queue Enqueue"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Start a Valid Repository Import (Priority: P1)

A permitted user creates a new Dataset from a repository after reviewing a
successful repository preflight. The user is taken to the import progress page
for the newly accepted import request.

**Why this priority**: This is the first durable handoff from a validated
repository selection to background import work.

**Independent Test**: Through normal sign-in, submit a valid public repository
request and verify one Dataset and one import Job are created, the worker
delivery contains only that Job identifier, and the progress page opens.

**Acceptance Scenarios**:

1. **Given** a signed-in user with permission to create a Dataset and a valid
   public repository selection, **When** they submit the Create from Repository
   wizard, **Then** one new Dataset and one queued import Job are accepted and
   the user is directed to that Job's progress page.
2. **Given** a private repository and an active SourceConnection owned by the
   signed-in user, **When** the user submits a valid selection, **Then** the
   import request references that connection without revealing its credential.
3. **Given** a user supplies a one-time Gitea PAT and explicitly chooses to
   save it, **When** preflight succeeds and they start import, **Then** the
   PAT is encrypted into one owned SourceConnection in the same durable
   transaction as the Dataset and Job; no plaintext credential is persisted.
3. **Given** a user submits the same accepted request again using the same
   idempotency key, **When** the first request has already been accepted,
   **Then** the existing accepted request is returned without creating another
   Dataset, Job, or delivery.

---

### User Story 2 - Reject Unsafe or Inaccessible Repositories Before Writing (Priority: P1)

A user receives a safe explanation when the repository URL, reference, root,
or credential is invalid, inaccessible, expired, or unsafe. Nothing is left
behind for the worker to process.

**Why this priority**: Avoiding orphaned Datasets and Jobs is the security and
operational purpose of this phase.

**Independent Test**: Submit each invalid repository condition through the
authenticated request boundary and compare Dataset, Job, event, queue, and
storage snapshots before and after.

**Acceptance Scenarios**:

1. **Given** an unsafe or malformed repository address, **When** the user
   submits the wizard, **Then** the request is rejected before a Dataset or Job
   exists.
2. **Given** an invalid, expired, revoked, foreign, or inaccessible private
   SourceConnection, **When** the user submits the wizard, **Then** the user
   receives the established safe error and no queue delivery is made.
3. **Given** a valid repository address but an unknown reference or root path,
   **When** the user submits the wizard, **Then** no Dataset, Job, event,
   object, or delivery is created.

---

### User Story 3 - Observe the Accepted Import Safely (Priority: P2)

After a valid request is accepted, the user can open a Dataset-scoped import
progress page and see safe, durable status information.

**Why this priority**: Users need a clear handoff after submission without
depending on transport internals.

**Independent Test**: Open the returned progress URL as the owner and verify
the displayed request belongs to the Dataset; a non-member cannot read it.

**Acceptance Scenarios**:

1. **Given** an accepted import request, **When** its owner opens the returned
   progress page, **Then** they see its safe status and may navigate to its
   Dataset.
2. **Given** a user outside the Dataset scope, **When** they open a guessed
   Dataset or Job URL, **Then** the resource is concealed and no internal
   request data is shown.

---

### Edge Cases

- A public repository must not require or persist a SourceConnection.
- A private repository may use an active owned SourceConnection or a one-time
  PAT only when `saveAsSourceConnection=true`; an unsaved one-time PAT is
  rejected with `ONE_TIME_PAT_REQUIRES_SAVE_FOR_ASYNC_IMPORT`.
- A delivery failure after durable acceptance must leave the queued Job
  recoverable rather than deleting or duplicating it.
- A browser retry or double click must not create duplicate Dataset, Job, or
  queue deliveries for the same idempotency key.
- The progress page must not expose repository credentials, raw Job input,
  queue identifiers, provider diagnostics, or private storage locations.
- Repository cloning, manifest persistence, binary transfer, Asset creation,
  and worker business processing remain outside this phase.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The product MUST provide the Create from Repository workflow at
  `/datasets/imports` and a Dataset-scoped import progress page at
  `/datasets/[datasetId]/imports/[jobId]`. `/datasets/new` is retained only as
  a redirect to the canonical entry; it is not a second creation flow.
- **FR-002**: The wizard MUST require a repository provider, repository
  identity, requested ref, optional root path, Dataset name, expected
  visibility, and an idempotency key. It supports only `PUBLIC`,
  `EXISTING_SOURCE_CONNECTION`, and `ONE_TIME_PAT` credential modes. A PAT is
  transient request data only and is accepted solely for Gitea one-time
  preflight/start with `saveAsSourceConnection=true`; it must never reach a
  hash, Dataset metadata, Job input, queue payload, response, or log.
- **FR-003**: The authenticated request endpoint `POST
  /api/datasets/from-repository` MUST authorize Dataset creation and repository
  access from the server-side actor, never from browser-supplied ownership.
- **FR-004**: Before any durable write, the system MUST repeat the approved
  read-only repository preflight and enforce repository URL, provider,
  reference, root-path, visibility, SourceConnection ownership, eligibility,
  and import-limit policy.
- **FR-005**: A failed preflight or authorization check MUST create no Dataset,
  Job, JobEvent, queue delivery, storage object, persisted manifest, or
  SourceConnection.
- **FR-006**: A valid request MUST create exactly one Dataset and one durable
  import Job as one controlled acceptance boundary; the Job MUST retain only
  allowlisted repository identity, resolved revision, root selection, bounded
  preview/manifest metadata, and a SourceConnection identifier when required.
- **FR-007**: A public import MUST have no SourceConnection reference. An
  existing-connection import MUST use an active, owned SourceConnection. A
  one-time-PAT async import MUST create exactly one encrypted owned
  SourceConnection in the accepted transaction and requires an explicit name
  and save flag. Browser tokens, decrypted credentials, and encrypted
  credential material MUST not be placed in Dataset metadata, Job input,
  events, responses, or queue transport.
- **FR-008**: After durable acceptance, the system MUST request one background
  delivery whose payload is exactly `{ jobId }`. If delivery cannot be made,
  the queued Job MUST remain recoverable through the existing recovery
  contract.
- **FR-009**: Repeating an accepted request with the same actor and
  idempotency key MUST return the same Dataset/Job acceptance result and MUST
  NOT create a duplicate Dataset, Job, event, or delivery.
- **FR-010**: On valid acceptance, the UI MUST navigate to the returned
  Dataset/Job progress page. The page MUST source safe status from durable Job
  state, not queue transport state.
- **FR-011**: Dataset and Job reads on the progress page MUST apply existing
  ownership and membership guards and conceal out-of-scope resources.
- **FR-012**: All request and error responses MUST remain redacted: no
  credentials, tokens, encrypted values, private repository URL, raw provider
  error, raw Job input, queue internals, storage capability, configuration, or
  stack trace may be returned.
- **FR-013**: This phase MUST reuse the approved repository preflight and
  source-backed import acceptance boundary; it MUST NOT introduce a parallel
  legacy import path or a workflow-specific Job table. `POST
  /api/source-import-preflight` is read-only and `POST
  /api/datasets/from-repository` is the only public durable creation boundary;
  `POST /api/source-import-jobs` is deprecated with `410
  SOURCE_IMPORT_JOBS_DEPRECATED`.

### Key Entities *(include if feature involves data)*

- **Repository import request**: A user-intended creation of a Dataset from a
  validated repository selection, identified by an idempotency key.
- **Dataset**: The central imported-data container created only after the
  repository request is valid and authorized.
- **Job**: The durable, authoritative record for the accepted import request
  and its later progress; its queue delivery is not authoritative state.
- **SourceConnection**: An optional user-owned credential reference required
  for private repository access; its secret never becomes import request data.
- **Repository preflight result**: A transient safe confirmation of repository,
  revision, root, visibility, and bounded preview eligibility.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In controlled authenticated tests, 100% of invalid URL,
  credential, ref, root, authorization, and policy cases leave no new Dataset,
  Job, event, delivery, or storage object.
- **SC-002**: In controlled authenticated tests, each valid unique repository
  request produces one Dataset, one durable Job, and one delivery carrying only
  the Job identifier.
- **SC-003**: In controlled authenticated tests, repeated submission with the
  same idempotency key produces zero duplicate Datasets, Jobs, or deliveries.
- **SC-004**: An authorized user reaches the progress page for every accepted
  request, while an out-of-scope user cannot obtain the Dataset or Job details.
- **SC-005**: All success and failure response audits contain zero credential,
  raw provider, queue, storage, configuration, or stack-trace fields.

## Assumptions

- The Phase-014 repository preflight contract and Phase-013 SourceConnection
  security layer are available and remain authoritative.
- The approved source-backed import acceptance boundary can be reused rather
  than creating a second Dataset/Job creation path.
- Public repositories use anonymous access; private repositories use an
  existing active owned SourceConnection. A new credential lifecycle is out of
  scope for this phase.
- The next worker-processing phase will perform repository cloning and asset
  persistence after this phase has safely accepted and delivered the request.
