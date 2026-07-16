# Feature Specification: PostgreSQL Claim Lock and Worker Safety

**Feature Branch**: `008-postgresql-claimlock-worker-safety`  
**Created**: 2026-07-15  
**Status**: Draft  
**Input**: User description: "Ensure multiple BullMQ workers cannot process the same durable Job by using PostgreSQL claim locks, leases, heartbeats, and lock-token-guarded lifecycle updates."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Claim one Job safely (Priority: P1)

As a platform operator, I need concurrent worker deliveries for the same Job to result in at most one active owner so that a retry or duplicate queue delivery cannot process the Job twice.

**Why this priority**: At-least-once queue delivery is expected. A durable ownership claim is required before any worker begins a real business workflow.

**Independent Test**: Deliver the same eligible Job to two worker instances concurrently and verify that exactly one receives a successful claim, while the other performs no processing or lifecycle update.

**Acceptance Scenarios**:

1. **Given** an unlocked Job in `QUEUED` or `RETRYING`, **When** two workers attempt to claim it concurrently, **Then** exactly one worker becomes its owner, receives a new lock token, and the Job becomes `RUNNING`.
2. **Given** a Job already owned by an unexpired lease, **When** another worker attempts to claim it, **Then** the attempt is refused without changing the owner, token, lifecycle, progress, or outcome.
3. **Given** an eligible Job is successfully claimed, **When** ownership is recorded, **Then** the record identifies the worker, records claim/start/dequeue times as applicable, and has a five-minute lease expiry.

---

### User Story 2 - Keep or lose a worker lease safely (Priority: P1)

As a worker, I need to renew my lease and update progress only while I remain the active owner so that a stale or replaced worker cannot overwrite the current execution.

**Why this priority**: A durable token guard prevents a worker that paused, crashed, or lost its lease from corrupting canonical Job state after another execution is allowed to proceed.

**Independent Test**: Claim a Job, renew its lease, then simulate expiry or replacement and verify that the old token cannot renew, report progress, complete, fail, or cancel the Job.

**Acceptance Scenarios**:

1. **Given** a worker holds the current unexpired token, **When** it sends a heartbeat, **Then** the lease expiry and heartbeat time are extended without changing the Job owner or token.
2. **Given** a worker holds the current unexpired token, **When** it reports valid progress, **Then** the durable progress values update while the Job remains owned by that worker.
3. **Given** a token is expired, superseded, malformed, or for another Job, **When** its holder tries to heartbeat or update progress, **Then** the request is refused and no Job fields change.

---

### User Story 3 - Finish only with the current claim (Priority: P2)

As a worker, I need terminal lifecycle changes to require my current lock token so that only the active owner can complete, fail, or cancel a Job.

**Why this priority**: Terminal outcomes are authoritative and must not be overwritten by delayed queue deliveries or a stale worker.

**Independent Test**: Claim a Job, attempt each terminal action using a wrong or expired token, then repeat with the current token and verify that only the current owner can record the terminal outcome.

**Acceptance Scenarios**:

1. **Given** a worker holds the current unexpired token, **When** it completes, fails, or cancels the Job, **Then** the corresponding terminal outcome is recorded once and the active lease is cleared.
2. **Given** a Job has a terminal outcome, **When** any worker attempts another claim or terminal update, **Then** the request is refused and the recorded outcome remains unchanged.
3. **Given** a cancellation request already exists, **When** the current owner performs the approved worker cancellation transition, **Then** the Job becomes cancelled without allowing a stale owner to overwrite it.

### Edge Cases

