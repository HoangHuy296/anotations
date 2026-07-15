# Durable Job Queue Contract

## Boundary

The Next.js backend owns authorization, durable Job creation, enqueue requests, and authorized Job-status reads. The private worker owns queue receipt, durable Job lookup, and safe JobEvent observations. PostgreSQL is canonical; BullMQ/Redis is transport only.

## Queue payload

```json
{ "jobId": "cuid" }
```

The payload schema is strict. Any additional field, including `input`, `state`, `result`, Dataset id, owner id, token, credential, private URL, storage value, or binary content, is invalid.

## Submission contract

1. Authorize Dataset-scoped creation and validate safe Job input server-side.
2. Persist one Job as `QUEUED` with transport fields null.
3. Resolve a supported queue name from its durable Job type.
4. Send exactly the payload above, using the durable Job id as the deterministic queue delivery id.
5. On success, stamp `queueName`, `queueJobId`, and `enqueuedAt` on the existing Job and write a safe JobEvent.
6. On delivery failure, retain the Job as `QUEUED` with `enqueuedAt=null`; do not delete, replace, or mark it terminal.

## Worker receipt contract

1. Parse the strict payload.
2. Load the referenced Job from PostgreSQL.
3. Skip malformed, unknown, cancelled, terminal, inactive-Dataset, or unsupported Job records without business processing.
4. For an eligible Job, record `dequeuedAt` and append a safe JobEvent.
5. Do not execute clone/import/export/sync/AI/annotation work in this phase.

## Recovery contract

An explicitly invoked scanner selects eligible `QUEUED` Jobs where `enqueuedAt` is null. It retries delivery of the existing Job id only. It never creates another Job or copies input into Redis. Already stamped Jobs are skipped.

## Safe Job status projection

An authorized status read returns only safe durable fields needed for UI status, such as Job id, Dataset id, type, status, stage, progress counters, created/updated timestamps, and an optional safe summary. It does not expose Redis/BullMQ state, queue ids, full input/state, raw events/errors, source connections, repository fields, credentials, private storage references, or binary data.

## Failure responses

| Condition | Required behavior |
| --- | --- |
| Unauthenticated status/create request | `401`, no Job/event/queue side effect. |
| In-Dataset role lacks permission | `403`, no Job/event/queue side effect. |
| Non-member or another Dataset Job | `404`, no protected Job metadata or side effect. |
| Unsupported Job type | Safe validation failure; no queue message. |
| Queue delivery unavailable after Job persistence | Return durable Job reference with delivery pending; Job remains `QUEUED`, `enqueuedAt=null`. |
| Malformed/unknown worker delivery | No business work and no new Job. |
