# BullMQ and PostgreSQL Job Flow

This flow implements the durable-state rules in [the Job system](./job-system.md)
and the boundary rules in [the architecture lock](./architecture.md).

## Contract

PostgreSQL owns Job state. BullMQ uses Redis only to deliver work to a private
worker. The logical queue payload is always:

```text
{ jobId }
```

It must contain no full Job input, result, token, credential, private URL, or
binary data.

## Submission and processing flow

```text
Authorized browser request
  → Next.js backend validates and authorizes input
  → PostgreSQL creates Job in `created`
  → PostgreSQL records Job as `queued`
  → BullMQ receives { jobId }
  → Private worker receives { jobId }
  → Worker loads Job from PostgreSQL
  → Worker atomically claims/records `running`
  → Worker performs private work and writes output to MinIO when needed
  → Worker records safe result metadata and terminal Job state in PostgreSQL
```

The backend returns a Job reference after durable submission. It does not wait
for cloning or other long-running processing.

## Retry and recovery flow

```text
Worker failure or retryable error
  → worker records sanitized failure/attempt data in PostgreSQL
  → authorized retry creates or reuses one successor Job with allowlisted context
  → BullMQ receives the successor { jobId }
  → worker reloads that successor Job and its idempotency context from PostgreSQL
  → worker reconciles any existing MinIO result before creating output
```

If a message is missing, malformed, cancelled, terminal, or refers to a Job
that cannot be found, the worker performs no business operation and records a
safe operational diagnostic where a durable Job exists. Queue cleanup or
redelivery never changes canonical Job state by itself.

## State and transport separation

| Concern | PostgreSQL Job | BullMQ / Redis |
| --- | --- | --- |
| Canonical state | Required | Prohibited |
| Full validated input | Required | Prohibited |
| Retry history | Required | Operational signal only |
| Delivery | Tracks intent and outcome | Required transport function |
| Binary content | Prohibited | Prohibited |
| Secrets | Prohibited | Prohibited |

## Operational limits

- Do not use queue progress as a browser-visible source of truth.
- Do not reconstruct a Job from a queue payload.
- Do not enqueue a Job before its durable record exists.
- Do not publish a queue payload that contains credential-bearing metadata.
