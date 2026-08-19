# Feature Specification: Production Hardening and Garbage Collection

**Feature Branch**: `021-production-hardening-garbage-collection`

**Created**: 2026-08-17

**Status**: Draft

**Input**: User description: "Harden the current Annotation Platform for production use: reliability, recovery, cleanup, scalability, observability, and deployment safety across the existing PostgreSQL + Redis/BullMQ + MinIO architecture, without introducing new product features or changing existing API contracts, workspace behavior, annotation behavior, AI task behavior, or import/export behavior. Covers: a recovery scanner for jobs stuck after a worker crash, explicit detection of runaway RUNNING jobs, an import commit-timeout detector, BullMQ stalled-job handling, Redis reconnection handling that never drops a durable Job, dead-letter handling for jobs that exhaust retries, JobEvent retention cleanup, rate limiting on job-creating endpoints, pagination for large collections (including 10-per-page Assets tab pagination and a Name/Color/Color-code label creation form in the workspace Properties Panel, plus clarifying the purpose of the 'Add defaults' button), structured logging, basic health/metrics observability, a MinIO orphan scanner with dry-run mode, deleted-asset and deleted-dataset storage cleanup jobs, temporary-upload cleanup, an optional MinIO lifecycle policy, safety invariants for all garbage collection, scheduling of these maintenance tasks with cross-worker coordination, verification that multiple worker instances never process the same Job concurrently, and Docker Compose verification that PostgreSQL, Redis, MinIO, web, and worker start together."

## User Scenarios & Testing *(mandatory)*

<!--
  IMPORTANT: User stories should be PRIORITIZED as user journeys ordered by importance.
  Each user story/journey must be INDEPENDENTLY TESTABLE - meaning if you implement just ONE of them,
  you should still have a viable MVP (Minimum Viable Product) that delivers value.
-->

### User Story 1 - Stuck and Runaway Jobs Recover Without Human Intervention (Priority: P1)

As a platform operator, when a worker process crashes, loses connectivity, or a job runs far longer than it should, I need the platform to notice on its own, safely recover or fail the job, and eventually give up cleanly on jobs that can never succeed — so that annotation work, imports, exports, and AI tasks never appear to vanish or hang forever, and I never have to manually inspect the database to find and fix a stuck job.

**Why this priority**: Without this, a single worker crash silently strands a user's import, export, or AI task forever. This is the foundational reliability guarantee every other production-hardening capability in this feature builds on.

**Independent Test**: Simulate a worker that claims a job and then stops sending heartbeats (crash simulation). Verify the job is later recovered or safely failed — without ever being processed twice, without losing its event history, and without a human touching the database.

**Acceptance Scenarios**:

1. **Given** a job whose owning worker stopped renewing its lease past the configured recovery threshold, **When** the recovery pass next runs, **Then** the job is made eligible for re-processing (or retried, per the existing retry budget) exactly once, its existing retry/attempt count increases, and a record is added to its event history describing the recovery.
2. **Given** a job whose lease is still valid (its owning worker is heartbeating normally), **When** the recovery pass runs, **Then** that job is left untouched.
3. **Given** a job has already been recovered once and the recovery pass runs again before any worker claims it, **When** the pass re-evaluates that job, **Then** no duplicate recovery action is taken and no second job is created.
4. **Given** a job that has been actively running (not just claimed) longer than its configured maximum allowed runtime, **When** the stale-job detector runs, **Then** the job is transitioned to a failed or retryable outcome consistent with its existing lifecycle rules, the reason is recorded, and the job is never silently deleted.
5. **Given** a job whose retry attempts have reached its configured maximum, **When** it fails again, **Then** it is moved to a final, clearly observable failed outcome instead of being retried again, its original record, failure reason, and full event history are preserved, and no further automatic retry is attempted.
6. **Given** two worker instances are both running the scheduled recovery pass at the same time, **When** their passes overlap, **Then** only one of them acts on any given stale job.

---

### User Story 2 - Queue and Cache Outages Never Lose a Job (Priority: P1)

