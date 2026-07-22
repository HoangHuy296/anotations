# Phase 012 Validation Guide

This guide validates the planned Phase 012 feature after implementation. It does not authorize implementation or change runtime credentials.

## Prerequisites

- Approved Phase 012 implementation and an active authenticated local account with authorized access to an active Dataset.
- Controlled Compose services for PostgreSQL, passworded Redis, MinIO, web, and worker are running.
- `.env` supplies server-only provider configuration. Do not print, commit, or paste credential values.
- For full queue tests, use the repository's safe local Redis policy: loopback host, password, dedicated non-zero test DB, and dedicated test prefix. Preserve the normal application queue namespace.

## Static validation

Run from repository root:

```bash
pnpm db:validate
pnpm db:generate
pnpm typecheck
pnpm lint
pnpm build
```

Expected: all commands exit successfully. This phase should require no migration; do not run a migration solely for Phase 012 unless a separately approved schema change exists.

## Focused workspace validation

```bash
pnpm --filter @fieldframe/web test:workspace
```

Verify the workspace suite includes:

1. A 1.5-second autosave persists a geometry edit and an Asset description; reload returns updated values and revisions.
2. Navigation flushes a pending save. A failed/conflicted draft remains recoverable and is never silently discarded.
3. Two sessions saving the same prior revision cause the second save to conflict without changing the first durable value.
4. Search and status filters run across at least 250 authorized Assets; each page has at most 100; previous/next stays in the selected filtered order.
5. Non-members and insufficient roles cannot read, save, search, or navigate protected Dataset content, and denial makes no business-state side effect.

## Controlled export integration validation

Start or verify controlled local services using the repository's Compose instructions. Then set only non-secret test mode/Redis-isolation variables in the command environment, using a configured passworded loopback Redis connection, and run:

```bash
pnpm --filter @fieldframe/web test:job-queue
pnpm --filter @fieldframe/worker test:queue
```

The implementation's dedicated export tests must also be included in those suites or exposed as documented focused targets. The run must prove:

1. An authorized Dataset member creates or reuses a durable `EXPORT_DATASET` Job and the queue receives exactly `{ jobId }`.
2. PostgreSQL, not Redis, supplies the browser-visible status/progress.
3. The worker claims, progresses, completes, fails, or cancels only through the existing lock-token lifecycle.
4. The private MinIO export artifact exists only after a successful worker completion and repeated delivery/retry does not create a duplicate for one Job.
5. The completed JSON includes Dataset/Asset/Label/Annotation metadata, canonical geometry, and properties, but no binaries, credentials, private object keys, raw Job values, or queue internals.
6. A non-member or insufficient role cannot start, observe, or download another Dataset's export and causes no Job, queue, or storage side effect.
7. The completed authorized download is short-lived and the HTTP response is redacted.

## Manual browser smoke

1. Open an authorized Dataset workspace with at least 250 Assets and change one annotation or image description. Wait 1.5 seconds and observe `saved`; reload to confirm persistence.
2. Make a second-session conflicting change. Confirm the stale session shows a conflict and keeps its local draft without overwriting the newer durable value.
3. Search by filename, filter by status, switch page, and use previous/next. Confirm filter/query/page remain stable and no pending work disappears.
4. Start a JSON export through the application UI. Observe safe job progress until completed.
5. Download the completed export using the authorized UI. Inspect the JSON for required metadata and confirm it has no binary payload, secret, bucket/object key, or private URL.

## Expected environment variables

The runtime continues to require the existing database, private MinIO, Redis/BullMQ, and upload-capability environment configuration. Full queue integration additionally requires its existing explicit test-isolation variables. Never display values for database URLs, Redis passwords, MinIO credentials, provider tokens, or capability secrets in command output or validation records.

## Completed runtime validation — 2026-07-22

**Run window**: 2026-07-22 15:13–15:26 (Asia/Ho_Chi_Minh).

