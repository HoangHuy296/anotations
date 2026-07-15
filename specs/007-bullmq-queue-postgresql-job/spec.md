# Feature Specification: BullMQ Queue and Durable Jobs

**Feature Branch**: `007-bullmq-queue-postgresql-job`  
**Created**: 2026-07-15  
**Status**: Draft  
**Input**: User description: "Establish queue infrastructure where PostgreSQL Job records remain authoritative before any workflow-specific enqueue feature."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Submit durable background work (Priority: P1)

As an authorized application user, I need a submitted background-work request to receive a durable job reference so that I can safely track its progress even if delivery to a worker is delayed.

**Why this priority**: A durable, observable submission boundary is required before imports, exports, repository operations, or other long-running work can be introduced.

**Independent Test**: Create a permitted test job, simulate normal delivery, and confirm the returned job reference resolves to one durable queued Job with transport metadata recorded only after delivery succeeds.

**Acceptance Scenarios**:

1. **Given** an authorized request with valid, safe job input, **When** background work is submitted, **Then** one durable Job is created and its job reference is returned.
2. **Given** a durable Job and an available queue, **When** delivery succeeds, **Then** the Job records its queue name, queue delivery identifier, and enqueue timestamp.
3. **Given** a browser requests its Job status, **When** the Job belongs to an authorized Dataset, **Then** it receives only the canonical safe status projection derived from the durable Job record rather than queue transport state; the optional safe summary is `null` in this foundation phase.

---

### User Story 2 - Recover delayed delivery without duplicate work (Priority: P1)

As an operator, I need a durable job that was saved but not delivered to be detectable and recoverable so that a transient queue outage does not lose user-requested work or duplicate it on retry.

**Why this priority**: The queue is transport only; a temporary delivery failure must never become a loss of canonical job state.

**Independent Test**: Force a queue-delivery failure after a Job is persisted, confirm it remains eligible for recovery, run one recovery pass, and confirm it becomes delivered without creating a second Job.

**Acceptance Scenarios**:

1. **Given** a durable Job whose initial queue delivery fails, **When** submission returns, **Then** the Job remains queued, has no enqueue timestamp, and retains its original durable input and identity.
2. **Given** a queued Job without an enqueue timestamp, **When** a recovery pass runs after the queue is available, **Then** it delivers that same Job and records the transport metadata.
3. **Given** a Job already recorded as delivered, **When** recovery runs again, **Then** it does not create another Job or another unit of business work.

---

### User Story 3 - Receive private queue deliveries safely (Priority: P2)

As the private worker, I need to receive a minimal delivery reference and resolve all work details from the durable Job so that queues never contain sensitive input or become a second job-state store.

**Why this priority**: Queue messages can be retried or redelivered; they must remain safe and insufficient to reconstruct or execute work without PostgreSQL.

**Independent Test**: Deliver a test job to the private worker and verify that the delivery contains only its job reference, the worker reads the matching Job, records a safe event/dequeue observation, and performs no workflow-specific processing.

**Acceptance Scenarios**:

1. **Given** a queue delivery for a valid Job, **When** the private worker receives it, **Then** it loads the Job from the durable store before making a processing decision.
2. **Given** an unknown, malformed, cancelled, or terminal Job reference, **When** the worker receives it, **Then** it performs no business work and does not create a new Job.
3. **Given** a delivery observation or recoverable delivery failure, **When** it is recorded, **Then** the event contains safe operational information and no credential, provider token, private repository URL, binary content, or full Job input.

### Edge Cases

