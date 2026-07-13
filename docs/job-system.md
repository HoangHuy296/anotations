# Common Durable Job System

This document applies the [architecture lock](./architecture.md) and is read
with the [BullMQ/PostgreSQL flow](./bullmq-postgres-job-flow.md).

## Purpose

Every asynchronous operation uses one durable PostgreSQL Job model. The model
is the source of truth for imports, exports, repository synchronization, and
future long-running operations. Queue messages are delivery instructions only.

## Required Job information

| Information | Ownership and rule |
| --- | --- |
| `id` | Stable durable identity and the only queue payload value. |
| `kind` | Operation discriminator, such as import, export, or repository synchronization. |
| `state` | Authoritative lifecycle value in PostgreSQL. |
| `input` | Validated, durable request parameters; never duplicated as a full queue payload. |
| `result` | Safe outcome metadata and private object references; never binary data. |
| attempts and idempotency data | Coordinates retries and prevents duplicate outputs. |
| audit metadata | Requester, timestamps, and sanitized failure diagnostics; never secrets. |

Concrete fields, Prisma schema, indexes, and migrations are deferred to an
approved future phase.

## Lifecycle

```text
created → queued → running → completed
                   ↘ failed → queued (authorized retry)
created | queued | running → cancelled
```

- The backend creates the durable Job before sending a queue message.
- A worker may move a Job to `running` only after resolving it from PostgreSQL.
- A worker records progress, result references, and a terminal state in
  PostgreSQL.
- `completed`, `cancelled`, and a non-retryable `failed` state are terminal.
  Repeated delivery must not repeat their work or create duplicate binaries.
- A retry retains the same Job identity and its idempotency context. It may
  return a retryable `failed` Job to `queued` only through an authorized state
  transition.

## Idempotency and output safety

Before creating a binary output, the worker reads the Job result and checks a
deterministic object identity derived from the durable Job context. If a
completed result or valid existing object is present, the worker reuses or
reconciles it. A retry must never create a second asset or artifact solely
because a queue delivery happened again.

## Explicit exclusions

- Do not create separate `ImportJob`, `ExportJob`, or `RepositorySyncJob`
  tables.
- Do not use BullMQ/Redis retention, progress, or events as the Job record.
- Do not store binary payloads in Job input or result.
- Do not store provider, MinIO, Redis, or database credentials in a Job.