As a platform operator, I need a temporary Redis or queue outage — or a worker losing its connection mid-task — to never cause a job to disappear, be silently dropped, or be reported as accepted when it was not actually queued, so that users can trust that once they submit work, it either runs or is visibly, honestly reported as failed.

**Why this priority**: The queue is a transport layer, not the source of truth; if a Redis blip could make a job vanish, none of the other reliability guarantees in this feature would matter. This must hold before dead-letter handling or recovery scanning can be trusted.

**Independent Test**: Submit a request that creates a job while Redis is unreachable, and verify the job's durable record either is not created as "queued" or is later automatically delivered once Redis returns — never silently lost, never falsely reported as queued.

**Acceptance Scenarios**:

1. **Given** Redis is unavailable at the moment a job would be enqueued, **When** the enqueue attempt fails, **Then** the job's durable record is not marked as successfully queued, the failure is recorded, and the caller receives an honest error rather than a false success.
2. **Given** a job's durable record exists but its queue delivery failed or never happened, **When** Redis becomes available again, **Then** the job becomes eligible for delivery without a human re-submitting it and without creating a duplicate job record.
3. **Given** a worker loses its connection to Redis while a job is actively running, **When** the connection is lost, **Then** the job's durable state is not corrupted, and the job later resolves through the same recovery/stale-detection guarantees as a crashed worker.
4. **Given** BullMQ reports a job as stalled, **When** the stall is detected, **Then** the job is retried through BullMQ's own mechanism while the durable job record remains the authoritative source of truth for its application-level state, and duplicate concurrent execution of the same job is prevented as far as the architecture allows.

---

### User Story 3 - Imports Never Hang Waiting for a Commit That Never Arrives (Priority: P1)

As a dataset owner running a folder or repository import, I need the system to give up cleanly if the final "commit" signal never arrives — instead of leaving my import stuck forever — while never losing or hiding any assets that were already successfully committed before the timeout.

**Why this priority**: An import that never resolves blocks a dataset from being usable and, without a timeout, requires manual database intervention to unblock — a direct violation of "no indefinite waiting."

**Independent Test**: Start an import, withhold its commit signal past the configured deadline, and verify the import is automatically marked failed with a recorded timeout reason, while any assets already committed before the deadline remain intact and visible in the dataset.

**Acceptance Scenarios**:

1. **Given** an import is waiting for its commit signal and the signal arrives before the deadline, **When** the commit is processed, **Then** the import completes normally and the timeout detector takes no action on it.
2. **Given** an import is waiting for its commit signal and the deadline passes with no commit, **When** the timeout detector next runs, **Then** the import's job is marked failed with a recorded timeout reason, a corresponding event is recorded, and no partially committed dataset is ever presented to the user as successfully imported.
3. **Given** an import already timed out and its record was marked expired, **When** the timeout detector runs again, **Then** no further action is taken and no duplicate failure is recorded.
4. **Given** a worker restarts while an import is mid-commit, **When** the worker comes back, **Then** the import either resumes safely or is caught by the same timeout detector — it is never left permanently ambiguous.

---

### User Story 4 - Deleted Data and Abandoned Uploads Stop Costing Storage (Priority: P1)

As a platform operator, I need storage objects to be reliably cleaned up after an asset or dataset is deleted, and abandoned temporary uploads to eventually expire — without ever risking deletion of an object that is still referenced by an active asset — so that storage costs and clutter don't grow without bound, while data safety is never compromised.

**Why this priority**: Storage is a real, unbounded cost, and unreferenced objects accumulate the moment normal deletion happens; this is the core "garbage collection" promise of the feature and the one with the highest blast radius if done incorrectly, so it is P1 alongside the reliability stories.

**Independent Test**: Delete an asset, verify its storage object is removed by the cleanup job; then simulate a storage outage during another asset's deletion and verify the database deletion still succeeds, the object is later caught and removed by the periodic orphan scan, and at no point is a still-referenced object deleted, including when the scan and the cleanup job are both run twice.

**Acceptance Scenarios**:

