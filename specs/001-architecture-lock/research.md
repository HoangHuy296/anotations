# Phase 0 Research: Architecture Lock

## Decision 1: Keep the request-serving application as the validation and submission boundary

**Decision**: The application backend accepts authenticated requests, validates
them, writes durable metadata, and submits background work. It does not clone
repositories or perform long-running processing.

**Rationale**: Next.js Route Handlers provide server-side request boundaries,
while long-running cloning has a different lifecycle from a user request. This
separates a prompt user response from retryable private processing.

**Alternatives considered**:

- Clone repositories inside a request handler — rejected because it couples
  long-running, retryable work to the request lifecycle.
- Clone repositories in browser code — rejected because it would expose
  provider credentials and bypass server authorization.

**Reference**: [Next.js Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers).

## Decision 2: PostgreSQL Job is authoritative; BullMQ/Redis is transport only

**Decision**: Create and maintain one durable Job record in PostgreSQL. Submit
only `{ jobId }` to BullMQ. The worker resolves the Job from PostgreSQL before
performing work and records progress and terminal state there.

**Rationale**: Queue jobs contain arbitrary data and queue operations can be
retried, removed, or re-delivered. A minimal pointer payload prevents a second
authoritative copy of job input and state in Redis.

**Alternatives considered**:

- Treat the BullMQ job as the source of truth — rejected because it conflicts
  with FR-002 and makes relational auditing and querying dependent on queue
  retention.
- Put the full Job input in Redis — rejected by FR-003 and because it
  duplicates sensitive and mutable data.

**Reference**: [BullMQ Job API](https://api.docs.bullmq.io/classes/v5.Job.html), [BullMQ Queue API](https://api.docs.bullmq.io/classes/v3.Queue.html).

## Decision 3: Store binary assets and artifacts in private object storage

**Decision**: Store source clones, asset bytes, derived assets, and generated
exports in MinIO. PostgreSQL stores only metadata and object references.

**Rationale**: Object storage separates large binary lifecycle, access control,
and retention from relational metadata. It satisfies the prohibition against
binary database storage.

**Alternatives considered**:

- Store binary values in PostgreSQL — rejected by FR-004.
- Store binary values on the public web filesystem — rejected because public
  paths and application deployments cannot safely enforce private access and
  lifecycle controls.

## Decision 4: Use a common Job model for all asynchronous workflows

**Decision**: Imports, exports, repository synchronization, and future
long-running operations use the same Job lifecycle and type discriminator.

**Rationale**: A shared model centralizes retries, idempotency, auditing, and
terminal state handling without multiplying nearly identical tables.

**Alternatives considered**:

- `ImportJob`, `ExportJob`, and `RepositorySyncJob` tables — rejected by
  FR-011 because they fragment one lifecycle.

## Decision 5: Preserve modality and annotation concurrency as domain rules

**Decision**: Asset.modality determines the workspace engine within one
workspace route. Annotation.geometry is the canonical shape and
Annotation.version is compared on every autosave or update.

**Rationale**: The rule supports new modalities without a forked navigation
model, while version comparison prevents stale clients from silently replacing
newer geometry.

**Alternatives considered**:

- A route per modality — rejected by FR-007.
- Last-write-wins autosave without version comparison — rejected by FR-008.

## Decision 6: Make retries idempotent at the durable-record and binary-object boundary

**Decision**: A retry uses the same Job identity and derives deterministic
operation/object identities from the durable record. A worker must inspect the
durable result or object reference before creating a replacement binary object.

**Rationale**: Redelivery is normal queue behavior. Stable identities and a
check-before-create rule prevent duplicate assets or artifacts.

**Alternatives considered**:

- Always create a new output on each retry — rejected by FR-010.
- Depend only on transient queue deduplication — rejected because it does not
  make PostgreSQL the authority and may not survive retention or replay.
