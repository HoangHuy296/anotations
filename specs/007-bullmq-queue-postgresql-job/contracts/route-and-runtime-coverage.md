# Phase 007 Route and Runtime Coverage

## Existing boundary inventory

| Boundary | Existing state | Phase 007 responsibility |
| --- | --- | --- |
| `apps/web/src/lib/jobs/authorization.ts` | Dataset-scoped durable Job guard; no enqueue transport | Reuse authorization, add safe lookup support only. |
| `packages/queue/src/job-contract.ts` | Strict payload schema and one queue name | Keep `{ jobId }` as the only transport payload and add safe shared mapping helpers. |
| `apps/worker/src/providers/queue.ts` | Redis connection and BullMQ Queue readiness client | Reuse configuration for private Worker receipt and bounded recovery. |
| `apps/worker/src/readiness.ts` | PostgreSQL, MinIO, Redis, and bucket readiness | Retain provider readiness; lifecycle integration must not create an HTTP listener. |
| `GET /api/jobs/[jobId]` | Not present | Add authenticated, Dataset-scoped PostgreSQL-only safe status projection. |

## Required protection coverage

- All browser status reads resolve the active opaque-cookie actor first.
- Missing/non-member/cross-Dataset Job reads are hidden with `404`; visible unauthorized members receive `403`; unauthenticated requests receive `401`.
- Queue payloads, JobEvents, status projections, errors, and logs exclude full Job JSON, raw summaries, queue internals, credentials, encrypted values, private URLs/storage keys, and binary content.
- The private worker has no Route Handler, HTTP server, or public port.

## Phase exclusions

- No Job-specific processor, clone/import/export/sync/AI/annotation handling, MinIO output, timer scheduler, schema migration, new dependency, or public fake-Job route.

## Final audit (2026-07-15)

- `packages/queue/src/job-contract.ts` defines the single strict payload schema;
  web enqueue and worker router both parse/use it as `{ jobId }` only.
- The Job status route selects only the SafeJobStatus fields and serializes a
  null foundation summary. It does not select raw Job JSON, errors, queue
  fields, JobEvents, provider data, or storage references.
- Web and worker event writers accept only queue names, deterministic Job ids,
  and allowlisted reason codes. They do not accept exception objects or raw Job
  data.
- Compose confirms the worker has no published port. Source audit found no
  `setInterval`, HTTP server/listener, or schema/generated-client change in the
  Phase 007 implementation paths.
