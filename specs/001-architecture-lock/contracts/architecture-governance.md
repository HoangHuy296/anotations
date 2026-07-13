# Architecture Governance Contract

This internal contract is the acceptance boundary for Phase 0 documentation.
It is not an HTTP API, queue schema implementation, or database schema.

## Required responsibility map

| Boundary | Must own | Must not own |
| --- | --- | --- |
| Next.js backend API | authentication, validation, metadata writes, Job creation, enqueue request | repository clone, long-running processing, provider/storage credentials in responses |
| PostgreSQL | canonical Job state, Job input/result metadata, domain metadata, annotation version | binary asset or export content |
| BullMQ / Redis | transport and delivery of `{ jobId }` | canonical Job state, full Job input, binary content |
| MinIO | private binary objects and artifact bytes | public credentials, domain state authority |
| Private worker | cloning, long-running processing, durable Job updates, idempotent output handling | public request serving, separate authoritative state |

## Queue payload contract

Every submitted message has exactly this logical content:

```text
{ jobId }
```

The message must not include user input, provider tokens, object-storage
credentials, a full Job snapshot, or binary data.

## Annotation update contract

1. The client submits an Annotation identity, its expected version, and a
   replacement canonical geometry where authorized.
2. The durable update succeeds only when expected version equals current
   version.
3. A successful update increments the version.
4. A stale update is rejected and must reload the canonical geometry/version;
   it must not overwrite newer data.

## Retry and idempotency contract

1. A retry references the existing durable Job.
2. The worker resolves the Job before work and checks its durable result and
   deterministic object identity before creating a binary object.
3. Completion records the object reference once in the durable Job result.
4. Repeated delivery after completion performs no duplicate binary creation.

## Documentation completion contract

Phase 0 is complete only after `AGENTS.md`, `docs/architecture.md`,
`docs/job-system.md`, `docs/bullmq-postgres-job-flow.md`,
`docs/clone-repository-plan.md`, and `docs/phases.md` exist and link to these
rules. Each later phase report must list files created, files modified,
commands to run, environment variables needed, database migration changes,
known limitations, and the next recommended phase.
