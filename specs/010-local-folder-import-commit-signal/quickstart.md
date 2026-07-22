# Phase 010 Validation Quickstart

## Prerequisites

- Phase 009 safe Job API/UI, claim lock, and passworded local Redis integration are green.
- Compose PostgreSQL, MinIO, Redis, web, and worker are healthy.
- Existing database, MinIO, Redis, queue prefix, upload capability, and CORS configuration is present; never print secrets.

## Validation sequence

1. Preflight a folder and prove no absolute path or binary reaches the backend.
2. Start an import; verify one Dataset, PreparedImport, and `IMPORT_DATASET` Job, with queue payload `{ jobId }` only.
3. Complete image/video/text/audio uploads and verify one correctly-modal Asset/child row each.
4. Commit complete import; verify counts and one completed Job.
5. Commit incomplete import; verify `IMPORT_INCOMPLETE` and non-terminal progress.
6. Omit commit until deadline; verify one `IMPORT_COMMIT_TIMEOUT` failure.
7. Repeat start/completion/commit/stale/retry and prove no duplicate objects, Assets, Jobs, or terminal events.
8. Run ownership/no-side-effect, worker, MinIO, and build/type checks.
# Phase 010 validation

Run the local import suite only with the existing safe Compose PostgreSQL, MinIO,
and passworded loopback Redis configuration. Do not hardcode credentials or
start an unauthenticated Redis instance.

```bash
pnpm exec prisma validate
pnpm exec prisma generate
pnpm --filter @fieldframe/web test:local-folder-import
pnpm --filter @fieldframe/web typecheck
pnpm --filter @fieldframe/worker typecheck
```

## Validation record — 2026-07-17

- Additive migration `20260717010000_add_prepared_imports` applied to the local
  Compose PostgreSQL database.
- `pnpm --filter @fieldframe/web build`: passed outside the restricted
  sandbox (Turbopack requires process/port capability).
- `pnpm --filter @fieldframe/worker build`: passed.
- PostgreSQL commit race/no-side-effect tests: passed when given the Compose
  database URL.
- Private-network MinIO cleanup test: passed in an ephemeral web container on
  `anotations_default`; no MinIO port was published.
- Worker `IMPORT_DATASET` lease/cancel and timeout tests: passed against local
  Compose PostgreSQL.

The default host test command intentionally skips provider integration tests
when it cannot be given the controlled Compose-internal configuration.

## Final evidence audit — 2026-07-17

| Task | Authenticated HTTP executed | Compose services used | `LOCAL_IMPORT_INTEGRATION_TESTS=1` | Exact command/evidence | Result | Status |
| --- | --- | --- | --- | --- | --- | --- |
| T014 | No | No | No | Test file exists, but no authenticated runtime command was recorded. | Not run | Open |
| T015 | No | No | No | No local-folder capability/completion HTTP evidence recorded. | Not run | Open |
| T016 | No | No | No | No modality child-row HTTP reconciliation evidence recorded. | Not run | Open |
| T039 | No | No | No | No full role HTTP matrix evidence recorded. | Not run | Open |
| T040 | No | No | No | No denied HTTP side-effect matrix evidence recorded. | Not run | Open |
| T041 | No | No | No | No cross-reference ownership HTTP evidence recorded. | Not run | Open |
| T042 | No | No | No | Static response audit exists, but no authenticated response-audit run. | Not run | Open |
| T045 | Partial | Yes | No | Controlled worker queue suite and private MinIO cleanup ran separately; no consolidated local-folder HTTP command exists. | Incomplete | Open |

Secrets were not printed in recorded commands or output. The normal Redis
namespace remained separate from the controlled worker suite. This table is
the authoritative Phase 010 completion evidence: none of the rows above may
be marked complete until an authenticated HTTP test has run successfully
against the controlled Compose services with `LOCAL_IMPORT_INTEGRATION_TESTS=1`.

### Attempted authenticated integration run — 2026-07-17

Command executed (with isolated Redis settings and no secret output):

```bash
LOCAL_IMPORT_INTEGRATION_TESTS=1 QUEUE_INTEGRATION_TESTS=1 \
REDIS_HOST=127.0.0.1 REDIS_DB=15 REDIS_TEST_DB=15 \
BULLMQ_PREFIX=fieldframe-phase010-test \
REDIS_TEST_PREFIX=fieldframe-phase010-test \
pnpm --filter @fieldframe/web test:local-folder-import
```