1. **Given** an asset is deleted, **When** the deletion completes, **Then** its now-unreferenced storage object is removed by a cleanup job, and the database deletion itself never blocks on or depends on storage being reachable.
2. **Given** an asset's storage object could not be deleted because the storage backend was unavailable, **When** the backend becomes reachable again, **Then** the cleanup job retries and eventually removes the object, or the periodic orphan scanner catches and reports/removes it if the cleanup job never succeeds.
3. **Given** a dataset with many assets is deleted, **When** its cleanup runs, **Then** associated storage objects are identified and removed in batches rather than all at once, and any object still referenced elsewhere in the data model is preserved rather than assumed safe to delete.
4. **Given** the orphan scanner runs in dry-run mode, **When** it finds storage objects with no valid database reference, **Then** it reports them without deleting anything.
5. **Given** the orphan scanner runs outside dry-run mode, **When** it finds a candidate orphan, **Then** it only deletes objects that are both unreferenced and older than the configured grace period, and it never deletes an object it cannot prove is unreferenced.
6. **Given** a temporary upload object has no active upload session and is older than the configured retention period, **When** the temporary-upload cleanup runs, **Then** the object is removed; an object belonging to an active upload session is never removed regardless of age.
7. **Given** any garbage-collection pass (orphan scan, deleted-asset cleanup, deleted-dataset cleanup, or temporary-upload cleanup) is run twice in a row, **When** the second run executes, **Then** the resulting state is identical to running it once — no errors, no duplicate actions, no data loss.

---

### User Story 5 - Job History Stays Bounded Without Losing Recent Debugging Detail (Priority: P2)

As a platform operator, I need old job event history to be cleaned up automatically so the database doesn't grow without bound, while recent events stay available for debugging active or recently finished work.

**Why this priority**: Event history is valuable but unbounded; without retention, the table that supports every debugging and audit story above eventually becomes a performance and cost problem. It depends on the job lifecycle stories above being correct, so it ranks below them.

**Independent Test**: Create job events older than the configured retention window alongside recent ones, run the cleanup, and verify only the old events are removed, in batches, without affecting any active job or its recent events.

**Acceptance Scenarios**:

1. **Given** job events older than the configured retention period exist, **When** the retention cleanup runs, **Then** those events are deleted in bounded batches rather than one large delete, and the operation can be safely re-run without error.
2. **Given** job events newer than the retention period exist, **When** the retention cleanup runs, **Then** those events are left untouched, regardless of whether their job is active or finished.
3. **Given** a job is still active (not in a terminal state), **When** the retention cleanup runs, **Then** none of that job's events are removed even if some are older than the retention window.

---

### User Story 6 - Operators Can See Platform Health at a Glance (Priority: P2)

As a platform operator, I need to see, in one place, whether workers, Redis, and PostgreSQL are healthy, how large the queue backlog is, and how many jobs are active, failed, stale, retried, or dead-lettered, plus a record of what production-critical operations have happened — so I can tell the platform is working correctly without querying the database by hand.

**Why this priority**: Observability doesn't deliver value on its own — it makes the reliability and cleanup guarantees above verifiable in production. It's P2 because the system can technically function correctly without a human watching it, but production operation without any visibility is unacceptably risky.

**Independent Test**: Trigger a job failure, a recovery, and a cleanup pass, then confirm each is visible through the health/observability surface and reflected in structured log output, without any sensitive credentials, tokens, or raw asset content appearing in either.

**Acceptance Scenarios**:

1. **Given** the platform is running, **When** an operator checks system health, **Then** they can determine worker health, Redis health, PostgreSQL health, current queue backlog size, and counts of active, failed, stale, retried, and dead-lettered jobs.
2. **Given** a job is created, queued, claimed, started, completed, failed, retried, recovered, dead-lettered, or canceled, **When** each transition happens, **Then** a structured log entry is produced identifying the job and the transition, without including credentials, signed URLs, access tokens, provider secrets, or raw asset content.
3. **Given** an AI task moves through its lifecycle, **When** each state transition happens, **Then** the log entry includes the AI task ID, job ID, model ID, provider identity, the transition, failure reason (if any), and duration — never the raw provider payload.
4. **Given** a Redis connection failure, reconnect, or enqueue failure occurs, **When** it happens, **Then** it is logged rather than silently swallowed.
5. **Given** a storage upload failure, object deletion failure, or orphan detection occurs, **When** it happens, **Then** it is logged with enough detail to investigate, without exposing credentials or signed URLs.