**Controlled services**: Compose PostgreSQL, password-protected Redis, and MinIO were healthy. The final end-to-end proof used newly built disposable Compose `web` and `worker` containers on the same Compose network; those two disposable containers were removed after the successful run. The normal application containers and the normal `annotation-platform` queue namespace were not recreated or modified.

**Authentication**: HTTP tests used `/api/auth/login` and the resulting opaque HttpOnly cookie backed by PostgreSQL `AuthSession`. `DEV_AUTH_EMAIL` and other authentication bypasses were not used.

**Redis isolation**: all Phase 012 queue runs used loopback Redis for the host runner, DB `15`, `BULLMQ_PREFIX=fieldframe-phase012-test`, and `REDIS_TEST_PREFIX=fieldframe-phase012-test`. The password was loaded from the existing server-only environment and was never printed. The normal DB/prefix remained untouched.

### Exact commands and results

Static validation from the repository root:

```bash
pnpm db:validate
pnpm db:generate
pnpm typecheck
pnpm lint
pnpm build
```

Result: all five commands passed. The final `pnpm build` compiled `@fieldframe/domain`, `@fieldframe/queue`, the Next.js production application, and the private worker. Prisma generation did not change the schema or create a migration.

Workspace validation:

```bash
WORKSPACE_INTEGRATION_TESTS=1 MINIO_VIEW_INTEGRATION_TESTS=1 \
pnpm --filter @fieldframe/web test:workspace
```

Result: 34 tests; 33 passed, 0 failed, 1 skipped. The skipped test is an unrelated explicitly guarded auth-flow case; the real PostgreSQL revision, MinIO view capability, 250-Asset search/pagination, filtered navigation, authorization, autosave, flush, and conflict tests passed.

Controlled web queue/export suite:

```bash
QUEUE_INTEGRATION_TESTS=1 EXPORT_INTEGRATION_TESTS=1 \
REDIS_HOST=127.0.0.1 REDIS_DB=15 REDIS_TEST_DB=15 \
BULLMQ_PREFIX=fieldframe-phase012-test REDIS_TEST_PREFIX=fieldframe-phase012-test \
pnpm --filter @fieldframe/web test:job-queue
```

Final result: 34 tests; 34 passed, 0 failed, 0 skipped. This includes authenticated create/status/download, role and cross-Dataset denial, denial no-side-effects, Redis payload redaction, real transport outage/recovery, and the complete export E2E test.

Controlled private-worker suite:

```bash
QUEUE_INTEGRATION_TESTS=1 EXPORT_INTEGRATION_TESTS=1 \
REDIS_HOST=127.0.0.1 REDIS_DB=15 REDIS_TEST_DB=15 \
BULLMQ_PREFIX=fieldframe-phase012-test REDIS_TEST_PREFIX=fieldframe-phase012-test \
pnpm --filter @fieldframe/worker test:queue
```

Result: 23 tests; 23 passed, 0 failed, 0 skipped. The suite proves atomic claim ownership, progress, cancellation acknowledgement, expired/foreign-lock denial, deterministic artifact reconciliation, redacted manifest construction, duplicate delivery safety, and legacy import routing regression safety.

Controlled Redis outage/recovery proof:

```bash
QUEUE_INTEGRATION_TESTS=1 EXPORT_INTEGRATION_TESTS=1 \
REDIS_HOST=127.0.0.1 REDIS_DB=15 REDIS_TEST_DB=15 \
BULLMQ_PREFIX=fieldframe-phase012-test REDIS_TEST_PREFIX=fieldframe-phase012-test \
node --env-file-if-exists=../../.env \
  --require ./tests/auth-ownership/register-server-only.cjs \
  --import tsx --test --test-concurrency=1 \
  tests/job-queue/export-recovery.test.ts
```

Run from `apps/web`. Result: 1 passed, 0 failed, 0 skipped. A real fail-fast BullMQ transport targeted a released loopback port, leaving exactly one PostgreSQL Job at `QUEUED` with null enqueue metadata. Recovery through the controlled Redis instance delivered exactly `{ jobId }` once; a second scan found nothing and no Job or artifact was duplicated. The expected loopback connection-refused diagnostic contained no credential.

