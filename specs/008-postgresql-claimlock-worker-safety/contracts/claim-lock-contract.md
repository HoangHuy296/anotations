# Private Claim Lock Contract

This is an internal private-worker contract. It is not a browser API and does not authorize a new public route.

## Phase 008 scope boundary

- PostgreSQL is the sole authority for claim, lease, progress, and terminal state.
- BullMQ continues to carry exactly `{ jobId }`; it never carries a worker id, lock token, Job input, or lifecycle state.
- This phase adds no schema/migration/dependency, public endpoint, business processor, automatic recovery, or expired-`RUNNING` reclaim policy.

## `claimJob(jobId, workerId)`

| Input | Rule |
| --- | --- |
| `jobId` | Existing durable Job identifier. |
| `workerId` | Process-private operational identifier; never browser or queue data. |

Success returns the claimed Job safe-for-worker fields and a fresh opaque `lockToken`. No-claim returns a neutral result without token or protected Job details.

The claim is one atomic guarded PostgreSQL update-and-return operation (or Prisma's equivalent): it accepts only `QUEUED`/`RETRYING` with a null/expired lease, sets `RUNNING`, identity/token/timestamps, and a five-minute lease. It does not make expired `RUNNING` Jobs claimable.

## Token-guarded operations

Every operation below receives `jobId` and the current unexpired `lockToken`:

| Operation | Additional input | Success condition | Result |
| --- | --- | --- | --- |
| `heartbeatJob` | none | Current active claim | Renew five-minute lease. |
| `updateJobProgress` | validated safe counters | Current active non-terminal claim | Persist progress only. |
| `completeJob` | optional safe final values | Current active claim | Record `COMPLETED`, terminal time, clear active lock. |
| `failJob` | safe error code/message only | Current active claim | Record `FAILED`, terminal time, clear active lock. |
| `cancelJob` | none | Current active claim and `CANCELING` or cancellation request exists | Record `CANCELED`, cancellation time, clear active lock. |

For every stale, expired, wrong-job, wrong-token, malformed, terminal, or missing-cancellation-request call: return a neutral refusal, change zero Job fields, create no event, and do no business work.

## Security boundary

- Tokens and worker ids are never added to `{ jobId }` queue payloads.
- No operation exposes a token through a Route Handler, Server Action, API response, log, JobEvent, status DTO, or error.
- PostgreSQL is the source of truth; Redis/BullMQ has no lock or lifecycle authority.