---

### User Story 7 - The Platform Survives Traffic Spikes Without Falling Over (Priority: P2)

As a platform operator, I need to prevent a single user (accidentally or otherwise) from creating an unbounded number of expensive background jobs — AI tasks, imports, or exports — while legitimate normal usage continues to work without friction.

**Why this priority**: An accidental script loop or a single confused user can otherwise overwhelm workers and storage; this protects the reliability and cost guarantees established above. It's P2 because it's a protective measure rather than a correctness requirement of any single job.

**Independent Test**: Submit AI-task, import, and export requests rapidly as one user past the configured limit, and verify the excess requests are rejected with a consistent, clear error while requests within the limit continue to succeed, and other users are unaffected.

**Acceptance Scenarios**:

1. **Given** a user has submitted job-creating requests (AI task, import, or export) at or above the configured limit within the current window, **When** they submit another, **Then** the request is rejected with a consistent HTTP status and error response, and no job is created.
2. **Given** a user is within their configured limit, **When** they submit a legitimate job-creating request, **Then** it is accepted and processed normally with no added friction.
3. **Given** internal worker processes perform their own operations, **When** they run, **Then** they are not subject to the user-facing rate limit.

---

### User Story 8 - Large Lists Stay Fast and Usable as Data Grows (Priority: P2)

As a user browsing a dataset's assets, labels, annotations, jobs, or job history, I need every list to load quickly and predictably no matter how large the underlying collection has grown, using the same paging controls I already know — and, specifically in the workspace's Properties Panel, I need to browse assets 10 at a time and create a label with a name and a chosen color in the same panel, plus understand what the "Add defaults" button actually does.

**Why this priority**: As datasets, job counts, and job history grow in a production system, any endpoint still returning an unbounded collection becomes a growing performance and reliability risk — but existing paginated workspace behavior must be fully preserved, so this ranks alongside but after the core reliability work.

**Independent Test**: Populate a dataset with well over 10 assets and a job history with many events, then verify every affected list — including the Properties Panel Assets tab — returns a bounded page with working Previous/Next controls, and that creating a label from the Properties Panel Labels tab lets a user pick a name and a color the same way the dedicated labels page does.

**Acceptance Scenarios**:

1. **Given** an endpoint that previously returned an entire unbounded collection (jobs, JobEvents, or another large operational list), **When** it is called without explicit paging parameters, **Then** it returns a bounded first page rather than the entire collection, and an oversized requested page size is capped rather than honored as-is.
2. **Given** the existing workspace asset pagination behavior, **When** this feature is implemented, **Then** that existing behavior and its response shape are unchanged for existing callers.
3. **Given** the Properties Panel's Assets tab for a dataset with more than 10 assets, **When** a user opens it, **Then** exactly 10 assets are shown per page, and the existing Previous/Next buttons page through the full list correctly at the boundaries (first page, last page).
4. **Given** the Properties Panel's Labels tab, **When** a user creates a new label, **Then** they can set a name, choose a color visually, and see/edit its color code — matching the label-creation experience already available on the dedicated labels page — rather than only entering a name.
5. **Given** a user viewing the Properties Panel's Labels tab where the dataset's default labels already appear to be present, **When** they look at the "Add defaults" control, **Then** the panel explains why the action exists and what clicking it does, so the user is not left wondering why a seemingly redundant action is offered.

---

### User Story 9 - Local and Deployed Environments Start Reliably Together (Priority: P3)

As a developer or operator, I need the documented Docker Compose configuration to bring up PostgreSQL, Redis, MinIO, the web application, and the worker together successfully, so that setting up or redeploying the platform doesn't require undocumented manual steps.

**Why this priority**: This validates that the hardening work above is actually deployable end-to-end, but it's a verification and documentation activity rather than new runtime behavior, so it's the lowest priority.

**Independent Test**: Run the documented Docker Compose startup from a clean state and verify all five services report healthy/ready and the web application can reach the worker's effects (e.g., a submitted job completes) without manual intervention.

**Acceptance Scenarios**:

