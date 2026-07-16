# Implementation Plan: PostgreSQL Claim Lock and Worker Safety

**Branch**: `008-postgresql-claimlock-worker-safety` | **Date**: 2026-07-15 | **Spec**: [spec.md](./spec.md)

## Summary

Add durable worker ownership primitives before any workflow processor is introduced. A private worker will claim a queued/retrying Job through one atomic guarded PostgreSQL mutation, then use the issued opaque token for heartbeat, progress, completion, failure, and cancellation acknowledgement. PostgreSQL remains authoritative; BullMQ carries only `{ jobId }`.

## Technical Context

**Language/Version**: TypeScript on Node.js 22

**Primary Dependencies**: Existing Prisma 6.19 client, BullMQ, ioredis, Zod, Node crypto; no additions

**Storage**: Existing PostgreSQL `Job` and `JobEvent` models; Redis/BullMQ transport only

**Testing**: Node built-in test runner with `tsx`; real Compose PostgreSQL and Redis integration tests using Prisma assertions

**Target Platform**: Private Linux container worker and Next.js server runtime

**Project Type**: pnpm monorepo with public Next.js application and private worker process

**Performance Goals**: Every test claim race yields exactly one owner; normal claim/heartbeat/lifecycle operations complete as one guarded durable mutation without a read-then-write race

**Constraints**:

- Claim MUST use one atomic PostgreSQL guarded `UPDATE … RETURNING` operation or Prisma's equivalent single-statement `updateManyAndReturn`; no read-then-write claim and no raw SQL without separate approval.
- Claim predicate: Job id, `QUEUED`/`RETRYING` status, and absent/expired lease only. Successful claim sets `RUNNING`, worker id, fresh token, timestamps, and a five-minute lease.
- Every lifecycle mutation requires `jobId` plus current unexpired `lockToken`; no token goes to a browser, queue payload, log, public error, or Job event.
- `cancelJob` only acknowledges a pre-existing authorized cancellation request (`CANCELING` or non-null `cancelRequestedAt`); it must not originate cancellation.
- Expired `RUNNING` Jobs are deliberately not claimable in this phase.
- Queue payload remains exactly `{ jobId }`; PostgreSQL is the only lock and Job-state authority.
- No schema/migration/generated-client edits, dependency additions, scheduler, public worker API, business processor, artifact, or automatic retry/requeue.

**Scale/Scope**: One existing Job model, one private worker listener integration, six private lifecycle primitives, and concurrency/stale-token coverage

## Constitution Check

The checked-in Spec Kit constitution is an uncustomized placeholder. The repository governance in `AGENTS.md` is the effective gate.

| Gate | Result | Plan response |
| --- | --- | --- |
| PostgreSQL is canonical | Pass | Claims, leases, progress, and terminal state are guarded Job mutations. |
| Redis/BullMQ is transport only | Pass | Payload remains `{ jobId }`; no token or state is queued. |
| Prisma only; no raw SQL | Pass | Use existing Prisma `Job.updateManyAndReturn`, verified in the generated client, for a single guarded mutation. |
| No schema/migration/dependency change | Pass | Existing lock and lifecycle fields are sufficient. |
| Private worker boundary | Pass | No Route Handler, public port, or browser contract is added. |
| No premature business workflow | Pass | A successful claim records ownership only; it does not clone, import, export, or create artifacts. |

**Post-design re-check**: Pass. The design artifacts retain all gates above and introduce no exception.

## Project Structure

### Documentation

```text
specs/008-postgresql-claimlock-worker-safety/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── claim-lock-contract.md
│   └── worker-lifecycle-contract.md
└── checklists/
    └── requirements.md
```

### Source Code

```text
apps/
├── worker/
│   ├── src/
│   │   ├── jobs/
│   │   │   └── job-claim-lock.ts          # private claim/lease/lifecycle primitives
│   │   └── queue/
│   │       ├── queue-router.ts            # call claim after strict receipt validation
│   │       └── bullmq-worker.ts            # supply a process-private worker identity
│   └── tests/queue/
│       ├── claim-lock.test.ts
│       ├── lifecycle-mutations.test.ts
│       └── worker-claim-integration.test.ts
└── web/
    └── src/lib/jobs/authorization.ts       # existing authorized cancellation request boundary; no worker token use
```

**Structure Decision**: Keep all claim and token handling in the private worker. The public web boundary retains only authorized cancellation request behavior and never receives a token.

## Implementation Approach

1. Define server-only Zod/internal input shapes and safe return results for claim and lifecycle operations. Generate a fresh opaque token with Node crypto only after preparing a claim attempt; return it only on successful private claim.
2. Implement `claimJob` through one Prisma `Job.updateManyAndReturn` call. Its guarded `where` includes the Job id, eligible status, and null/expired lease. Its data update sets the complete ownership/lease transition in that same statement; an empty returned list means no claim.
3. Implement heartbeat, progress, complete, fail, and cancellation acknowledgement as independent guarded `updateMany`/`updateManyAndReturn` mutations. Every `where` includes id, `lockToken`, unexpired lease, and the operation's allowed lifecycle state.
4. Clear `lockedBy`, `lockToken`, `lockedAt`, `lockedUntil`, and heartbeat ownership fields only when a valid current owner records a terminal transition. Keep existing cancellation request fields as evidence; `cancelJob` also requires `CANCELING` or a non-null request time.
5. Integrate queue routing so strict `{ jobId }` receipt is followed by an ownership claim before any future handler could run. In this phase, a successful claim stops after safe observation; no business handler is dispatched.
6. Add real Compose PostgreSQL/Redis tests for two-worker concurrent claims, valid heartbeat/progress, stale token refusal, terminal mutations, cancellation acknowledgement, expired-running non-claimability, payload redaction, and no-side-effect denials.

## Complexity Tracking

No governance violation or additional project is required.
