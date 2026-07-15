# Research: BullMQ Queue and PostgreSQL Job Source of Truth

## Decision 1: Reuse the existing durable Job schema and queue package

**Decision**: Reuse the existing `Job`, `JobEvent`, queue payload schema, Redis configuration, and BullMQ dependencies. Do not add a schema field, migration, table, queue technology, or dependency.

**Rationale**: The Job model already has the four transport fields (`queueName`, `queueJobId`, `enqueuedAt`, `dequeuedAt`), canonical lifecycle/input fields, idempotency constraint, and relevant indexes. The queue package already validates a strict `{ jobId }` payload; worker readiness already proves the Redis connection.

**Alternatives considered**:

- Create separate import/export/sync job tables: rejected by the Architecture Lock.
- Store lifecycle state in Redis: rejected because PostgreSQL is authoritative.
- Add a new queue library: rejected because approved BullMQ infrastructure already exists.

## Decision 2: Durable creation precedes at-least-once transport

**Decision**: The enqueue service creates one authorized `QUEUED` Job with all transport fields null, then sends exactly `{ jobId }` to the mapped BullMQ queue. Only after the queue accepts delivery does a conditional update stamp `queueName`, `queueJobId`, and `enqueuedAt` on the same Job.

**Rationale**: A transaction cannot atomically cover PostgreSQL and Redis. Treating the Job record as canonical means a queue outage leaves a visible, recoverable Job rather than losing intent or fabricating a completed delivery.

**Alternatives considered**:

- Roll back/delete Job if enqueue fails: rejected because it loses durable user intent and prevents recovery.
- Set `enqueuedAt` before delivery: rejected because it falsely represents queue transport success.
- Put the complete Job in BullMQ: rejected because it duplicates canonical state and risks secret disclosure.

## Decision 3: Use the durable Job id as the BullMQ delivery id

**Decision**: Set BullMQ's delivery id to the durable `Job.id`; the payload remains exactly `{ jobId }`. The database transport stamp is conditional on `id`, `status=QUEUED`, `cancelRequestedAt=null`, and `enqueuedAt=null`. A pre-existing equivalent stamp is reconciled as success; conflicting transport metadata is not overwritten.

**Rationale**: A deterministic delivery id makes a crash after queue acceptance but before database stamping recoverable without a second durable Job or another future work unit.

**Alternatives considered**:

- Generate a new queue id for each scan: rejected because it permits duplicate deliveries.
- Treat every post-enqueue database failure as terminal: rejected because recovery must reconcile a known durable Job.
- Use Redis state to determine whether the Job is durable: rejected because transport is not authority.

## Decision 4: Recovery is a bounded explicit scanner

**Decision**: The initial recovery scanner is an explicitly invoked, bounded pass over Jobs where `status=QUEUED` and `enqueuedAt=null`. It re-reads each candidate, confirms it is still active/recoverable, then uses the same enqueue-and-stamp service. It does not run a timer, create Jobs, or perform business workflow processing.

**Rationale**: This delivers the required recovery behavior without prematurely adding scheduler policy, a public worker endpoint, or job-specific processing.

**Alternatives considered**:

- Background polling loop at worker startup: deferred because scheduling/operational policy is not part of this foundation.
- Recover every non-terminal Job: rejected; Phase 007 only recovers `QUEUED` Jobs with no successful enqueue stamp.
- Infer that `FAILED` is retryable: rejected because retry lifecycle policy is a later concern.

## Decision 5: The worker is a receipt/router, not a workflow executor

**Decision**: Add a private BullMQ Worker factory/router that strict-parses `{ jobId }`, loads the Job from PostgreSQL, skips malformed, unknown, inactive-Dataset, cancelled, terminal, and unsupported Jobs, and records receipt/dequeue observations. It does not move the Job to `RUNNING` or execute clone/import/export/AI work.

**Rationale**: This proves the cross-service contract while preserving phase discipline. A queue delivery alone never grants enough information to perform business work.

**Alternatives considered**:

- Start repository cloning or export handling now: rejected as later phases.
- Let the worker trust payload state/input: rejected because payload is deliberately minimal.
- Expose a worker HTTP endpoint: rejected by the private-worker boundary.

## Decision 6: Job events have an allowlisted safe vocabulary

**Decision**: The JobEvent writer accepts a narrow typed set of event kinds such as `QUEUE_ENQUEUED`, `QUEUE_DELIVERY_PENDING`, `QUEUE_RECEIVED`, and `QUEUE_SKIPPED`. Its data is limited to safe scalars such as queue name, delivery id, and an allowlisted reason.

**Rationale**: Raw queue objects, thrown errors, or Job JSON can contain credentials, private URLs, or excessive data. Small allowlisted events make audit and tests deterministic.

**Alternatives considered**:

- Persist raw errors or full BullMQ payloads: rejected because they can leak sensitive data and duplicate Job input.
- Omit events entirely: rejected because recovery and delivery observations need durable, safe diagnostics.

## Decision 7: Job status stays PostgreSQL-backed and Dataset-scoped

**Decision**: Add only the minimal authorized Job status projection required by the specification. It resolves the session actor first and reads a safe projection from PostgreSQL; it does not disclose queue identifiers, raw events, input/state/summary, provider/source fields, or BullMQ inspection data.

**Rationale**: Browser status must remain stable through queue redelivery and must preserve the existing 401/403/404 Dataset isolation policy.

**Alternatives considered**:

- Poll BullMQ directly from the browser: rejected by the private-provider boundary and non-authoritative-state rule.
- Add real-time notifications now: deferred beyond the queue foundation.