- A queue message is delivered repeatedly while one worker has a valid lease.
- A worker crashes or pauses until its five-minute lease expires, then attempts a late heartbeat, progress update, or terminal update.
- A Job is cancelled, archived through its Dataset, or becomes terminal before a worker attempts a claim.
- A worker sends an empty, forged, or token/job-id-mismatched ownership proof.
- A progress value is malformed, decreases unexpectedly, exceeds its total, or is sent after a terminal outcome.
- A claim succeeds but a worker is interrupted before it performs business work.
- A `RUNNING` Job lease expires. This feature must prevent its former owner from writing, but must not automatically requeue or reclaim that Job unless a later approved recovery policy transitions it to an eligible state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a claim operation that accepts only a durable Job reference and a worker identity, creates a fresh opaque lock token on success, and returns the token only to the claiming private worker.
- **FR-002**: A claim MUST be one single atomic PostgreSQL guarded `UPDATE … RETURNING` mutation, or an equivalent transaction-safe database operation that has the same one-statement compare-and-set behavior. It MUST succeed only when the existing Job is in `QUEUED` or `RETRYING` and has no unexpired lease. The successful claim MUST atomically set the Job to `RUNNING`, record the worker identity and token, record claim/heartbeat timestamps, establish a five-minute lease, and preserve an existing start or dequeue timestamp rather than replacing it.
- **FR-003**: Concurrent claim attempts for the same Job MUST result in at most one successful claimant. An unsuccessful claimant MUST not modify the Job, create a replacement Job, or begin business processing.
- **FR-004**: Heartbeat, progress, completion, failure, and worker-side cancellation operations MUST require both the Job id and the current unexpired lock token. Worker identity alone is insufficient authorization.
- **FR-005**: A successful heartbeat MUST extend the active lease by five minutes and update the heartbeat time while preserving the current owner and token.
- **FR-006**: A progress update MUST be accepted only from the current token holder for a non-terminal active Job. It MUST validate progress values, preserve canonical counters, and reject stale, invalid, or terminal updates without side effects.
- **FR-007**: Completion and failure MUST be accepted only from the current token holder. Each successful terminal operation MUST record its terminal status/timing once and clear the active lock fields so no later worker can overwrite the outcome.
- **FR-007a**: `cancelJob` is a worker-side cancellation acknowledgement, not a new cancellation request. It MUST transition a Job to `CANCELED` only when the authorized application boundary already requested cancellation, evidenced by `CANCELING` status or a non-null cancellation-request time, and only when the worker supplies the current unexpired lock token.
- **FR-008**: A stale, expired, superseded, empty, forged, or Job-id-mismatched token MUST be unable to heartbeat, update progress, complete, fail, or cancel. Rejection MUST leave all durable Job fields unchanged.
- **FR-009**: This feature MUST keep PostgreSQL as the only claim, lock, lifecycle, progress, and terminal-outcome authority. BullMQ/Redis remains a delivery transport and MUST NOT contain lock tokens, Job input, progress state, or terminal outcome state.
- **FR-010**: Lock tokens, worker-private identifiers, raw errors, Job input/state/result, provider data, credentials, encrypted values, private URLs, storage references, and binary data MUST NOT be exposed to browsers, queue payloads, logs, Job events, or safe Job-status responses.
- **FR-011**: Claim and mutation operations MUST preserve existing Dataset/job authorization boundaries. They are private worker operations and MUST NOT create a browser-facing worker endpoint.
- **FR-012**: The feature MUST use the existing Job lock, lifecycle, timing, progress, cancellation, and terminal-outcome fields as the source of truth. It MUST NOT add a new Job table, change the finalized schema, add a migration, or add a dependency. Queue payloads remain strictly `{ jobId }` and MUST NOT carry a worker identity or lock token.
- **FR-013**: The feature MUST NOT implement repository cloning, import/export, AI, annotation, MinIO artifact creation, automatic retry/requeue scheduling, or any workflow-specific processor. It only establishes safe ownership primitives for a future approved processor.
- **FR-014**: An expired `RUNNING` Job MUST block its former worker from all token-guarded writes. This feature does not itself make that Job claimable again; a future approved recovery policy is responsible for any transition to `RETRYING` or other eligible state.

### Key Entities

- **Job**: The existing durable record that owns lifecycle, lock, lease, heartbeat, progress, cancellation, and terminal outcome information.
- **Worker identity**: A private runtime identifier used for operational attribution of a successful claim; it is not browser-visible authorization data.
- **Lock token**: A fresh opaque ownership proof issued only after a successful claim and required for every worker lifecycle mutation.
- **Lease**: The five-minute period during which the current token holder may update the Job; heartbeats renew it.
- **Claim result**: The private outcome that tells a worker whether it owns the Job and, only on success, provides the token needed for subsequent private operations.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In concurrent-claim integration tests, 100% of repeated two-worker attempts result in exactly one successful claim and one unchanged unsuccessful attempt.
- **SC-002**: In stale-token integration tests, 100% of attempted heartbeat, progress, completion, failure, and cancellation updates using an expired or replaced token are rejected with no durable Job change.
- **SC-003**: In heartbeat tests, 100% of valid heartbeats extend the lease by five minutes while retaining the same worker identity and lock token.
- **SC-004**: In progress and terminal-action tests, 100% of successful mutations require matching Job id and current token; valid terminal operations produce exactly one durable terminal outcome.
- **SC-005**: In queue, API, event, and log inspection tests, 100% of inspected payloads omit lock tokens and all prohibited private Job, provider, credential, storage, and binary data.
- **SC-006**: In regression tests, no duplicate worker claim causes an additional business invocation, replacement Job, or overwrite of a terminal outcome.

## Assumptions

- Phase 007 provides the private queue receipt boundary; Phase 008 adds ownership claiming before any future business handler is allowed to run.
- The existing Job fields for owner, token, lease, heartbeat, progress, cancellation, and terminal timing are finalized and remain the schema source of truth.
- A lock token is generated with sufficient unpredictability and is treated as a server-only secret for its short lifetime.
- The five-minute lease is the required default duration for both a new claim and a successful heartbeat.
- User-initiated cancellation authorization remains governed by the existing application boundary; this feature specifies the token-guarded worker-side cancellation transition only.
- Reclaiming an expired `RUNNING` Job is intentionally out of scope until a dedicated retry/recovery policy is approved.

## Scope Boundaries

- In scope: durable claim ownership, five-minute lease renewal, token-guarded progress and terminal mutations, private worker integration, safe observability, and concurrency/stale-token integration coverage.
- Out of scope: schema changes, queue payload changes, browser worker APIs, automatic reclaim/retry scheduling, business processors, artifacts, notifications, realtime UI, and changes to Dataset authorization.
