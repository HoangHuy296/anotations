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
pnpm --filter @fieldframe/worker typecheck
pnpm --filter @fieldframe/worker test:queue
docker compose -f docker-compose.yaml run --rm --no-deps worker ...
```

Run the database/Redis integration suite through the established short-lived Compose-network test container pattern. Do not copy `.env` into an image and do not run schema migration commands for this phase.
# Verification record — 2026-07-16

The existing migrations were deployed to the local Compose PostgreSQL database;
no migration file or Prisma schema was changed. The worker queue suite passed
against the Compose PostgreSQL and Redis services (10/10 tests), including
concurrent claims, expired/stale-token refusals, terminal transitions,
cancellation acknowledgement, duplicate delivery, and no token leakage in
JobEvents.

Validated commands:

```sh
pnpm --filter @fieldframe/worker build
pnpm --filter @fieldframe/worker typecheck
pnpm --filter @fieldframe/web typecheck
pnpm --filter @fieldframe/web lint
docker run --rm --network anotations_default --env-file .env \
  -v "$PWD/.env:/workspace/.env:ro" \
  -v "$PWD/apps/worker/src:/workspace/apps/worker/src:ro" \
  -v "$PWD/apps/worker/tests:/workspace/apps/worker/tests:ro" \
  -v "$PWD/packages/queue:/workspace/packages/queue:ro" \
  -v "$PWD/packages/domain:/workspace/packages/domain:ro" \
  -v "$PWD/lib/generated:/workspace/lib/generated:ro" \
  anotations-worker pnpm --filter @fieldframe/worker test:queue
```

The test uses two distinct private worker identities against the same durable
Job and confirms exactly one PostgreSQL claim. It does not dispatch business
work. On 2026-07-16 the private `worker` service was rebuilt and recreated
alone, then a second temporary worker using the same image completed the live
BullMQ smoke test. The temporary worker was removed after the test.
