# Research: Job APIs and Progress UI

## Decision: Preserve the existing safe Job status projection

**Rationale**: The existing status endpoint already selects a narrow durable Job view and returns a nullable safe summary. Reusing that contract prevents raw Job input, state, result, errors, queue state, locks, source connections, and storage references from reaching the browser.

**Alternatives considered**:

- Return the Job record and hide fields in the UI: rejected because a browser response is already a disclosure.
- Read status from queue transport: rejected because queue state is not canonical and can diverge from durable Job lifecycle state.

## Decision: Add a dedicated safe event projection

**Rationale**: JobEvent `data` can contain internal transport diagnostics. The events endpoint must expose only an allowlisted DTO: event id, timestamp, level, safe stage, safe message/kind, and an optional allowlisted reason. It never forwards raw `data`.

**Alternatives considered**:

- Reuse raw JobEvent rows: rejected because it leaks queue and future internal context.
- Omit events entirely: rejected because users need activity context for long-running work.

## Decision: Cancel unclaimed work directly and request cancellation for active work

**Rationale**: A queued or unclaimed retrying Job has no active worker that can acknowledge cancellation. It must transition atomically to CANCELED at the authorized application boundary. A RUNNING Job becomes CANCELING with cancellation evidence; only the worker holding the Phase 008 lock can later acknowledge CANCELED.

**Alternatives considered**:

- Put every eligible Job into CANCELING: rejected because a queue message may never be claimed and cancellation can remain pending indefinitely.
- Let the browser set CANCELED for a running Job: rejected because it bypasses private worker ownership and safe stopping.

## Decision: Retry creates one successor Job with explicit lineage

**Rationale**: The failed original remains immutable history. A nullable `retryOfJobId` relation with a unique constraint makes one successor per original durable and race-safe. The successor uses only type-specific allowlisted server-held retry context, has fresh lease and transport fields, and uses the established create-then-enqueue flow.

**Alternatives considered**:

- Reset the original Job to QUEUED: rejected because it loses terminal history and risks stale lifecycle writes.
- Use only a derived idempotency key: rejected because it does not provide an explicit, queryable retry lineage or a single-successor constraint.

## Decision: Restrict retries to delivery-supported job types

**Rationale**: The current worker intentionally supports only approved Job types. Retrying an unsupported type would either fail delivery or lead to a claimed Job with no business processor. The retry endpoint returns a safe conflict until that job type has an approved delivery and processing phase.

**Alternatives considered**:

- Add IMPORT_DATASET support now: rejected because import processing is explicitly deferred.
- Enqueue unsupported Jobs and rely on future code: rejected because it violates the current worker lifecycle boundary.

## Decision: Defer commit import completely

**Rationale**: There is no durable PreparedImport, staging ownership, or approved IMPORT_DATASET processor. A commit endpoint would otherwise require unsafe browser filesystem access or produce undeliverable work.

**Alternatives considered**:

- Create a placeholder endpoint: rejected because it creates an incomplete public contract without durable semantics.
- Add PreparedImport and import processor here: rejected by the approved Phase 009 scope; it belongs to the next end-to-end import phase.

## Decision: Poll durable endpoints only while useful

**Rationale**: A 5-second visible-page polling interval meets the 10-second visibility objective without adding realtime transport. Polling stops for terminal Jobs and when the page is not visible.

**Alternatives considered**:

- Poll Redis/BullMQ: rejected because it is transport-only.
- Add realtime subscriptions: deferred; it exceeds the phase scope.
