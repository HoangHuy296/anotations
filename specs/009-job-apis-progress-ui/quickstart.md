# Phase 009 Validation Quickstart

## Prerequisites

- Phase 008 worker safety validation remains green.
- Compose PostgreSQL, Redis, and worker are healthy.
- `DATABASE_URL_DOCKER` is used by Compose services; host-only commands use the host database URL.
- Prisma client is generated after the retry-lineage migration.

## Validation sequence

1. Run the migration and generate the client. Verify a failed Job may have one retry successor and that the original Job is unchanged.
2. Run authorized status/event tests. Confirm Dataset members can read safe status/events; non-members receive 404; raw JobEvent data and prohibited Job fields are absent.
3. Run cancellation tests for queued, retrying, running, terminal, and unauthorized states. Confirm only an active worker may acknowledge a running cancellation.
4. Run concurrent retry tests. Confirm repeated requests create or return exactly one successor and enqueue only `{ jobId }`.
5. Run UI tests for status/stage/counters, empty and paginated events, safe error panel, action eligibility, and non-terminal polling.
6. Run the web build and worker regression tests.

## Commands

```bash
pnpm exec prisma migrate dev --name add_job_retry_lineage
pnpm exec prisma generate
pnpm --filter @fieldframe/web typecheck
pnpm --filter @fieldframe/web build
pnpm --filter @fieldframe/web test:job-queue
pnpm --filter @fieldframe/worker test:queue
```

Run database-mutating test suites in the Compose network when host DNS cannot resolve service names.

## Expected outcomes

- All browser-visible Job responses use the safe contracts in [job-api.md](./contracts/job-api.md).
- Cancellation and retry are Dataset-authorized and create no side effects when denied.
- A retry successor has durable lineage, fresh transport/lock fields, and strict queue payload.
- The progress view reflects durable updates within ten seconds and never reads transport state.
- No import commit endpoint, PreparedImport record, or IMPORT_DATASET processor is created.
