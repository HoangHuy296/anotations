# Queue Transport Contract

## Ownership boundary

| Boundary | Contract |
| --- | --- |
| Next.js backend | Authorizes, creates durable Job records, requests delivery, records transport metadata, and returns safe Job references. |
| PostgreSQL | Sole canonical source for Job input, lifecycle, attempts, events, transport metadata, and outcome. |
| BullMQ / Redis | Private at-least-once transport only. It carries a minimal Job reference. |
| Private worker | Receives the reference, reads the canonical Job, records safe receipt/skip observations, and performs no business workflow in Phase 007. |

## Payload

Every queue message must exactly match:

```json
{ "jobId": "cuid" }
```

The payload is strict: extra fields cause rejection. It must never carry Job input, status, dataset/actor identifiers, result, provider data, private URLs, credentials, encrypted values, or binary content.

## Create and enqueue protocol

1. The backend resolves the active actor and existing Dataset authorization.
2. It validates safe input and creates one `QUEUED` Job in PostgreSQL with null transport fields.
3. It resolves the allowlisted queue mapping and requests BullMQ delivery with payload `{ jobId }` and delivery id equal to the Job id.
4. On queue acceptance, it conditionally stamps `queueName`, `queueJobId`, and `enqueuedAt` on the same still-queued, not-cancelled Job, then writes a safe enqueue event.
5. It returns the durable Job reference and a safe indication of whether delivery was recorded or remains pending.

If step 3 fails, the Job remains `QUEUED`, `enqueuedAt` remains null, and a safe pending-delivery event is written when possible. No Job is deleted, failed, replaced, or recreated.

## Reconciliation and recovery

- A post-delivery/pre-stamp interruption is reconciled using the same deterministic delivery id and a conditional transport update.
- A recovery pass considers only Jobs with `status=QUEUED` and `enqueuedAt=null`.
- Each candidate is re-read and skipped if cancelled, no longer queued, archived/inactive, or unsupported.
- Repeated recovery passes must be harmless; they must not create a second Job or future-work invocation.

## Worker receipt protocol

1. Strict-parse the payload.
2. Load the Job by id from PostgreSQL.
3. Skip unknown, malformed, cancelled, non-queued, inactive-Dataset, or unsupported Jobs with a safe event where a Job exists.
4. For an eligible Job, conditionally record `dequeuedAt` and write a safe receipt event.
5. Stop. No status transition to running and no job-specific business handler is permitted in this phase.

## Event vocabulary

Allowed initial observations are fixed messages/reason codes such as:

- `QUEUE_ENQUEUED`
- `QUEUE_DELIVERY_PENDING`
- `QUEUE_RECEIVED`
- `QUEUE_SKIPPED`

Event data may contain only allowlisted scalar transport diagnostics: mapped queue name, deterministic delivery id, and safe reason code. Raw exceptions, queue objects, Job JSON, or secret-bearing context are prohibited.