- Queue delivery succeeds but recording transport metadata is interrupted; a later recovery pass must reconcile the same durable Job without duplicating work.
- A queued Job is cancelled, archived with its Dataset, or reaches a terminal state before delayed delivery or recovery.
- The queue contains a malformed payload, an unknown Job id, or a job id for a Job outside the active recoverable state.
- Queue connectivity is unavailable during submission, recovery, or worker startup.
- Recovery finds multiple eligible Jobs, including repeated scans of the same Job.
- The Job input contains disallowed secret-bearing or binary-bearing fields.
- A browser attempts to infer status from queue identifiers or transport timing rather than the authorized Job record.
- A raw Job summary is malformed, excessive, or contains an unapproved field; it must be omitted rather than forwarded to the UI.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST establish one shared mapping from each supported durable Job type to a queue name; unknown or unsupported types MUST not be delivered.
- **FR-002**: Before attempting delivery, the system MUST create the Job as the canonical record with server-derived creator and Dataset scope, validated safe input, and queued status. It MUST NOT derive canonical state from a queue message.
- **FR-003**: Every queue payload MUST be exactly one object containing only `jobId`. It MUST NOT include Job input, state, result, credentials, encrypted values, provider details, private URLs, binary data, or browser-supplied ownership data.
- **FR-004**: After a successful queue delivery, the system MUST record the mapped queue name, queue delivery identifier, and enqueue time on that same Job. These fields are transport metadata and MUST NOT replace Job status, input, attempts, result, or terminal outcome.
- **FR-005**: If durable Job creation succeeds but queue delivery fails, the Job MUST remain queued, retain a null enqueue time, and be eligible for later recovery. The system MUST return the durable Job reference without claiming that delivery succeeded.
- **FR-006**: The recovery scanner MUST identify recoverable queued Jobs with no enqueue time and attempt delivery of the existing Job only. It MUST not create a replacement Job, alter Job input, or emit duplicate business artifacts.
- **FR-007**: The worker MUST accept only the minimal job-reference payload, load the Job from PostgreSQL, and record safe dequeue/event observations. This phase MUST NOT implement clone, import, export, synchronization, AI, annotation, or other workflow-specific business processing.
- **FR-008**: The system MUST write append-only safe Job events for delivery and recovery observations. Event messages and data MUST exclude secrets, tokens, encrypted source-connection values, private repository URLs, storage credentials, binary data, and full Job input.
- **FR-009**: Any authorized Job-status read for the frontend MUST use the durable Job record as its sole state source. Redis/BullMQ state may be used only for internal delivery diagnostics and MUST NOT be presented as authoritative user status.
- **FR-010**: The authorized Job-status response MUST have the canonical `SafeJobStatus` shape below. Its optional summary is nullable and must be a sanitized, explicitly allowlisted UI DTO; it MUST NOT be the raw persisted Job `summary` object.

  ```ts
  type JobSafeSummary = {
    message?: string
    outcome?: "completed" | "failed" | "canceled"
    completedAt?: string
    resultCount?: number
  }

  type SafeJobStatus = {
    id: string
    datasetId: string
    type: JobType
    status: JobStatus
    stage: JobStage | null
    progress: number | null
    totalItems: number | null
    processedItems: number | null
    successCount: number | null
    failedCount: number | null
    skippedCount: number | null
    summary: JobSafeSummary | null
    createdAt: string
    updatedAt: string
  }
  ```

  `message` must be sanitized plain display text; `outcome` is limited to the listed values; `completedAt` is an ISO timestamp; and `resultCount` is a non-negative whole number. Any absent, malformed, or unapproved raw-summary value results in `summary: null` or omission of that allowlisted member.
- **FR-011**: The Job-status response MUST NOT return full Job input, state, result, raw JobEvent data, raw errors, source-connection data, repository secrets, queue internals, private storage keys, private URLs, credentials, encrypted values, or binary data.
- **FR-012**: During this queue-foundation phase, no business processing produces a UI summary; the safe Job-status response MUST return `summary: null` for worker-received foundation Jobs.
- **FR-013**: Job creation, status access, cancellation checks, recovery, and worker receipt MUST preserve existing Dataset authorization and IDOR protections. A caller outside the Job Dataset MUST receive no Job metadata.
- **FR-014**: Retry and recovery behavior MUST be idempotent: repeated submission handling, recovery scans, or redelivery of the same Job must not create another durable Job or duplicate future work.
- **FR-015**: The system MUST expose no public worker endpoint and MUST keep queue and provider credentials server-side.
- **FR-016**: This phase MUST use the existing Job and JobEvent schema, including `queueName`, `queueJobId`, `enqueuedAt`, and `dequeuedAt`, as the source of truth. It does not authorize a Prisma schema change, migration, new Job table, or new dependency.
- **FR-017**: The implementation plan MUST place web queue submission concerns under `apps/web/src/lib/queue/`, worker queue concerns under `apps/worker/src/queue/`, and worker Job-event writing under `apps/worker/src/jobs/`, using the named files supplied in the phase request unless an approved plan documents a necessary equivalent.
- **FR-018**: A fake Job used for acceptance tests MUST be isolated test/support behavior. This phase MUST NOT add an unauthenticated or general-purpose production endpoint for arbitrary fake Job creation.