Result: **5 passed, 3 failed, 0 skipped**. The host test runner could not
resolve the Compose-only hostname `minio`; the new start-route fixture also
received HTTP 400 from `/api/auth/login`. This run did use
`LOCAL_IMPORT_INTEGRATION_TESTS=1`, but it was not a successful authenticated
Compose HTTP run. No secrets or presigned query strings were printed.

Consequently T014, T015, T016, T039, T040, T041, T042, and T045 remain open.

### T014 authenticated HTTP evidence — 2026-07-17

The controlled command above was rerun after adding HTTP absolute-path and
binary-shaped JSON rejection coverage. Result: **9 passed, 0 failed, 0
skipped**. The test uses seeded password credentials only to establish users,
then authenticates exclusively through `/api/auth/login` opaque cookies.
It uses real Compose PostgreSQL, MinIO, and passworded Redis DB 15 with the
`fieldframe-phase010-test` prefix. No secrets or presigned query strings were
printed. T014 is complete; the remaining rows stay open.

For database/object integration, set `LOCAL_IMPORT_INTEGRATION_TESTS=1` and
explicitly provide the controlled Compose database URL. Tests do not silently
use a default host URL.

## Final consolidated runtime validation — 2026-07-17

This record supersedes the open statuses in the earlier pre-fix audit. It was
run against controlled local Docker Compose PostgreSQL, passworded loopback
Redis, and MinIO. The authenticated HTTP tests start a temporary local Next.js
server from the production build; Compose `web` was separately verified from
inside its container because it is intentionally not host-published.

```bash
LOCAL_IMPORT_INTEGRATION_TESTS=1 QUEUE_INTEGRATION_TESTS=1 \
REDIS_HOST=127.0.0.1 REDIS_DB=15 REDIS_TEST_DB=15 \
BULLMQ_PREFIX=fieldframe-phase010-test \
REDIS_TEST_PREFIX=fieldframe-phase010-test \
pnpm --filter @fieldframe/web test:local-folder-import
```

- Authentication: normal `/api/auth/login` opaque cookie session. Test users
  are seeded only with a valid password hash; `DEV_AUTH_EMAIL` is not used.
- Redis isolation: host `127.0.0.1`, DB `15`, and the
  `fieldframe-phase010-test` prefix. The normal `annotation-platform`
  namespace was not changed.
- Services: Compose PostgreSQL, MinIO, passworded Redis, web, and worker were
  running; MinIO liveness and the web `/api/health` endpoint both passed.
- Test files: all `apps/web/tests/local-folder-import/**/*.test.ts`, including
  `item-completion`, `modality-assets`, `ownership-matrix`, and
  `upload-capability-security`.
- Result: **16 passed, 0 failed, 0 skipped**. Tests used real PostgreSQL,
  MinIO POST uploads, and Redis; no provider/database/queue mock was used.
- Worker command (same isolated Redis configuration):
  `QUEUE_INTEGRATION_TESTS=1 REDIS_HOST=127.0.0.1 REDIS_DB=15 REDIS_TEST_DB=15 BULLMQ_PREFIX=fieldframe-phase010-test REDIS_TEST_PREFIX=fieldframe-phase010-test pnpm --filter @fieldframe/worker test:queue`
  → **18 passed, 0 failed, 0 skipped**.
- Validation: `pnpm exec prisma migrate status` reported the database up to
  date; `pnpm exec prisma validate`, `pnpm exec prisma generate`, web and
  worker typechecks, `pnpm --filter @fieldframe/web build`, and worker build
  passed.
- Secret handling: commands and test assertions did not print credentials,
  passwords, tokens, database URLs, capability secrets, or presigned query
  strings. Structured-log inspection is not available in this test runner;
  HTTP response redaction is the executed evidence.

| Task | Authenticated Compose HTTP evidence | Result |
| --- | --- | --- |
| T014 | start/preflight and denial routes | Pass |
| T015 | capability, real MinIO POST, completion, replay, missing object | Pass |
| T016 | image/video/text/audio child-row reconciliation | Pass |
| T039 | owner/manager/reviewer/labeler/non-member policy matrix | Pass |
| T040 | expired, tampered, cross-item capability and unauthenticated denial | Pass |
| T041 | preparation/item/Dataset/view ownership boundary | Pass |
| T042 | success/error/view response redaction audit | Pass |
| T045 | consolidated Compose, Prisma, build, and worker evidence | Pass |

The expiry case uses a server-only injected clock to issue an already-expired
signed capability, then submits it through the normal HTTP completion route;
it proves expiry rejection without waiting for the ten-minute production TTL.
