# Phase 007 Validation Quickstart

## Prerequisites

- Existing Compose PostgreSQL, Redis, web, and worker services are healthy.
- Existing Phase 004 authentication/ownership tests remain passing.
- Existing Job/JobEvent schema and generated client are present; no migration is expected.
- Tests run inside the Compose network so the service hostname in `DATABASE_URL` is resolvable.

## Phase boundary

This phase adds durable queue transport only. It does not change the Prisma schema or migrations, add a Job table or dependency, expose a public worker endpoint, run a scheduler loop, create MinIO artifacts, or execute repository, import, export, synchronization, AI, or annotation business processing.

## Validation scenarios

### 1. Normal durable submission and receipt

1. Create an authorized test Job through the server-only foundation boundary.
2. Confirm exactly one PostgreSQL Job exists with `QUEUED` status.
3. Confirm BullMQ receives exactly `{ jobId }` and no extra field.
4. Confirm the same Job records mapped queue name, queue delivery id, and enqueue time.
5. Confirm the private worker reads that Job, records receipt/dequeue information and a safe JobEvent, and performs no business work.

### 2. Queue outage and recovery

1. Force queue add to fail after the Job is durably created.
2. Confirm the Job remains `QUEUED`, has null `enqueuedAt`, and no replacement Job exists.
3. Restore queue connectivity and invoke one bounded recovery pass.
4. Confirm the original Job is delivered and transport-stamped once.
5. Invoke recovery again; confirm no duplicate Job, duplicate business invocation, or conflicting transport stamp.

### 3. Worker and authorization safety

1. Deliver malformed, unknown, cancelled, terminal, inactive-Dataset, and unsupported references; confirm no business work or new Job is created.
2. Request the Job status as owner/member, unallowed member, non-member, and actor from another Dataset.
3. Confirm expected `200`, `403`, or `404` behavior and no queue/Event/durable side effect after denial.
4. Inspect payloads, event records, API responses, and logs for absence of Job input, credentials, tokens, encrypted values, private URLs, and binary content.

## Expected commands after implementation

```bash
pnpm typecheck
pnpm --filter @annotationplatform/web lint
pnpm --filter @annotationplatform/web test:auth-ownership
pnpm --filter @annotationplatform/web test:job-queue
pnpm --filter @annotationplatform/worker test:queue
docker compose up --build
```

Run database/Redis integration tests through the established short-lived Compose-network test-container pattern.

## Expected results

- PostgreSQL remains the sole Job-state authority.
- Every BullMQ payload is exactly `{ jobId }`.
- A failed initial enqueue leaves one recoverable queued Job with `enqueuedAt=null`.
- Recovery and redelivery are idempotent.
- The worker resolves Jobs from PostgreSQL and has no public endpoint or business workflow implementation.
- Browser status is a safe PostgreSQL projection, never a Redis/BullMQ projection.

## User Story 1 validation evidence

Validated on 2026-07-15 against the local Compose PostgreSQL and Redis
services after applying the repository's already-committed migrations. The
Phase 007 web queue suite passed 7/7 tests.

- An authorized server-only submission creates one `QUEUED` PostgreSQL Job,
  adds exactly `{ jobId }` to BullMQ using that same durable id, then stamps
  `queueName`, `queueJobId`, and `enqueuedAt` on the same Job.
- Unsupported types, malformed input, unauthorized members, and cross-Dataset
  attempts are rejected before a Job or transport message is created.
- No public route creates a fake Job. Durable submission remains a server-only
  foundation service pending a workflow-specific API phase.
- `GET /api/jobs/[jobId]` authenticates first, authorizes Dataset membership,
  reads PostgreSQL, and returns only `SafeJobStatus`. The test verified
  `summary: null`, canonical counter mapping, and absence of raw Job input,
  state, summary, error, queue transport fields, and events.

The host command needs a database hostname reachable from the host. When
`DATABASE_URL` uses Compose DNS (`postgres`), run the suite through a
short-lived Compose-network web container instead; do not copy `.env` or
credentials into an image.

## User Story 2 recovery validation evidence

Validated on 2026-07-15 against local Compose PostgreSQL and Redis.

- `runPendingJobRecovery` is an exported private-worker module function, not a
  route, timer, scheduler, or browser-facing API. It performs one bounded pass
  (maximum 50 candidates) and requires the established existing-Job enqueue
  service to be injected by its private caller.
- A controlled queue failure leaves one existing Job `QUEUED` with
  `enqueuedAt=null`. A later explicit recovery pass delivers and stamps that
  same id; a repeated pass finds no newly eligible copy.
- Reconciliation safely stamps an already-existing deterministic BullMQ
  delivery after a pre-stamp interruption. Partial/conflicting transport
  metadata is skipped and never overwritten.
- Cancelled, archived/deleted-Dataset, and unsupported candidates are skipped
  with only allowlisted JobEvent reasons. The scanner never reads or queues
  Job input and never starts business work.

No scheduler loop or public invocation path was added. A future approved
operations/runtime phase must choose how an authenticated private process
invokes this bounded function.

## User Story 3 worker receipt validation evidence

Validated on 2026-07-15 against local Compose PostgreSQL and Redis; the
private worker queue suite passed 5/5 tests.

- `createFoundationWorker` listens only on the configured private BullMQ queue
  and uses the configured prefix. It exposes no HTTP listener and its close
  operation is safe when BullMQ has already closed its Redis connection.
- A real queued `{ jobId }` delivery makes the worker load the durable Job from
  PostgreSQL, conditionally set `dequeuedAt`, and append exactly one safe
  `QUEUE_RECEIVED` event. The Job remains `QUEUED`; no `RUNNING` transition or
  business processor is invoked.
- Malformed, unknown, cancelled, non-queued, archived-Dataset, and unsupported
  deliveries are skipped. Existing Jobs receive only an allowlisted
  `QUEUE_SKIPPED` reason; malformed/unknown payloads create no Job or event.
- Worker startup retains the existing PostgreSQL/MinIO/Redis readiness probes,
  starts the private listener only after they succeed, and closes Worker,
  queue/Redis, and Prisma resources on termination or startup failure.

## Final Phase 007 validation evidence

Completed on 2026-07-15. This is the final validation for this phase; no later
workflow phase was started.

- Full Compose-network suites passed: web Job-queue 10/10 and private-worker
  queue 5/5. They cover strict payloads, durable enqueue/stamp, safe status
  reads, no-side-effect denial, recovery/reconciliation, real listener receipt,
  skip rules, and close behavior.
- Root typecheck, web lint, worker lint, and domain/queue/web/worker builds
  passed. The short-lived internal Next.js health probe returned HTTP 200.
- A bounded worker readiness cycle passed against healthy Compose PostgreSQL,
  Redis, and MinIO. It ran `ensureBucket`, started the private listener, then
  handled SIGTERM cleanly. No public worker port was exposed.
- Static audit confirms every enqueue uses the strict `{ jobId }` schema, Job
  status selects only the safe projection, safe summary is always `null`, and
  JobEvents use only mapped queue metadata/reason values. No raw Job input,
  state, result, raw summary, error, BullMQ state, provider data, credential,
  private storage key, URL, or binary is returned by the status route or put in
  the queue/event writer.
- No edits were made to `prisma/schema.prisma`, `prisma/migrations/`, or the
  generated Prisma client. No MinIO workflow artifact, public worker route,
  scheduler/timer loop, or job-specific processor was added.

Phase 007 remains a queue foundation only. It deliberately does not expose a
browser Job-submission endpoint, run automatic recovery, or perform export,
import, cloning, AI, annotation, or storage-artifact work.
