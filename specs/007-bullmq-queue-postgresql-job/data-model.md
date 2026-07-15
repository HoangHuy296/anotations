# Data Model: BullMQ Queue and PostgreSQL Job Source of Truth

This phase uses the finalized Prisma schema as the source of truth. It does **not** authorize a schema change or migration.

## Existing persisted entities

### Job

| Concern | Rule in this phase |
| --- | --- |
| Authority | PostgreSQL owns the complete Job lifecycle, input, state, results, attempts, cancellation, and transport metadata. |
| Creation | Authorized server code creates a `QUEUED` Job before delivery; `createdById` and `datasetId` are server-derived. |
| Queue mapping | `queueName` is null before successful transport and is stamped from the allowlisted Job-type mapping. |
| Delivery identity | `queueJobId` is the BullMQ delivery id, deterministically equal to the durable Job id. |
| Delivery timing | `enqueuedAt` is null until queue acceptance and successful/reconciled transport stamping. `dequeuedAt` records private worker receipt only. |
| Recovery candidate | `status=QUEUED` and `enqueuedAt=null`; candidates are revalidated before delivery. |
| Safety | `input` remains only in PostgreSQL and must be validated/safe. It is never copied to queue payloads, JobEvents, browser status, or logs. |

Relevant existing integrity mechanisms:

- Unique `(datasetId, idempotencyKey)` supports later workflow-level deduplication.
- Queue transport lookup index supports safe reconciliation by `(queueName, queueJobId)`.
- Status/run-after and status/priority indexes support bounded candidate selection without introducing a queue-state table.

### JobEvent

| Concern | Rule in this phase |
| --- | --- |
| Purpose | Append-only safe observation of enqueue, pending delivery, recovery, receipt, and skip outcomes. |
| Ownership | Always belongs to an existing Job. It never creates a Job or changes canonical Job lifecycle by itself. |
| Safe fields | Allowlisted level/stage/message plus small scalar data such as queue name, delivery id, and safe reason code. |
| Prohibited data | Full Job input/state/summary, raw error objects, credentials, tokens, encrypted values, private repository URLs, object keys, and binary data. |

## Ephemeral concepts

### Queue delivery

```json
{ "jobId": "cuid" }
```

- Exists only as transport.
- Does not contain Dataset id, actor id, Job type, input, state, output, or any secret.
- Uses the durable Job id as its delivery id for reconciliation.

### Queue mapping

An allowlisted association from supported existing Job types to the existing queue name. Initial tests use a supported existing type only as a fixture; no new synthetic JobType is created and no type gains business processing in this phase.

## State and transport transitions

```text
authorized server request
  → PostgreSQL Job: QUEUED; queueName/queueJobId/enqueuedAt/dequeuedAt = null
  → BullMQ add({ jobId }) using delivery id = Job.id
      → conditional PostgreSQL transport stamp + QUEUE_ENQUEUED event
      → success: Job remains QUEUED and is eligible for worker receipt
      → enqueue failure: QUEUE_DELIVERY_PENDING event; enqueuedAt remains null
  → explicit recovery scan selects QUEUED + enqueuedAt null
      → same enqueue-and-stamp path for the same Job
  → private worker receives { jobId }
      → PostgreSQL Job lookup
      → conditional dequeuedAt stamp + QUEUE_RECEIVED event, or QUEUE_SKIPPED event
```

## Invariants

1. Every canonical Job exists in PostgreSQL before any queue message referring to it.
2. Every queue payload contains exactly `{ jobId }`.
3. Redis/BullMQ state never becomes a browser-facing source of truth.
4. A recovery pass never creates a replacement Job and never mutates canonical `input`.
5. A worker receipt never starts business work in this phase.
6. Non-members cannot discover a Job or create queue/Event side effects for another Dataset.
7. JobEvent content is safe even when queue delivery or provider operations fail.