Compose web/worker end-to-end proof:

```bash
COMPOSE_BAKE=false docker compose build web worker

docker compose run -d --no-deps --name fieldframe-phase012-web \
  -p 127.0.0.1:3115:3000 \
  -e REDIS_DB=15 -e BULLMQ_PREFIX=fieldframe-phase012-test \
  -e MINIO_PUBLIC_ENDPOINT=http://127.0.0.1:9000 web

docker compose run -d --no-deps --name fieldframe-phase012-worker \
  -e REDIS_DB=15 -e BULLMQ_PREFIX=fieldframe-phase012-test worker

QUEUE_INTEGRATION_TESTS=1 EXPORT_INTEGRATION_TESTS=1 \
EXPORT_E2E_BASE_URL=http://127.0.0.1:3115 EXPORT_E2E_EXTERNAL_WORKER=1 \
REDIS_HOST=127.0.0.1 REDIS_DB=15 REDIS_TEST_DB=15 \
BULLMQ_PREFIX=fieldframe-phase012-test REDIS_TEST_PREFIX=fieldframe-phase012-test \
node --env-file-if-exists=../../.env \
  --require ./tests/auth-ownership/register-server-only.cjs \
  --import tsx --test --test-concurrency=1 \
  tests/job-queue/export-e2e.test.ts
```

The Node command was run from `apps/web`. Final result: 1 passed, 0 failed, 0 skipped. It proved authenticated HTTP POST → one PostgreSQL `EXPORT_DATASET` Job → BullMQ payload exactly `{ jobId }` → private Compose worker atomic claim → PostgreSQL progress/stage/counters → one private MinIO JSON artifact → terminal `COMPLETED` result metadata → authorized safe status and short-lived download capability → redacted manifest download. Cross-Dataset create/read/cancel denials produced no Job, JobEvent, queue, or storage side effect.

### Architecture and secrecy audit

- PostgreSQL remains canonical for Job input, lifecycle, progress, attempts, result metadata, and terminal outcome.
- BullMQ/Redis contains only the strict `{ jobId }` delivery payload; no manifest, raw export configuration, credential, URL, or binary value was stored there.
- The worker obtains export configuration and Dataset metadata from PostgreSQL after atomic claim and writes one deterministic private artifact to MinIO.
- Browser responses use explicitly allowlisted DTOs. Raw Job input/state/result/events, queue fields, lock tokens, private storage keys, credentials, and server configuration are absent.
- Download signing uses the server-only public-endpoint signer with a fixed MinIO region; provider credentials remain server-side and the returned URL is only the approved short-lived object capability.
- `docker-compose.yaml` now fixes container-internal provider hosts to `minio` and `redis`; host/browser endpoints remain separate.
- No secret, cookie, password, database URL, Redis password, MinIO credential, provider token, or presigned query string was copied into this record. `.env` was not modified.
- No `schema.prisma` change, migration, raw SQL expansion, new package, separate Job table, public worker route, or modality-specific workspace route was introduced by Phase 012.

### Completed task evidence

T021, T030, T034, T041, T048, T049, T050, T051, T052, T053, T054, T055, and T056 all have passing runtime/static evidence recorded above. All Phase 012 tasks are complete.

### Known limitations

- Export format is intentionally JSON manifest version 1 and metadata-only; binary files are referenced logically and are not bundled.
- The automated Compose E2E is the acceptance evidence; the optional manual browser walkthrough in this guide was not recorded as an automated assertion.
- The installed Compose version panicked in its Bake path once; `COMPOSE_BAKE=false` was used to build successfully. This is a local Docker Compose tooling limitation, not an application failure.
- Compose configuration remains a local-development runtime. Production secret injection, TLS, retention policies, and operational monitoring are outside Phase 012.
