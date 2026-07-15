# Implementation Plan: BullMQ Queue and PostgreSQL Job Source of Truth

**Branch**: `007-bullmq-queue-postgresql-job` | **Date**: 2026-07-15 | **Spec**: [spec.md](./spec.md)

## Summary

Establish the durable Job submission and private queue-delivery foundation before any workflow-specific processing. The Next.js backend will create and authorize a canonical PostgreSQL Job, request BullMQ delivery with the strict `{ jobId }` payload, and stamp queue transport fields only after delivery succeeds or is reconciled. A private worker will receive the reference, reload the Job from PostgreSQL, and write safe receipt events without executing clone, import, export, or any other business workflow. An explicit recovery scanner will redeliver only queued Jobs whose enqueue timestamp is null.

## Technical Context

**Language/Version**: TypeScript 5, Node 22, Next.js App Router 16.  
**Primary Dependencies**: Existing Prisma client, BullMQ, ioredis, Zod, Node/tsx test runner, and server-only authorization modules; no new package.  
**Storage**: PostgreSQL/Prisma is Job and JobEvent authority; Redis/BullMQ is transient transport; MinIO is unchanged and not used for Phase 007 artifacts.  
**Testing**: Node/tsx integration tests with real Compose PostgreSQL and Redis, Prisma assertions, and no raw SQL.  
**Target Platform**: Existing Docker Compose web and private worker services.  
**Project Type**: pnpm monorepo with a public Next.js app and a private worker process.  
**Performance Goals**: Under healthy local services, a submitted test Job is transport-stamped and observable through the durable status read within 10 seconds; one bounded recovery pass completes without duplicate durable work.  
**Constraints**: Queue payload is exactly `{ jobId }`; no Redis Job authority; no full input in queue/events/browser; browser status follows the canonical nullable `SafeJobStatus` projection, whose `summary` is a sanitized allowlisted DTO and is `null` in this phase; no raw SQL; existing schema is source of truth; no migration/dependency; no public worker route; no business workflow processing; existing Dataset authorization/IDOR policy is mandatory.  
**Scale/Scope**: One existing supported Job type used as a foundation fixture, one existing queue, explicit bounded recovery invocation, no scheduler/realtime UI/job-specific processor.

## Constitution Check

The repository constitution is an unfilled template, so the active enforceable governance is [AGENTS.md](../../AGENTS.md) and the Phase 0 architecture documents.

| Gate | Pre-design result | Evidence |
| --- | --- | --- |
| Next.js owns browser API | PASS | Minimal authorized Job-status read remains a Next.js Route Handler; no separate public service. |
| PostgreSQL Job authority | PASS | Job is written before enqueue and remains the source for input, lifecycle, attempts, events, status, and transport metadata. |
| BullMQ/Redis transport only | PASS | Payload is strict `{ jobId }`; no browser status or canonical input/state comes from Redis. |
| Private worker boundary | PASS | Worker receives private queue messages only and has no HTTP endpoint. |
| Dataset authorization/IDOR | PASS | Creation/status paths reuse session actor and Dataset permission checks; hidden resources remain 404. |
| Idempotency/recovery | PASS | Durable Job id is delivery id; conditional stamps and candidate rechecks prevent replacement Jobs. |
| Secrets/binaries | PASS | Typed payload/event contracts reject secrets, input copies, private URLs, and binary data; status projection excludes raw Job data and can expose only a reviewed safe summary DTO. |
| Schema/dependency discipline | PASS | Existing Job/JobEvent fields and installed BullMQ/ioredis packages are reused. |
| Phase discipline | PASS | No clone/import/export/AI processing, object output, scheduler, or public worker endpoint is included. |

**Post-design re-check**: PASS. Research, data model, contracts, and quickstart preserve every gate above.

## Authorization and transport design

1. A server-only creation boundary resolves the session actor, validates safe input, checks Dataset permission, and creates exactly one canonical `QUEUED` Job with server-derived `createdById` and null transport fields.
2. The enqueue service maps an allowlisted existing Job type to the existing queue, calls BullMQ with strict `{ jobId }`, and uses `Job.id` as deterministic delivery id.
3. After queue acceptance, a conditional Prisma update stamps `queueName`, `queueJobId`, and `enqueuedAt` only while the same Job remains queued, not cancelled, and unstamped. It records an allowlisted safe event.
4. On queue failure, the service does not roll back/delete/fail the Job. It records safe pending-delivery diagnostics when possible and returns the durable reference as delivery-pending.
5. The recovery scanner explicitly selects only `QUEUED` Jobs where `enqueuedAt` is null, rechecks candidate eligibility, and delegates to the same enqueue/reconcile service. No timer or worker-start loop is introduced.
6. The worker strict-parses each message, loads the Job from PostgreSQL, skips unsafe/ineligible candidates, or conditionally records `dequeuedAt` and a safe receipt event. It does not execute business work or set `RUNNING`.
7. A minimal `GET /api/jobs/[jobId]` reads an authorized safe PostgreSQL projection only. It returns the canonical `SafeJobStatus` fields, maps persisted counters to safe response names, and sets `summary` to `null` in this phase. Future summaries require a dedicated sanitizer that constructs only the explicitly allowlisted `JobSafeSummary` DTO. It never exposes transport metadata or calls BullMQ for browser status.

