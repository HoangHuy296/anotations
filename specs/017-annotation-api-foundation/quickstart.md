# Phase 017 Validation Guide

## Preconditions

- Local PostgreSQL is available through the normal application configuration.
- Use normal `/api/auth/register` or `/api/auth/login` opaque-cookie sessions;
  do not use `DEV_AUTH_EMAIL` or an auth bypass.
- Use isolated test fixtures that create an owner, permitted member, foreign
  user, Dataset, IMAGE Asset, and Label.
- No Redis, MinIO, provider, or worker configuration is required for a normal
  annotation API test because this feature is synchronous metadata work.

## Required scenarios

1. Sign in through the normal HTTP route and request annotations for an Asset
   with no rows. Expect `200` and an empty array.
2. Create a valid normalized bounding box through the Asset-scoped PUT route.
   Read it back and verify its canonical geometry and initial revision.
3. Move or resize it with its current revision. Verify geometry changes,
   revision increments, and label/properties/status remain unchanged.
4. Submit an out-of-range coordinate, invalid extent, invalid label, or
   cross-Asset annotation ID. Verify validation/concealment and no database
   mutation.
5. Use two authenticated actors with the same revision. Verify one update wins,
   the stale update returns `409 ANNOTATION_REVISION_CONFLICT`, and a mixed
   change set with a stale row rolls back completely.
6. Test owner, permitted member, foreign actor, unknown Asset, malformed ID,
   and cross-Dataset reference behavior. Verify safe errors and no annotation
   disclosure.
7. Audit successful and failed JSON responses for no token, session cookie,
   SourceConnection, storage, queue, raw error, or stack information.
8. Re-run existing workspace annotation mutation/locking tests to ensure the
   API foundation did not regress current canvas behavior.

## Suggested non-secret commands

```bash
WORKSPACE_INTEGRATION_TESTS=1 \
pnpm --filter @annotationplatform/web test:workspace

ANNOTATION_API_INTEGRATION_TESTS=1 \
pnpm --filter @annotationplatform/web test:annotation-api

pnpm exec prisma validate
pnpm exec prisma generate
pnpm --filter @annotationplatform/web typecheck
pnpm --filter @annotationplatform/web lint
pnpm --filter @annotationplatform/web build
git diff --check
```

Use the repository's actual test scripts when tasks are generated; do not print
connection strings, cookies, credentials, or environment variable values in
validation records.

## Expected result

All focused API and workspace regression suites pass. The validation record
must show authenticated HTTP evidence for empty-list, valid save, conflict,
authorization/concealment, geometry rejection, and no-side-effect behavior.
No migration or new dependency is expected.

## Executed implementation checks — 2026-07-29

- `pnpm exec prisma validate` — passed.
- `pnpm --filter @annotationplatform/web lint` — passed.
- `pnpm --filter @annotationplatform/web typecheck` — passed.
- `pnpm --filter @annotationplatform/web test:workspace` — rerun after the five-shape
  editing and read-only visualization changes: 18 passed, 0 failed, duration
  8.36 seconds.
- Focused command
  `node --env-file-if-exists=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test --test-concurrency=1 tests/annotation-api/*.test.ts`
  from `apps/web` — 2 test files passed. The database-backed service case is
  explicitly opt-in behind `ANNOTATION_API_INTEGRATION_TESTS=1` and has not
  been counted as live PostgreSQL evidence.

### Runtime records

The PostgreSQL host readiness gate has now passed. The first independent live
suite was recorded immediately:

