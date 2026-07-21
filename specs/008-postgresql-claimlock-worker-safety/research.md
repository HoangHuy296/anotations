# Research: PostgreSQL Claim Lock and Worker Safety

## Decision: Use the approved parameterized raw `UPDATE … RETURNING` for `claimJob` only

**Rationale**: Architecture governance approved a narrow raw-SQL exception only for `job.repository.ts#claimJob()`. A tagged Prisma `$queryRaw` executes one parameterized PostgreSQL `UPDATE … RETURNING`, allowing the database clock and `COALESCE` timestamp preservation to participate in the same compare-and-set mutation. Heartbeat, progress, completion, failure, and cancellation remain Prisma Client mutations.

**Alternatives considered**:

- Read Job then update it: rejected because concurrent workers can both observe eligibility.
- Transaction containing a read followed by update: rejected because it is more complex and does not by itself guarantee the requested one guarded update pattern.
- Prisma `updateManyAndReturn`: not selected for claim because the approved exact SQL shape requires database-clock timestamp preservation in the single statement.

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