1. **Given** a clean environment with only the repository and its Docker Compose configuration, **When** the documented startup command is run, **Then** PostgreSQL, Redis, MinIO, the web application, and the worker all start successfully and reach a ready state.
2. **Given** the stack is running, **When** a job-creating request is submitted through the web application, **Then** the worker picks it up and it reaches a terminal state, confirming the services are actually connected, not just individually running.

---

### Edge Cases

- A queue message for a job is delivered more than once while a worker still holds a valid lease on it — the second delivery must not process the job again.
- A worker crashes, then comes back and tries to act on a job using a lease/lock token that has already been superseded by recovery — that stale action must be refused.
- An asset is deleted at the exact moment the orphan scanner is scanning its object — the object must not be deleted until it clears the grace period, so an in-flight deletion cannot race the scanner into a false negative or a double-delete error.
- A dataset is deleted while one of its assets still has an in-progress temporary upload — the temporary upload cleanup and the dataset cleanup must not conflict or double-act on the same object.
- Redis goes down mid-poll for an AI task that is mid-retry — the AI task's existing polling/backoff behavior must not be broken by the queue outage handling introduced here.
- A user's rate limit resets exactly as they submit a borderline request — the system must consistently apply the limit rather than exhibit a race at the boundary.
- An operator requests a job list page far beyond the last page, or with a negative/zero page size — the system must respond with an empty/bounded result rather than erroring or ignoring the cap.
- The JobEvent retention cleanup runs while a job it would otherwise clean up transitions from active to terminal mid-run — no active job's events are removed.
- The MinIO orphan scanner is run while MinIO itself is briefly unreachable — it must not treat an unreachable listing as proof of "no objects" or delete anything on that basis.

## Requirements *(mandatory)*

### Functional Requirements

#### Job Recovery, Stale Detection & Dead-Letter

- **FR-001**: The system MUST periodically scan for jobs in an active (non-terminal, in-progress) state whose existing lease/heartbeat/lock timestamp has exceeded a configurable recovery threshold, and make each one eligible for recovery.
- **FR-002**: The system MUST NOT recover a job whose lease/lock is still valid (not yet expired).
- **FR-003**: Recovery MUST be idempotent: running the recovery pass again before a job is claimed MUST NOT create a duplicate job or trigger a second recovery action on the same job.
- **FR-004**: Recovery MUST NOT allow the same job to be processed by two workers at the same time.
- **FR-005**: Recovery MUST increment the job's existing retry/attempt count and preserve its full event history rather than replacing it.
- **FR-006**: The system MUST detect jobs that remain in an active running state beyond a configurable maximum runtime and transition each one to a failed or retryable outcome consistent with the existing job lifecycle, recording the reason.
- **FR-007**: The stale-job detector MUST NOT delete a job record; it only changes lifecycle state and records the reason.
- **FR-008**: When a job's retry attempts reach its configured maximum, the system MUST stop retrying it and place it in a final, clearly observable failed ("dead-letter") outcome, while preserving the original job record, its failure reason, and its full event history.
- **FR-009**: The system MUST prevent infinite retries of any job.
- **FR-010**: Dead-lettered jobs MUST be observable (queryable/listable) rather than silently removed.
- **FR-011**: If a separate queue-level dead-letter mechanism is used, it MUST NOT create or duplicate a durable job record — the durable job store remains authoritative.

#### Import Commit Timeout

- **FR-012**: The system MUST enforce a deadline on any import that is waiting for a commit/finalization signal, so that it never waits indefinitely.
- **FR-013**: When an import's commit deadline passes without a commit signal, the system MUST mark the corresponding job failed, record the timeout reason, and create a corresponding event — without deleting any assets that were already validly committed before the deadline.
- **FR-014**: Import timeout handling MUST be idempotent: re-evaluating an already-timed-out import MUST NOT create a duplicate failure or alter already-committed assets.
- **FR-015**: If a worker restarts while an import is mid-commit, the import MUST either resume safely or be caught by the timeout detector — it must never be left permanently ambiguous (neither committed nor failed).

#### Queue and Cache Resilience