### Safe status projection design

The status endpoint uses PostgreSQL only and returns this canonical response DTO:

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

- `successCount`, `failedCount`, and `skippedCount` are safe response names mapped from the existing persisted counters; they do not expose raw Job JSON.
- `summary` is never forwarded from the Prisma JSON column. A future mapper may emit only sanitized plain `message`, allowlisted `outcome`, ISO `completedAt`, and non-negative whole `resultCount` values.
- Foundation worker receipt does not execute business processing, so it always yields `summary: null`.
- The select/projection and serializer must exclude full `input`, `state`, persisted raw `summary`, result fields, raw JobEvents, raw errors/details, source connection/repository fields, queue identifiers/timestamps, lock fields, private storage keys/URLs, credentials, encrypted values, and binary data.

## Planned files and boundaries

```text
apps/web/src/
├── app/api/jobs/[jobId]/route.ts             # canonical SafeJobStatus PostgreSQL projection
├── lib/jobs/authorization.ts                  # refactor/compose existing durable Job guard
├── lib/queue/
│   ├── bullmq-client.ts                       # server-only Queue/Redis factory
│   ├── enqueue-job.ts                         # create/enqueue/reconcile service
│   └── queue-names.ts                         # allowlisted JobType → queue mapping
└── tests/job-queue/
    ├── helpers.ts
    ├── enqueue-and-recovery.test.ts
    ├── worker-receipt.test.ts
    └── authorization-and-redaction.test.ts   # includes nullable safe-summary allowlist

apps/worker/src/
├── index.ts                                   # start/stop receipt worker beside readiness
├── queue/
│   ├── bullmq-worker.ts                       # private Worker factory/lifecycle
│   ├── queue-router.ts                        # strict payload → durable Job receipt/router
│   ├── queue-names.ts                         # shared-compatible queue mapping export
│   └── recovery-scanner.ts                    # bounded explicit recoverable-Job scanner
└── jobs/
    └── job-event-writer.ts                    # narrow allowlisted JobEvent writer

packages/queue/src/job-contract.ts             # retain/extend strict shared transport typing only if necessary
apps/worker/tests/queue/                       # worker-private receipt/router coverage
specs/007-bullmq-queue-postgresql-job/         # plan artifacts and later task list
```

`prisma/schema.prisma`, `prisma/migrations/`, generated Prisma files, MinIO flows, and repository/business processors remain unchanged.

## Delivery sequence

1. Add queue-name mapping, strict shared transport validation, and narrow safe event vocabulary tests.
2. Build the server-only Redis/BullMQ queue factory and durable create/enqueue/reconcile service around the existing Job authorization boundary.
3. Add the safe PostgreSQL-backed Job-status Route Handler, explicit `JobSafeSummary` sanitizer (returning null for this phase), and authorization/no-side-effect/redaction tests.
4. Build the private Worker factory/router and event writer; integrate graceful lifecycle handling with existing readiness.
5. Add the explicit bounded recovery scanner using the same service and conditional reconciliation rules.
6. Run full Compose PostgreSQL/Redis integration tests for normal delivery, queue outage, post-delivery stamp interruption, repeat recovery, cancellation/terminal skips, cross-Dataset denials, payload/event redaction, and canonical nullable-summary status projection.
7. Run typecheck, lint, builds, and worker/web runtime readiness without activating job-specific processing.

## Project Structure

```text
apps/
├── web/                         # public authenticated API and durable enqueue request boundary
│   ├── src/app/api/jobs/
│   ├── src/lib/jobs/
│   ├── src/lib/queue/
│   └── tests/job-queue/
└── worker/                      # private queue receipt/recovery only
    ├── src/jobs/
    ├── src/queue/
    └── tests/queue/
packages/
└── queue/                       # strict common queue payload contract
prisma/                          # unchanged final schema/migrations
specs/007-bullmq-queue-postgresql-job/
```

**Structure Decision**: Keep public authorization and durable Job creation in the Next.js backend, queue receipt/recovery in the private worker, and the payload contract in the existing shared queue package. No new public backend, microservice, database table, or worker endpoint is introduced.

## Complexity Tracking

| Exception | Why needed | Simpler alternative rejected because |
| --- | --- | --- |
| At-least-once delivery reconciliation | PostgreSQL and Redis cannot share one atomic transaction; a persisted Job must survive a queue outage or post-delivery stamp interruption. | Rolling back the Job loses intent; trusting Redis makes transport authoritative. |
| Explicit recovery scanner | Required to redeliver durable queued Jobs with no enqueue timestamp. | A permanent timer/scheduler expands operational scope before its policy is approved. |
