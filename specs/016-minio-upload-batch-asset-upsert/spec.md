# Feature Specification: MinIO Upload + Batch Asset Upsert

**Feature Branch**: `016-minio-upload-batch-asset-upsert`  
**Created**: 2026-07-27  
**Status**: Draft  
**Input**: User description: "Phase 016 — MinIO Upload + Batch Asset Upsert"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Import Repository Files into a Usable Dataset (Priority: P1)

After a repository import request has been accepted, the dataset owner can rely
on the background import to make supported repository files available as stable
dataset Assets.

**Why this priority**: This is the first point at which an accepted repository
import delivers usable content to the annotation product.

**Independent Test**: Start with one accepted `IMPORT_DATASET` Job containing a
safe, bounded repository selection. Run the private worker and verify that
supported files become Assets with stable storage references and that the Job
finishes with an accurate safe summary.

**Acceptance Scenarios**:

1. **Given** an authorized repository import Job with supported files,
   **When** the worker processes it, **Then** every successfully processed file
   is copied into private storage and appears as an Asset in the correct
   Dataset.
2. **Given** source files of different supported modalities, **When** they are
   imported, **Then** each Asset has the correct modality and its corresponding
   metadata record without creating metadata records for another modality.
3. **Given** a user opens the Dataset after the Job completes, **When** they
   view its Assets, **Then** the files are available through the existing
   authorized asset access flow rather than a repository URL.

---

### User Story 2 - Safely Resume an Interrupted Import (Priority: P1)

An owner does not receive duplicate Assets or duplicate copied files when a
repository import Job is retried or delivered more than once.

**Why this priority**: Reliable retry is required before background imports can
be trusted with real repositories.

**Independent Test**: Interrupt or repeat delivery of a Job after at least one
batch has completed, then verify the same source files resolve to the original
Assets and copied objects rather than duplicates.

**Acceptance Scenarios**:

1. **Given** a file was successfully imported before an interruption, **When**
   the same Job is processed again, **Then** the system reuses that file's
   stable source identity and does not create another Asset or object.
2. **Given** a source file changed at a later immutable repository revision,
   **When** it is imported, **Then** it is treated as a distinct source version
   rather than overwriting an unrelated Asset.
3. **Given** two worker deliveries race for the same Job, **When** one worker
   holds the current Job lock, **Then** the other delivery cannot make durable
   progress or duplicate Assets.

---

### User Story 3 - Understand Import Outcome Without File-Level Noise (Priority: P2)

A dataset owner can see aggregate import progress and a useful final outcome
without exposing repository credentials, provider internals, or one event per
file.

**Why this priority**: Repository imports may contain many files; users need
clear, bounded progress information.

**Independent Test**: Import a mixture of valid, unsupported, and deliberately
failing files. Verify that progress advances by batches, the final safe summary
reports imported/skipped/failed counts, and events are emitted per batch only.

**Acceptance Scenarios**:

1. **Given** an import with more than one batch, **When** each batch completes,
   **Then** the Job progress and one aggregate batch event are updated.
2. **Given** individual file failures that do not prevent remaining files from
   being processed, **When** the import ends, **Then** the final summary
   contains aggregate failed and skipped counts without raw provider errors.
3. **Given** an authorized user reads Job status, **When** the Job is complete,
   **Then** they receive only the approved safe status/summary projection from
   durable Job data.

### Edge Cases

- If a Job is canceled between batches, the worker stops safely, acknowledges
  cancellation through the existing lock-token lifecycle, and does not begin a
  new batch.
- If an eligible SourceConnection becomes invalid or revoked before source
  access, the worker fails the Job safely without writing credentials or raw
  provider details to Job output.
- If a repository file is unsupported, exceeds a server-controlled limit, or
  cannot be downloaded, it is counted as skipped or failed according to the
  established import policy; other eligible files continue where safe.
- If object upload succeeds but the associated Asset cannot be persisted, the
  worker must not leave a duplicate or unreferenced object after retry/cleanup.
- A final partial batch may contain fewer files than the configured batch size;
  all non-final batches use a bounded size between 50 and 200 files.
- A fatal provider, lock, storage, or database failure leaves an accurate safe
  terminal Job outcome; it must not be reported as a successful import.
- No browser receives a repository token, private repository address, storage
  credential, raw object key, or raw error report.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The private worker MUST process only an authorized, claimed
  `IMPORT_DATASET` Job that was accepted by the repository-import request
  boundary and whose authoritative state is read from PostgreSQL.
- **FR-002**: Before source access, the worker MUST re-resolve required source
  connection eligibility and revalidate the repository source through the
  approved server-only provider controls; it MUST never obtain credentials from
  a queue payload or browser input.
- **FR-003**: The worker MUST scan only the safe repository selection attached
  to the accepted Job and must classify each eligible file into a supported
  modality before creating an Asset.
- **FR-004**: For every eligible source file, the worker MUST obtain its
  content through the approved source download capability and mirror it into
  private object storage using the MVP storage mode `MIRROR_TO_MINIO`.
