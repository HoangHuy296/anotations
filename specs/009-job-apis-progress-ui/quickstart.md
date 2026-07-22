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

### Safe local Redis test configuration

Full queue integration is opt-in. Redis must be started by Compose, bound to
`127.0.0.1`, password protected, and configured from an untracked local
environment file. The test process must provide `QUEUE_INTEGRATION_TESTS=1`,
`REDIS_HOST=127.0.0.1`, `REDIS_PORT`, `REDIS_PASSWORD`, a non-zero
`REDIS_TEST_DB`, and `REDIS_TEST_PREFIX`. It must set `REDIS_DB` equal to the
test DB and `BULLMQ_PREFIX` equal to the test prefix. Otherwise queue tests
skip with an explicit configuration message; there is no unauthenticated
localhost fallback.

## Expected outcomes

- All browser-visible Job responses use the safe contracts in [job-api.md](./contracts/job-api.md).
- Cancellation and retry are Dataset-authorized and create no side effects when denied.
- A retry successor has durable lineage, fresh transport/lock fields, and strict queue payload.
- The progress view reflects durable updates within ten seconds and never reads transport state.
- No import commit endpoint, PreparedImport record, or IMPORT_DATASET processor is created.

## Validation record — 2026-07-17

- `pnpm exec prisma validate` and `pnpm exec prisma generate`: passed before applying the additive retry-lineage migration.
- `20260717000000_add_job_retry_lineage` was applied successfully to the local Compose PostgreSQL instance at its published host port. The local `.env` was not modified.
- `pnpm --filter @fieldframe/web typecheck` and `pnpm --filter @fieldframe/worker typecheck`: passed.
- `pnpm --filter @fieldframe/web build`: passed when run with normal host process permissions. The workspace sandbox alone blocks Turbopack from binding a helper port.
- The pure Job progress/safe-summary tests pass. Full queue integration is only enabled through the explicit safe-local Redis variables described above; ordinary runs skip it instead of falling back to an unauthenticated local Redis.
- Redis was recreated as a password-required listener at `127.0.0.1:6379`.
  Full queue integration passed: web Job suite **24/24** and worker queue suite
  **15/15**, each using a dedicated non-zero Redis DB and test prefix supplied
  only to the test process.