- **FR-016**: The system MUST NOT mark a job's durable record as successfully queued when its underlying queue enqueue operation failed.
- **FR-017**: The system MUST NOT swallow Redis/queue connection errors, enqueue failures, or reconnection events — each MUST be surfaced (recorded/logged) rather than silently ignored.
- **FR-018**: When Redis becomes available again after an outage, jobs whose durable record exists but were never successfully delivered to the queue MUST become eligible for delivery without manual re-submission and without creating duplicate job records.
- **FR-019**: The system MUST enable and configure the queue's own stalled-job detection so that a job whose worker stops responding is detected and made eligible for retry through that mechanism.
- **FR-020**: Queue-level state (e.g., BullMQ status) MUST NOT be blindly copied onto the durable job record; the durable record remains the authoritative source of the job's application-level state.
- **FR-021**: The system MUST prevent duplicate concurrent execution of the same durable job as far as the existing architecture allows, including when the queue redelivers a stalled or retried message.

#### Storage Garbage Collection

- **FR-022**: The system MUST provide a scanner that compares storage objects against valid database (asset) references and identifies objects with no valid reference.
- **FR-023**: The orphan scanner MUST support a dry-run mode that detects and reports orphaned objects without deleting them.
- **FR-024**: Outside dry-run mode, the orphan scanner MUST delete an object only if it is unreferenced AND has exceeded a configurable grace period since it was last known to be unreferenced or created.
- **FR-025**: The system MUST NOT delete a storage object based solely on filename or key pattern matching; deletion requires proof the object is unreferenced in the database.
- **FR-026**: When an asset is deleted, the system MUST schedule a cleanup job to delete its now-unreferenced storage object; the database deletion itself MUST NOT depend synchronously on the storage deletion succeeding.
- **FR-027**: If the deleted-asset cleanup job fails because storage is unavailable, the system MUST retry later, and the periodic orphan scanner MUST be capable of independently catching and cleaning up any object the cleanup job missed.
- **FR-028**: When a dataset is deleted, the system MUST identify its associated assets and their storage objects, and clean up objects no longer referenced anywhere in the data model, processing large datasets in batches rather than in a single unbounded operation.
- **FR-029**: Dataset deletion cleanup MUST NOT assume every object belonging to the dataset's assets is safe to delete without checking whether the data model still references it elsewhere.
- **FR-030**: The system MUST periodically clean up temporary upload objects that have no active upload session and have exceeded a configurable retention age, and MUST NOT delete an object belonging to an active upload session regardless of its age.
- **FR-031**: Every destructive garbage-collection operation (orphan deletion, asset cleanup, dataset cleanup, temporary-upload cleanup) MUST be idempotent: running it twice in immediate succession MUST produce the same end state as running it once.
- **FR-032**: When it is uncertain whether a storage object is still referenced, the system MUST treat it as referenced and MUST NOT delete it.
- **FR-033**: A transient storage-backend outage MUST NOT corrupt or lose durable database state; failed storage operations MUST fail visibly and be retryable.

#### JobEvent Retention

- **FR-034**: The system MUST provide a configurable retention period for job event history and MUST NOT delete events newer than that period.
- **FR-035**: JobEvent cleanup MUST process deletions in bounded batches rather than a single large delete operation, and MUST be safe to run repeatedly.
- **FR-036**: JobEvent cleanup MUST NOT remove events belonging to a job that is still in an active (non-terminal) state, even if those events are older than the retention period.

#### Rate Limiting

- **FR-037**: The system MUST rate-limit user-initiated requests to endpoints that create expensive background work (at minimum: AI task creation, import/upload initiation, and export initiation), on a per-user basis.
- **FR-038**: When a user exceeds their configured limit, the system MUST reject the excess request with a consistent HTTP status and error response, without creating a job.
- **FR-039**: Rate limiting MUST NOT apply to internal worker-to-system operations.
- **FR-040**: Rate limiting MUST NOT reject requests from a user who remains within their configured limit.

#### Pagination

