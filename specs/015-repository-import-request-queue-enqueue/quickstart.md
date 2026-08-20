# Quickstart: Repository Import Request + Queue Enqueue

## Prerequisites

- The Phase-014 provider-preflight and Phase-013 SourceConnection security
  controls are available.
- Docker Compose PostgreSQL, passworded Redis, MinIO, web, and worker are
  running under controlled local configuration.
- Use a normal `/api/auth/login` opaque-cookie session. Do not use
  `DEV_AUTH_EMAIL`, JWT, browser token storage, or a provider credential in
  browser state.
- The approved local development migrations add the creation-idempotency
  boundary and preserve the user-approved `sourceBranch` → `sourceRef` rename.
  Do not apply either migration to another environment without its own change
  approval.

## Validation commands

Run commands only after the implementation tasks exist and configuration is
available. Never print `.env` values, provider credentials, storage
credentials, database URL, or Redis password.

```bash
pnpm exec prisma validate
pnpm exec prisma generate
pnpm --filter @annotationplatform/web typecheck
pnpm --filter @annotationplatform/web lint
pnpm --filter @annotationplatform/web test:repository-import-request
pnpm --filter @annotationplatform/worker test:queue
pnpm --filter @annotationplatform/web build
git diff --check
```

For controlled Compose HTTP evidence, use a separate passworded Redis DB and
prefix. The worker is deliberately stopped while acceptance tests inspect
`QUEUED` Jobs and exact deliveries, then restored afterward:

```bash
REPOSITORY_PREFLIGHT_INTEGRATION_TESTS=1 \
SOURCE_CONNECTION_TEST_MODE=1 \
QUEUE_INTEGRATION_TESTS=1 \
REPOSITORY_IMPORT_TEST_CONSUMERS_STOPPED=1 \
REPOSITORY_PREFLIGHT_HTTP_BASE_URL=http://127.0.0.1:3000 \
GITHUB_API_BASE_URL=http://127.0.0.1:18080 \
REDIS_HOST=127.0.0.1 REDIS_DB=15 REDIS_TEST_DB=15 \
BULLMQ_PREFIX=fieldframe-phase015-test \
REDIS_TEST_PREFIX=fieldframe-phase015-test \
pnpm --filter @annotationplatform/web test:repository-import-request
```

## Controlled runtime scenario

Use an isolated test Redis database/prefix and a dedicated MinIO test prefix.
The normal production/local queue namespace remains untouched.

1. Create or sign in as a permitted actor through normal HTTP auth.
2. Request a Phase-014 public repository preflight. Confirm it returns a safe
   preview and snapshot Dataset/Job/JobEvent IDs, Redis test keys, and MinIO
   test prefix before/after: all remain unchanged.
3. Submit one valid repository request to `POST
   /api/datasets/from-repository` with an idempotency key. Confirm exactly one
   Dataset and one `IMPORT_DATASET` `QUEUED` Job are created.
4. Inspect the isolated queue delivery through test helpers: payload is exactly
   `{ jobId }`; it contains no repository credential, URL with userinfo,
   storage data, or raw Job input.
5. Open returned `/datasets/{datasetId}/imports/{jobId}` as the actor. Confirm
   the safe PostgreSQL status projection renders; no queue state is read.
6. Repeat the identical request/key. Confirm the original Dataset/Job is
   returned and there is no second queue delivery.
7. Submit unsafe URL, invalid/expired/foreign SourceConnection, missing ref,
   and missing root cases. Compare snapshots before/after: no Dataset, Job,
   JobEvent, Redis delivery, or MinIO object changes. Audit responses for
   credentials/configuration/raw provider/stack leakage.
8. Simulate enqueue unavailability after a valid durable commit. Confirm the
   one Job remains `QUEUED` and eligible for existing recovery; do not delete
   or recreate the Dataset/Job.

## Runtime evidence — 2026-07-28

- **Authentication**: normal `/api/auth/signup` and `/api/auth/login`
  opaque-cookie sessions; no JWT, `DEV_AUTH_EMAIL`, or auth bypass.