- `pg_isready -h 127.0.0.1 -p 5433` — accepting connections.
- `ANNOTATION_API_HTTP_TESTS=1 ANNOTATION_API_HTTP_BASE_URL=http://127.0.0.1:3000 node --env-file-if-exists=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test --test-concurrency=1 tests/annotation-api/annotation-http.test.ts`
  from `apps/web` — rerun after geometry preservation, label reassignment,
  idempotent create replay, deletion, and isolated side-effect coverage: 5 passed, 0 failed,
  0 skipped, duration 2.04 seconds.
  This used normal `/api/auth/login` opaque cookies and proved GET reads for
  IMAGE/VIDEO/TEXT/AUDIO, foreign concealment, five IMAGE creates, non-IMAGE
  write refusal, invalid-geometry/cross-Asset refusal, response redaction,
  malformed/unknown/cross-Dataset concealment, and PostgreSQL Job/JobEvent
  non-mutation. Manager/reviewer `updateAny`, labeler `updateOwn`, and
  labeler refusal for another creator are also covered. Geometry-only edits,
  explicit label reassignment, replay identity, and deletion are covered too.
  The explicit isolated run used Redis DB 15 and a Phase 017-only queue prefix,
  plus MinIO prefix `phase017-annotation-api/`; invalid geometry, cross-Asset,
  and foreign requests left PostgreSQL annotation/Job/JobEvent state, the
  isolated Redis namespace, and that MinIO prefix unchanged. No configuration
  or credentials were printed.

  The final all-in-one focused run used the same normal opaque-cookie route,
  `ANNOTATION_API_INTEGRATION_TESTS=1`, the explicit isolated side-effect
  gate, Redis DB 15 with the Phase 017-only test prefix, and the host-reachable
  private MinIO endpoint:

  ```bash
  ANNOTATION_API_INTEGRATION_TESTS=1 \
  ANNOTATION_API_HTTP_TESTS=1 \
  ANNOTATION_API_SIDE_EFFECT_TESTS=1 \
  QUEUE_INTEGRATION_TESTS=1 \
  REDIS_HOST=127.0.0.1 REDIS_DB=15 REDIS_TEST_DB=15 \
  BULLMQ_PREFIX=fieldframe-phase017-test \
  REDIS_TEST_PREFIX=fieldframe-phase017-test \
  MINIO_ENDPOINT=http://127.0.0.1:9000 \
  MINIO_PUBLIC_ENDPOINT=http://127.0.0.1:9000 \
  ANNOTATION_API_HTTP_BASE_URL=http://127.0.0.1:3000 \
  node --env-file-if-exists=../../.env \
    --require ./tests/auth-ownership/register-server-only.cjs \
    --import tsx --test --test-concurrency=1 tests/annotation-api/*.test.ts
  ```

  It completed with 14 passed, 0 failed, 0 skipped in 5.16 seconds. This is
  the final authenticated HTTP/service/race/redaction/no-side-effect evidence.

The independent revision-race and atomic-rollback suite remains the next live
record. No credentials or connection strings are recorded here.

### Independent revision-race record

- `ANNOTATION_API_HTTP_TESTS=1 ANNOTATION_API_HTTP_BASE_URL=http://127.0.0.1:3000 node --env-file-if-exists=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test --test-concurrency=1 tests/annotation-api/annotation-conflicts-http.test.ts`
  from `apps/web` — 1 passed, 0 failed, 0 skipped, duration 0.90 seconds.
  Two concurrent updates sharing one observed revision produced exactly one
  winner and one `409` conflict. A stale mixed create/update request rolled
  back completely. This was rerun after the revision-name reconciliation.

### Shared-service PostgreSQL record

- `ANNOTATION_API_INTEGRATION_TESTS=1 node --env-file-if-exists=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test --test-concurrency=1 tests/annotation-api/annotation-service.test.ts`
  from `apps/web` — rerun after the workspace loading regression: 2 passed, 0 failed, 0 skipped, duration 1.15 seconds.
  The canonical server-only service returned empty lists for IMAGE, VIDEO,
  TEXT, and AUDIO, atomically persisted the five supported IMAGE shapes, and
  separated editable IMAGE shapes from read-only unsupported annotations.

## Final validation record — 2026-07-29

- `pnpm exec prisma validate` — passed.
- `pnpm exec prisma generate` — passed.
- `pnpm --filter @annotationplatform/web lint` — passed.
- `pnpm --filter @annotationplatform/web typecheck` — passed.
- Workspace suite — 18 passed, 0 failed.
- Workspace suite with `WORKSPACE_INTEGRATION_TESTS=1` — 34 passed, 0 failed,
  2 intentional MinIO/auth opt-in skips, duration 12.97 seconds. The legacy
  action compatibility and revision regression cases ran against PostgreSQL.
- Focused annotation API suite with all live integration and isolated
  side-effect flags — 14 passed, 0 failed, 0 skipped, duration 5.16 seconds.
- Independent production build — exit code `0`; the output tail contained the
  route manifest and dynamic `/workspace/[datasetId]` entry.
- `git diff --check` — passed.

### Architecture and scope audit

- PostgreSQL is the sole annotation and revision authority; the API and
  workspace use Prisma only.
- No Job, JobEvent, BullMQ/Redis, MinIO, worker, provider, or binary operation
  is introduced by annotation reads or writes.
- The browser API exposes no raw Job input, source credentials, storage keys,
  provider response, queue data, or session material. HTTP redaction is the
  evidence; no test-accessible structured logger exists.
- GET reads IMAGE, VIDEO, TEXT, and AUDIO through the shared server-only
  service. PUT accepts IMAGE only and rejects unsupported modalities.
- The queue payload contract is unchanged because this phase never enqueues.
- No schema or migration change and no dependency change were introduced.
- Segmentation and other unsupported IMAGE types remain visibly read-only;
  non-image writes, autosave timing, review flow, and background processing
  remain intentionally out of scope.

### Completion status

All Phase 017 tasks have executed green evidence. The two workspace skips are
intentional pre-existing MinIO/auth opt-in cases outside this phase's direct
annotation API boundary. No test printed credentials, cookies, provider URLs,
or infrastructure secrets.
