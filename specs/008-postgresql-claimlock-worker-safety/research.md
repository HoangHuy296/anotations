# Research: PostgreSQL Claim Lock and Worker Safety

## Decision: Use Prisma `Job.updateManyAndReturn` for the claim compare-and-set

**Rationale**: The generated Prisma client in this repository exposes `Job.updateManyAndReturn`. On PostgreSQL it provides the required guarded update-and-return behavior in one database statement, so a claim can atomically test eligibility and persist ownership without a read-then-write race. This respects the repository rule against raw SQL.

**Alternatives considered**:

- Read Job then update it: rejected because concurrent workers can both observe eligibility.
- Transaction containing a read followed by update: rejected because it is more complex and does not by itself guarantee the requested one guarded update pattern.
- Raw `UPDATE … RETURNING`: functionally valid but rejected for this plan because governance disallows raw SQL without separate approval; Prisma provides an equivalent.

## Decision: Treat the lock token as a short-lived server-only capability

**Rationale**: A random opaque token binds every worker mutation to the successful claim. The token is never a queue field or browser value, so a duplicate delivery cannot infer it from Redis.

**Alternatives considered**:

- Worker id only: rejected because a reused or guessed worker id cannot distinguish a stale process from the current owner.
- Redis lock: rejected because PostgreSQL must remain the canonical Job and lock authority.

## Decision: Five-minute renewable lease with stale-write refusal

**Rationale**: Each successful claim and heartbeat establishes a five-minute lease. All mutations require an unexpired matching token, preventing a paused worker from overwriting the durable Job after expiry.

**Alternatives considered**:

- Infinite lock: rejected because crashed workers would block work indefinitely.
- Automatically reclaim expired `RUNNING` Jobs: rejected because the feature explicitly excludes retry/requeue policy and business idempotency handling.

## Decision: Restrict cancellation acknowledgement to an already-requested cancellation

**Rationale**: Authorized application code initiates cancellation. The worker may only acknowledge it after proving current ownership, preventing worker delivery data from becoming a cancellation authority.

**Alternatives considered**:

- Permit any current worker to cancel: rejected because it bypasses the authorized application boundary.
- Permit a stale token to acknowledge cancellation: rejected because it can overwrite the current owner.

## Decision: Preserve Phase 007 queue and worker boundaries

**Rationale**: BullMQ continues to deliver only `{ jobId }`; routing resolves durable state and claims it privately. The worker gains no browser route, scheduler, business processor, or artifact behavior.

**Alternatives considered**:

- Include worker id/token in the queue payload: rejected because payload privacy and transport-only rules forbid it.
- Start processing immediately after receipt: rejected because this phase establishes safety primitives only.