- **Compose services**: PostgreSQL, passworded Redis, MinIO, web, controlled
  GitHub fixture, and local Gitea fixture. Worker consumption was stopped only
  while asserting the isolated acceptance namespace and was restored after the
  run.
- **Isolation**: Redis DB `15`, `fieldframe-phase015-test` prefix, and the
  `phase015-test/` MinIO snapshot prefix. The normal
  `annotation-platform` namespace was not used by the controlled suite.
- **Repository-import matrix command**: the command above completed in
  `22.348s`: 17 tests total, 16 passed, 0 failed, 1 intentionally skipped.
  The skipped case is the dedicated transport-outage test, because that test
  must run with web pointed at an unused Redis port.
- **Transport-outage command**: the dedicated real-outage recovery test passed
  `1/1` in `3.881s`. It verified `202` after commit, one `QUEUED` Job with no
  queue stamp, and recovery delivery of exactly `{ jobId }` for that same Job.
- **No-side-effect/redaction**: invalid input, unsafe provider selections,
  foreign/malformed connection IDs, and owned expired/revoked/`ERROR`/missing
  credential states left Dataset, Job, JobEvent, isolated Redis, and MinIO
  snapshots unchanged. Response tests excluded credential, ciphertext, raw
  Job, queue, storage, configuration, and stack-trace fields. No secret value
  was printed.
- **Prisma**: `pnpm exec prisma validate`, `pnpm exec prisma generate`, and
  `pnpm exec prisma migrate status` passed; the local schema is up to date.
- **Dependency regression suites**:
  - repository-preflight: 32 total, 29 passed, 0 failed, 3 documented
    fixture/access-log skips;
  - auth/ownership: 15 passed, 0 failed, 0 skipped;
  - worker queue: 23 total, 19 passed, 0 failed, 4 documented runtime skips.
- **Static/build validation**: root `pnpm typecheck` and `pnpm lint` passed;
  `git diff --check` passed. The host `pnpm build` wrote a fresh Next build
  artifact; the controlled `COMPOSE_BAKE=false docker compose build web` also
  completed the domain, queue, and production web build. Worker build passed
  with `pnpm --filter @annotationplatform/worker build`.

## Scope review — single public write boundary confirmed

Phase 015 did not implement repository cloning, complete manifest persistence,
binary transfer, MinIO writes, Asset creation, or worker import processing.
PostgreSQL remains Job authority and every observed BullMQ delivery is exactly
`{ jobId }`.

On 2026-07-28, `/datasets/imports` was migrated to read-only `POST
/api/source-import-preflight` followed by the sole durable route `POST
/api/datasets/from-repository`. The UI supplies the Phase-015 idempotency key
only at Start Import. For `ONE_TIME_PAT`, preflight is in-memory only and
Start Import requires `saveAsSourceConnection=true`; the shared transaction
creates the encrypted owned SourceConnection, Dataset, and Job once.

`POST /api/source-import-jobs` is retired and returns `410
SOURCE_IMPORT_JOBS_DEPRECATED`. The controlled Compose run used normal
opaque-cookie signup/login, PostgreSQL, MinIO, Gitea, GitHub fixture, and
passworded Redis DB `15` with prefix `fieldframe-phase015-test`. It recorded
**21 total, 20 passed, 0 failed, 1 documented queue-outage skip** in 25.1
seconds. It proved no durable effects during preflight/denial, one idempotent
encrypted connection for the saved one-time PAT path, and queue payloads
exactly `{ jobId }`. No secret values were printed.

## Expected evidence record

The eventual task validation record must state, without secret values:

- command and duration;
- Compose services and normal opaque-cookie auth mode;
- isolated Redis DB/prefix and MinIO prefix names;
- test totals/pass/fail/skip;
- public/private/invalid/idempotent/enqueue-failure scenario result;
- exact queue payload assertion result;
- no-side-effect and redaction result;
- whether migration approval and application occurred;
- known limitations: no clone, full manifest, binary transfer, Asset creation,
  or worker import processing in Phase 015.