- **FR-041**: Every endpoint that can return a potentially large collection (at minimum: jobs, JobEvents, annotations, labels, datasets, and AI task lists) MUST return a bounded page of results by default and MUST cap the maximum page size a caller can request.
- **FR-042**: Pagination changes MUST preserve the existing response shape/contract of each endpoint wherever possible, and MUST NOT change the existing, already-paginated workspace asset listing behavior.
- **FR-043**: The workspace Properties Panel's Assets tab MUST display exactly 10 assets per page and MUST let the user page through the full asset list using the existing Previous/Next controls, including correct behavior at the first and last page.
- **FR-044**: The workspace Properties Panel's Labels tab MUST let a user create a new label by specifying a name, choosing a color (visually), and viewing/editing its color code — consistent with the label-creation experience already available on the dedicated labels page — rather than name-only creation.
- **FR-045**: The workspace Properties Panel's Labels tab MUST explain, in the panel itself, what the "Add defaults" action does and why a user may still need it even when labels already appear present (e.g., because it establishes the dataset's own default label set rather than relying on labels that merely look similar).

#### Logging

- **FR-046**: The system MUST produce a structured log entry for each of the following job lifecycle transitions: created, queued, claimed, started, completed, failed, retried, recovered, dead-lettered, canceled.
- **FR-047**: The system MUST log Redis/queue connection failures, reconnections, and enqueue failures rather than silently discarding them.
- **FR-048**: The system MUST log storage upload failures, object deletion failures, and orphan detection events.
- **FR-049**: The system MUST log AI task lifecycle transitions including the AI task ID, job ID, model ID, provider identity, the transition, failure reason (when applicable), and duration.
- **FR-050**: Logs MUST NOT contain credentials, signed URLs, access tokens, provider secrets, or raw sensitive asset content, at any log level.

#### Observability

- **FR-051**: The system MUST expose enough information for an operator to determine, at minimum: worker health, Redis health, PostgreSQL health, current queue backlog, active job count, failed job count, stale job count, retry count, dead-letter count, and recent cleanup activity.
- **FR-052**: Observability surfaces MUST reuse existing health/readiness infrastructure where one already exists rather than duplicating it.

#### Scheduling & Cross-Worker Coordination

- **FR-053**: The system MUST run the recovery scanner, stale-job detector, import commit-timeout detector, JobEvent retention cleanup, MinIO orphan scanner, deleted-asset cleanup, deleted-dataset cleanup, and temporary-upload cleanup on a recurring schedule, within the existing worker process rather than as new standalone services.
- **FR-054**: When multiple worker instances are running simultaneously, at most one instance MUST execute a given destructive scheduled cleanup pass at a time, using the platform's existing database/queue coordination mechanism rather than a new, independent locking system.
- **FR-055**: The system MUST verify (and preserve) that no two worker instances process the same durable job concurrently, covering job claiming, lease ownership, lease renewal, recovery, and queue delivery.

#### Deployment

- **FR-056**: The documented Docker Compose configuration MUST start PostgreSQL, Redis, MinIO, the web application, and the worker together successfully from a clean environment.
- **FR-057**: The system MUST NOT require any undocumented manual step to bring the full stack from a clean environment to a working, connected state.

### Key Entities

