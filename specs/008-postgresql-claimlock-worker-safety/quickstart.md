# Phase 008 Validation Quickstart

## Preconditions

- Phase 007 Compose PostgreSQL and Redis are healthy.
- Existing Job schema and generated client are present and unchanged.
- Tests run in the Compose network so PostgreSQL and Redis service hostnames resolve.
- No test logs or fixtures print lock tokens, connection strings, or provider credentials.

## Validation scenarios

1. Create one eligible durable Job. Launch two private claim attempts simultaneously. Verify exactly one receives a token and the Job is `RUNNING` with a five-minute lease.
2. With the valid token, heartbeat and update progress. Verify lease extension and durable counters. Retry both with stale/wrong/expired token and verify zero row changes.
3. Verify complete and fail use a current token and clear active lock fields. Verify a terminal Job cannot be claimed or mutated again.
4. Request cancellation through the existing authorized application boundary. Verify `cancelJob` succeeds only with the active token and request evidence; direct worker cancellation without that evidence is refused.
5. Deliver the same `{ jobId }` to two worker listeners. Verify one claim only and no business handler runs.
6. Expire a `RUNNING` lease in a fixture. Verify its old token is refused and that a new claim is also refused until a future approved recovery policy changes its status.
7. Inspect queue payloads, events, logs, and safe status output for absence of `lockToken`, worker identity, raw Job JSON, credentials, private URLs, storage keys, and binary data.

## Expected commands after implementation

```bash
pnpm --filter @annotationplatform/worker typecheck
pnpm --filter @annotationplatform/worker test:queue
docker compose -f docker-compose.yaml run --rm --no-deps worker ...
```

Run the database/Redis integration suite through the established short-lived Compose-network test container pattern. Do not copy `.env` into an image and do not run schema migration commands for this phase.
# Verification record — 2026-07-16

The existing migrations were deployed to the local Compose PostgreSQL database;
no migration file was created by Phase 008. The worker queue suite passed
against the Compose PostgreSQL and Redis services (15/15 tests), including
concurrent claims, expired/stale-token refusals, terminal transitions,
cancellation acknowledgement, duplicate delivery, and no token leakage in
JobEvents.

Validated commands:

```sh
pnpm --filter @annotationplatform/worker build
pnpm --filter @annotationplatform/worker typecheck
pnpm --filter @annotationplatform/web typecheck
pnpm --filter @annotationplatform/web lint
docker compose exec -T worker pnpm --filter @annotationplatform/worker test:queue
```

The test uses two distinct private worker identities against the same durable
Job and confirms exactly one PostgreSQL claim. It does not dispatch business
work. It also explicitly proves an expired `RUNNING` Job remains unclaimable
until a later approved recovery policy transitions its status.

## Commit boundary

Phase 008 creates no schema or migration change. Any unrelated working-tree
changes to `prisma/schema.prisma` (including Dataset metadata or Annotation
revision work) must be reviewed and committed separately from the Phase 008
claim-lock files.