- **FR-005**: The worker MUST derive a stable `sourceFingerprint` from safe
  source provenance: Dataset, provider/repository identity, immutable resolved
  revision, normalized source path, and provider file identity when available.
  It MUST use that identity to avoid duplicates during redelivery or retry.
- **FR-006**: Each successfully mirrored file MUST have one Asset metadata
  record with its Dataset, modality, safe source provenance, storage reference,
  byte size, and `sourceFingerprint`. The corresponding modality-specific
  metadata record MUST exist exactly once; incompatible child metadata records
  MUST not be created.
- **FR-007**: Asset persistence MUST use bounded batch upsert operations. A
  configured batch size MUST be no lower than 50 and no higher than 200 for
  non-final batches; browser requests cannot alter this policy.
- **FR-008**: Reprocessing the same source fingerprint for a Dataset MUST
  reuse or safely reconcile the existing Asset and object. It MUST NOT create
  duplicate Asset rows, child metadata rows, or copied objects.
- **FR-009**: The worker MUST update Job progress, counters, stage, and final
  state only through the existing PostgreSQL lock-token lifecycle. Redis/BullMQ
  remains delivery transport and receives no source content, credentials, file
  metadata report, or canonical progress state.
- **FR-010**: The worker MUST create JobEvents at batch granularity only. It
  MUST NOT create a JobEvent per source file. File-level outcomes belong only
  in bounded safe summary/error-report data.
- **FR-011**: On normal completion, the Job safe summary MUST report imported,
  skipped, and failed counts and the Job MUST become `COMPLETED` when all
  batches have reached a final outcome. A nonrecoverable failure or cancellation
  follows the existing `FAILED` or `CANCELED` lifecycle instead.
- **FR-012**: The worker MUST clean up temporary downloaded files/streams and
  safely remove unpublished objects after a persistence failure. It MUST never
  delete an object already referenced by an Asset or an object outside the
  current Job's controlled import scope.
- **FR-013**: The product MUST expose repository-import progress only through
  the existing authorized safe Job status projection. It MUST NOT expose raw
  Job input/state/result, file-level provider diagnostics, repository
  credentials, storage credentials, private source locations, queue internals,
  or binary data.
- **FR-014**: The phase MUST not add workflow-specific Job tables, store binary
  data in PostgreSQL, use Redis as Job state, or create a browser-facing worker
  endpoint.

### Key Entities *(include if feature involves data)*

- **Repository import Job**: The existing durable request that identifies one
  Dataset and safe source selection. It is the authoritative lifecycle and
  aggregate-progress record.
- **Source file candidate**: An ephemeral, bounded representation of one file
  found at the accepted immutable source revision. It is never queue payload
  data or a full persisted manifest.
- **Mirrored object**: The private copy of an eligible source file used for
  stable workspace access. It is identified by a controlled storage reference,
  not stored as bytes in product metadata storage.
- **Asset**: The durable metadata record for one mirrored source file, including
  modality, source provenance, storage reference, and stable fingerprint.
- **Source fingerprint**: The deterministic source identity used to reconcile
  the same file across delivery/retry without treating a different immutable
  revision as the same file.
- **Batch outcome**: Aggregate imported, skipped, and failed counts for a
  bounded group of files; it supplies progress and one batch-level event.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In controlled end-to-end imports of supported repository files,
  100% of successfully processed files have one usable Dataset Asset and one
  corresponding private copied object.
- **SC-002**: In controlled retry and duplicate-delivery tests, 100% of source
  fingerprints already accepted for a Dataset result in zero duplicate Assets,
  child records, or copied objects.
- **SC-003**: For an import larger than two configured batches, users can see
  aggregate progress advance after every completed batch and receive no more
  than one Job event per batch.
- **SC-004**: In a mixed valid/unsupported/failing controlled import, the final
  safe summary's imported, skipped, and failed counts equal the final source
  file outcomes, and no credential or raw provider diagnostic appears in the
  user-visible status.
- **SC-005**: In controlled cancellation, source-connection invalidation,
  storage failure, and database failure tests, the Job reaches the correct
  final safe state and leaves no unreferenced object in the Job's import scope.
- **SC-006**: Authorized users can access every successfully imported file
  through the product's existing asset access flow; unauthorized users cannot
  obtain asset metadata or a file-access capability by guessing identifiers.

## Assumptions

- Phase 015 has been implemented and its approved request/queue boundary
  creates a safe `IMPORT_DATASET` Job before this worker phase runs.
- Existing PostgreSQL claim-lock, heartbeat, progress, completion, failure,
  cancellation, JobEvent, safe Job-status, MinIO, and SourceConnection security
  boundaries remain authoritative and are reused.
- The existing Asset schema's Dataset-scoped `sourceFingerprint` uniqueness and
  modality child metadata relations are sufficient; no schema migration is
  assumed for this phase.
- The accepted repository request resolves an immutable revision before worker
  processing. The worker does not clone a repository into a browser-visible or
  long-lived local workspace.
- The final configured batch size and file/import limits are deployment policy
  within the stated 50–200 range; they are not browser inputs or database
  fields.
- Full repository synchronization/version history, annotation import, derived
  thumbnails, and UI enhancements beyond existing safe Job progress remain out
  of scope.