### Key Entities

- **Job**: The Dataset-scoped durable record that owns validated input, lifecycle, attempts, result metadata, cancellation state, and queue transport metadata.
- **JobEvent**: An append-only, safe operational record associated with one Job; it never stores credentials, binary content, or full Job input.
- **Queue delivery**: A transient request to process one existing Job, represented only by its `jobId`.
- **Queue mapping**: The controlled association between a supported durable Job type and its delivery queue.
- **Recovery candidate**: An existing queued Job with no enqueue timestamp that may be safely redelivered by the recovery scanner.
- **JobSafeSummary**: A nullable, explicitly allowlisted UI DTO derived from safe durable Job information. It is never a raw persisted JSON field and remains `null` while this phase has no business processing.
- **SafeJobStatus**: The canonical Dataset-authorized browser status projection. It maps safe progress/counter values from the durable Job and excludes transport internals and all sensitive or raw Job fields.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In integration testing, 100% of successful test-job submissions create exactly one durable Job and record queue transport metadata on that same Job after delivery succeeds.
- **SC-002**: In simulated queue-delivery failure testing, 100% of persisted Jobs remain discoverable as queued with no enqueue timestamp and are recoverable without creating a second Job.
- **SC-003**: In integration testing, 100% of worker deliveries contain only one Job reference and cause the worker to resolve the matching durable Job before any handling decision.
- **SC-004**: In authorization testing, 100% of non-member and cross-Dataset Job-status requests return no protected Job metadata and cause no delivery, event, or durable-record side effect.
- **SC-005**: In payload and event inspection, 100% of tested queue payloads and Job events omit full Job input, credentials, tokens, encrypted values, private URLs, and binary content.
- **SC-006**: Repeating a recovery scan for an already delivered test Job produces no additional durable Job and no duplicate future-work invocation in 100% of tested cases.
- **SC-007**: In status-projection tests, 100% of responses match the safe allowlisted shape, expose no prohibited Job or queue data, and return `summary: null` for foundation Jobs without business processing.

## Assumptions

- Phase 004 authentication/ownership guards remain the only browser authorization boundary; this feature reuses them and does not broaden Dataset access.
- The existing Job and JobEvent models are final for this phase and already provide the four queue transport fields required by the Architecture Lock.
- The queue infrastructure already has an approved Redis/BullMQ runtime connection from the foundation phase; this feature adds its durable delivery contract, not another queue technology.
- Initial acceptance coverage may use a supported existing Job type and a test fixture, but no repository clone, import, export, or other business workflow is activated.
- Delivery is at-least-once transport. Duplicate delivery is expected to be harmless because the worker always resolves the same durable Job and later workflow phases must retain idempotency controls.
- Browser-visible job-status UI/API expansion beyond the minimal authorized status-read boundary is out of scope unless explicitly included during planning.
- Future workflow phases may populate `JobSafeSummary` only through a reviewed sanitizer that maps the raw persisted summary to the explicit allowlist; they must not widen the status projection by forwarding arbitrary JSON.

## Scope Boundaries

- In scope: durable Job creation/enqueue coordination, queue mapping, worker receipt/routing, safe JobEvent writing, recovery-scan skeleton, authorized durable status reading, and integration tests with real PostgreSQL and Redis.
- Out of scope: repository cloning, import/export processing, MinIO artifact creation, job-specific business handlers, source-connection lifecycle, notification UI, realtime streaming, and replacing the legacy Gitea binary-cache route identified in the prior architecture audit.