- **Job**: The existing durable record of an asynchronous unit of work (import, export, AI task, media processing, etc.). This feature extends its use — lease/lock/heartbeat fields drive recovery and staleness detection, its retry/attempt fields drive dead-lettering — without redesigning its lifecycle states.
- **JobEvent**: The existing append-only history of what happened to a Job. This feature adds a bounded retention/cleanup process over it without changing what gets recorded during normal operation.
- **Prepared Import**: The existing record of an import waiting for a commit/finalization signal, including its commit deadline. This feature adds scheduling, testing, and hardening around its existing timeout handling.
- **Asset / Dataset**: The existing domain records that own storage objects. This feature reads their references to determine whether a storage object is safe to delete; it does not change what an Asset or Dataset represents.
- **Storage Object**: A binary object in the object store, referenced from an Asset (or a related storage-bearing record) by a storage key. This feature introduces the concept of an "orphaned" object (one with no valid database reference) and a grace period before it may be deleted.
- **Temporary Upload**: A storage object created during an in-progress upload before it is attached to a committed Asset. This feature introduces expiry for temporary uploads that were abandoned rather than completed.
- **Rate Limit Window**: A per-user, per-endpoint-category counter tracking how many expensive job-creating requests have been made in the current time window, used to accept or reject new requests.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A job whose worker crashes is automatically recovered or safely failed within its configured recovery threshold in 100% of tested crash scenarios, with zero manual database intervention.
- **SC-002**: No job remains in an active, non-terminal state indefinitely — every job reaches a terminal or explicitly retried state within its configured maximum runtime.
- **SC-003**: An import that never receives its commit signal is automatically marked failed within its configured deadline in 100% of tested cases, and every asset committed before the deadline remains fully intact and visible afterward.
- **SC-004**: A temporary Redis/queue outage during job creation never results in a user being told a job was queued when it was not, and every such job is either honestly reported as failed or automatically delivered once the outage ends.
- **SC-005**: Across repeated runs of the orphan scanner, zero actively-referenced storage objects are ever deleted, and every eligible orphaned object past its grace period is eventually removed.
- **SC-006**: Deleting an asset or a dataset results in its unreferenced storage objects being removed within the configured cleanup window in 100% of tested cases, including when the storage backend was briefly unavailable at the moment of deletion.
- **SC-007**: Abandoned temporary uploads older than the configured retention period no longer occupy storage after the next cleanup cycle, while every active upload's objects remain untouched.
- **SC-008**: An operator can determine current worker, Redis, and PostgreSQL health, plus backlog, failed, stale, retry, and dead-letter counts, from a single observability surface without querying the database directly.
- **SC-009**: A user attempting to create job-creating requests beyond their configured limit is consistently blocked with a clear error, while 100% of requests within the limit continue to succeed.
- **SC-010**: Every previously-unbounded list endpoint now returns a bounded page by default, and every existing caller of an already-paginated endpoint continues to work without modification.
- **SC-011**: A user browsing the Properties Panel's Assets tab for a dataset with more than 10 assets sees exactly 10 per page and can reach every asset using only the Previous/Next controls.
- **SC-012**: A user creating a label from the Properties Panel's Labels tab can set a name and choose a color (with a visible, editable color code) without leaving the panel.
- **SC-013**: A user reading the Properties Panel's Labels tab can explain, in their own words, why the "Add defaults" action exists even when labels already appear present.
- **SC-014**: The documented Docker Compose configuration brings up all five services (PostgreSQL, Redis, MinIO, web, worker) to a ready, connected state from a clean environment in a single documented command.

## Assumptions

- The existing Job lifecycle (queued/running/retrying/completed/failed/canceling/canceled), lease/lock/heartbeat fields, retry/attempt counters, and event history are reused as-is; "dead-letter" is treated as an existing terminal failed outcome plus observability, not a new lifecycle state, per the constraint against redesigning the state machine.
- The existing import commit-timeout mechanism (a deadline on the pending import) is hardened, scheduled, and tested rather than rebuilt, since equivalent detection already exists in the codebase.
- Exact numeric defaults (recovery threshold, maximum job runtime, JobEvent retention days, temporary-upload retention, orphan grace period, rate-limit thresholds) are configurable via environment variables with reasonable production-safe defaults chosen during planning; none of these numbers change the shape of the feature, so they are not treated as open questions here.
- Rate limiting is applied per authenticated user against the platform's existing session-based authentication, consistent with "prevent one user from creating unlimited background jobs."
- Visibility into platform-wide health/observability data and dead-lettered/stale job listings follows the same authorization boundaries as existing job and dataset access (i.e., scoped to what a user is already authorized to see, with any platform-wide view limited to existing elevated roles) — no new role or permission model is introduced.
- The current data model does not support multiple assets sharing one storage object; each object belongs to at most one Asset (or asset version) record, so "preserve objects still referenced elsewhere" is a defensive check rather than an expected common case today.
- MinIO lifecycle policy configuration is a secondary, documented safety net for temporary/staging objects only — it is not relied upon as the primary or only cleanup mechanism, and it is not applied to permanent asset objects.
- No existing API response contract, workspace behavior, annotation behavior, AI task behavior, or import/export behavior changes as a result of this feature, except where explicitly required to add pagination bounds, rate-limit rejections, or the two named Properties Panel UI additions.
