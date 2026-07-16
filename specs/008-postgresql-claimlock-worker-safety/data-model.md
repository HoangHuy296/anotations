# Data Model: PostgreSQL Claim Lock and Worker Safety

The finalized `prisma/schema.prisma` remains the source of truth. This phase adds no field, model, migration, or generated-client change.

## Existing Job fields used

| Concern | Existing field(s) | Phase 008 rule |
| --- | --- | --- |
| Eligibility | `id`, `status`, `lockedUntil` | Only `QUEUED`/`RETRYING` Jobs with null or expired lease are claimable. Expired `RUNNING` Jobs are not claimable. |
| Owner proof | `lockedBy`, `lockToken` | Claim writes both; every worker mutation matches the current token. |
| Lease | `lockedAt`, `lockedUntil`, `heartbeatAt` | Claim/heartbeat establish a five-minute lease. |
| Start/receipt timing | `startedAt`, `dequeuedAt` | Claim preserves an existing time and sets it only when absent. |
| Progress | `progress`, `totalItems`, `processedItems`, `successItems`, `failedItems`, `skippedItems` | Valid current token required; invalid/stale updates write nothing. |
| Terminal outcome | `status`, `finishedAt`, `error`, `errorCode`, `canceledAt` | Valid current token required; terminal transition clears active lock fields. |
| Cancellation request | `status`, `cancelRequestedAt`, `canceledById` | Application owns request; worker may acknowledge only `CANCELING` or non-null request time. |

## Claim state transition

```text
QUEUED or RETRYING + no unexpired lease
  -- atomic guarded claim --> RUNNING + workerId + opaque token + five-minute lease

RUNNING + current unexpired token
  -- heartbeat --> RUNNING + renewed five-minute lease
  -- progress --> RUNNING + durable validated counters
  -- complete --> COMPLETED + finished time + cleared active lock
  -- fail --> FAILED + finished time + cleared active lock

CANCELING or cancellationRequestedAt present + current unexpired token
  -- worker acknowledgement --> CANCELED + canceled time + cleared active lock
```

## Invariants

1. A claim is one guarded update-and-return operation; at most one claimant receives a token.
2. `lockToken` is private capability data. It never appears in queue payloads, Job events, browser APIs, logs, or safe status responses.
3. Every lifecycle mutation checks `id`, current token, and unexpired lease in its database predicate.
4. A stale mutation changes zero rows and must not create an event, replacement Job, or business invocation.
5. `cancelJob` cannot originate cancellation and cannot transition a normal `RUNNING` Job directly to `CANCELED` without request evidence.
6. BullMQ payload remains exactly `{ jobId }`; it never stores lock state.
