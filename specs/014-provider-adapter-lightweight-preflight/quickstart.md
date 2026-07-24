# Phase 014 Validation Quickstart

## Prerequisites

- Controlled Compose PostgreSQL, password-protected Redis, MinIO, and web
  services are running. Redis must use an isolated test database/prefix for
  validation snapshots.
- A controlled GitHub/Gitea-compatible provider fixture is available for
  repository/ref/root, auth, DNS, and redirect cases. Do not put provider
  tokens, connection URLs, or credentials in command output.
- Test users authenticate through normal `/api/auth/login` opaque cookie
  sessions. Do not use an auth bypass or browser token storage.
- When credentialed Gitea coverage is required, an existing active owned
  SourceConnection is prepared through the approved Phase 013 lifecycle.

## Expected implementation validation commands

Run these after Phase 014 test targets have been added. Inject secrets
ephemerally with shell tracing disabled; do not print them.

```bash
pnpm exec prisma validate
pnpm --filter @fieldframe/web typecheck
pnpm --filter @fieldframe/web lint
pnpm --filter @fieldframe/web test:repository-preflight
pnpm --filter @fieldframe/web build
```

No schema change is planned, so `prisma migrate` is not part of this phase.

## Phase-014 scope guard

This validation target exercises only the read-only preflight endpoint. It
must not create or mutate a Dataset, Job, JobEvent, SourceConnection,
ExternalRepository, Asset, persisted manifest, Redis/BullMQ delivery, or
MinIO object. It must not clone, download source bytes, call legacy import
routes, add a dependency, use raw SQL, change `schema.prisma`, or create a
migration. Use `pnpm --filter @fieldframe/web test:repository-preflight` for
the targeted suite; do not substitute an import/worker test for this boundary.

## Controlled HTTP checks

1. Log in through `/api/auth/login` and retain the opaque cookie only in the
   test client.
2. Call `POST /api/source-repositories/preflight` for a controlled public
   GitHub and Gitea repository. Verify safe repository/ref/root results.
3. Repeat with an owner’s active Gitea connection and verify the response does
   not contain any connection/token material.
4. Verify unsupported provider, unsafe URL/DNS/redirect, foreign connection,
   invalid/expired credential, missing ref, and missing root each return their
   documented safe code.
5. Snapshot PostgreSQL durable entities, isolated Redis/BullMQ state, and an
   isolated MinIO prefix before and after every case. All snapshots must remain
   unchanged.
6. Verify no test result contains credential, private URL, provider body,
   storage/database/Redis configuration, or stack-trace sentinels.

## Expected outcome

Each preflight result is transient. It does not create a Dataset, Job,
JobEvent, queue delivery, object, clone, download, SourceConnection mutation,
or stored manifest. Record a redacted validation summary with date, services,
test command, pass/fail counts, snapshot result, and limitations before any
Phase 014 task is marked complete.

## Validation record — 2026-07-23

- Server-only adapter target: `pnpm --filter @fieldframe/web
  test:repository-preflight` completed with **11 passed, 0 failed, 2 skipped**.
  The passing coverage uses only a loopback controlled provider fixture and
  validates strict request fields, GitHub/Gitea bounded metadata checks,
  exact/default refs, redirect-hop rejection, safe projection, and the
  unreachable `downloadFile` contract.
- `pnpm exec prisma validate`, `pnpm --filter @fieldframe/web typecheck`, and
  `pnpm --filter @fieldframe/web lint` passed. The production web build also
  passed outside the execution sandbox, which requires an internal local port
  for Turbopack.
- No credential, provider URL, session cookie, database URL, Redis password,
  storage credential, or encryption secret was printed in this record.
- The two authenticated Compose HTTP/snapshot tests remain explicitly skipped:
  this environment has not supplied `REPOSITORY_PREFLIGHT_INTEGRATION_TESTS=1`
  with a controlled Compose web URL and provider fixture. Consequently, the
  Phase-014 HTTP/no-side-effect runtime tasks remain open and this phase is not
  approved as complete.

## Controlled runtime evidence — 2026-07-24

- The opt-in `docker-compose.preflight.yaml` override ran web with `next dev`
  and server-controlled fixture settings only. Production Compose remains
  unchanged: it uses `next start` and continues to reject plaintext/private
  test endpoints.
- Services used: Compose PostgreSQL, passworded Redis, MinIO, web, and the
  private `github-fixture` service. Authentication used normal
  `/api/auth/signup` followed by `/api/auth/login`; the test client retained
  the opaque cookie only in memory. No auth bypass or `DEV_AUTH_EMAIL` was
  used.
- Exact redacted command:

  ```bash
  REPOSITORY_PREFLIGHT_INTEGRATION_TESTS=1 REDIS_HOST=127.0.0.1 \
  REDIS_DB=15 REDIS_TEST_DB=15 BULLMQ_PREFIX=fieldframe-phase014-test \
  REDIS_TEST_PREFIX=fieldframe-phase014-test \
  pnpm --filter @fieldframe/web test:repository-preflight
  ```

- Result: **14 passed, 0 failed, 0 skipped** in 6.23 seconds. The authenticated
  public-GitHub success, unauthenticated denial, repository/ref failure, and
  before/after PostgreSQL, isolated Redis/BullMQ, and MinIO-prefix snapshots
  passed. Responses were checked for configuration, credential, and stack
  sentinels; no secret values, session cookie, database URL, or presigned URL
  query string was printed.
- This is partial HTTP evidence only. Public Gitea and owned active Gitea
  connection success, canonical-ID snapshot expansion, full failure/DNS/
  redirect matrix, and cross-provider redaction parity are still open. Thus
  T013, T014, T021, T022–T027, T032–T035, T038, and T041 remain unchecked and
  Phase 014 is not complete.

## Controlled US1 runtime evidence — 2026-07-24

- Services: Compose web with the opt-in `docker-compose.preflight.yaml`
  override, PostgreSQL, passworded Redis, MinIO, local Gitea, and the local
  GitHub-compatible fixture. The override is local/test-only and grants the
  server-controlled `github-fixture` hostname; browser input cannot add it.
- Authentication: normal `/api/auth/signup` followed by `/api/auth/login`.
  The opaque cookie lived only in the test client; neither `DEV_AUTH_EMAIL`
  nor a session bypass was used.
- Redacted command: `REPOSITORY_PREFLIGHT_INTEGRATION_TESTS=1`, loopback web,
  Redis DB `15`, prefix `fieldframe-phase014-test`, and a PAT sourced only
  from untracked local test environment, followed by
  `pnpm --filter @fieldframe/web test:repository-preflight`.
- Result: **19 passed, 0 failed, 0 skipped** in 6.83 seconds. Authenticated
  HTTP coverage proved public GitHub, public Gitea, and an owned ACTIVE Gitea
  SourceConnection preflight. Every successful and tested rejected preflight
  compared canonical PostgreSQL Dataset/Job/JobEvent/SourceConnection/
  ExternalRepository/Asset projections plus isolated Redis/BullMQ and
  `phase014-test/` MinIO-prefix snapshots before and after the route call.
- Responses were checked for credentials, ciphertext field names, database,
  Redis and MinIO settings, authorization headers, and stack sentinels. No
  secret, cookie, PAT, database URL, provider private URL, or presigned query
  string was printed. This evidence completes T013, T014, and T021 only; the
  expanded failure, DNS/redirect, parity, and final controlled matrix remain
  open.

## Controlled US1/partial-US2 rerun — 2026-07-24

- Rebuilt only the web image with `COMPOSE_BAKE=false` (the local Compose
  Bake path panicked), ran the opt-in preflight override, then restored the
  normal Compose web service. PostgreSQL, Redis, MinIO, Gitea and worker were
  never recreated for this run.
- The controlled command again used normal opaque-cookie signup/login,
  loopback web, Redis DB `15`, prefix `fieldframe-phase014-test`, the local
  GitHub fixture, and a local PAT loaded without echoing it. Result:
  **20 passed, 0 failed, 0 skipped** in 9.42 seconds.
- The added HTTP cases prove stable `UNSUPPORTED_PROVIDER`,
  `REPOSITORY_NOT_FOUND`, `REF_NOT_FOUND`, and `ROOT_PATH_NOT_FOUND` outcomes
  with no durable, queue, or MinIO-prefix side effect and no response secret
  or stack sentinel. The route now distinguishes an explicit unsupported
  provider from an otherwise malformed request; malformed bodies still return
  `INVALID_REQUEST`.
- `pnpm --filter @fieldframe/web typecheck`, `pnpm --filter @fieldframe/web
  lint`, and `git diff --check` passed. This is still partial US2 evidence:
  T022 stays open until access-denial and forbidden-body HTTP cases are added;
  DNS, redirect, concealment, expired-token, parity, and full-matrix tasks are
  also intentionally open.

## T046/T047 source-import boundary evidence — 2026-07-24

- Controlled normal-cookie test: **1 passed, 0 failed, 0 skipped** in 4.07
  seconds against Compose PostgreSQL, isolated passworded Redis DB `15`,
  MinIO, Gitea and web. The local PAT was loaded only in process memory and
  never printed.
- `POST /api/source-import-preflight` remained read-only for PUBLIC,
  EXISTING_SOURCE_CONNECTION and ONE_TIME_PAT modes. `POST
  /api/source-import-jobs` re-preflighted then created a Dataset and QUEUED
  Job; saved ONE_TIME_PAT created exactly one owned ACTIVE encrypted
  SourceConnection. PUBLIC created neither a SourceConnection nor credential
  reference; EXISTING_SOURCE_CONNECTION reused the owned connection.
- Every queue delivery was asserted as exactly `{ jobId }`. Job input, API
  responses and JobEvents contained no PAT or encrypted credential. The
  unsaved one-time-PAT route remains tested as
  `422 ONE_TIME_PAT_REQUIRES_SAVE_FOR_ASYNC_IMPORT` with PostgreSQL, isolated
  Redis and MinIO snapshots unchanged. This completes T046 and T047.

## Scope audit — 2026-07-23

The Phase-014 implementation introduces only the server-only provider
boundary, strict validation, one safe preflight route, targeted tests, and
documentation. The audit found no Phase-014 changes to Prisma schema or
migrations, dependencies/lockfile, raw SQL, legacy Gitea import routes, Job
creation/enqueue code, Redis/BullMQ transport, MinIO writes, repository clone
operations, file download operations, or persisted manifests. `downloadFile`
is contract-only and its Phase-014 implementation rejects invocation.

## Amendment validation record — 2026-07-24

- Rebuilt the web image successfully, then used the opt-in
  `docker-compose.preflight.yaml` only for the controlled fixture run. Web was
  recreated again with normal `docker-compose.yaml` after the run.
- Exact redacted command:

  ```bash
  REPOSITORY_PREFLIGHT_INTEGRATION_TESTS=1 REDIS_HOST=127.0.0.1 \
  REDIS_DB=15 REDIS_TEST_DB=15 BULLMQ_PREFIX=fieldframe-phase014-test \
  REDIS_TEST_PREFIX=fieldframe-phase014-test \
  pnpm --filter @fieldframe/web test:repository-preflight
  ```

- Result: **18 passed, 0 failed, 0 skipped**. It used normal
  `/api/auth/signup` + `/api/auth/login` opaque-cookie sessions, PostgreSQL,
  isolated Redis DB 15/prefix `fieldframe-phase014-test`, MinIO snapshot
  prefix `phase014-test/`, web, and the controlled GitHub fixture. No
  `DEV_AUTH_EMAIL`, JWT, mock provider/storage/database/queue, credential,
  cookie, database URL, Redis password, MinIO credential, or presigned query
  string was printed.
- The run proves that an unsaved one-time PAT Start Import request returns
  `422 ONE_TIME_PAT_REQUIRES_SAVE_FOR_ASYNC_IMPORT` before provider access and
  leaves PostgreSQL, Redis/BullMQ, and MinIO snapshots unchanged. It also
  proves authenticated legacy endpoint deprecation as
  `410 GITEA_IMPORT_DEPRECATED`.
- `pnpm --filter @fieldframe/web typecheck`, targeted ESLint, the web
  production image build, and `git diff --check` passed.
- Still open: a controlled Gitea repository/token happy path proving
  full UI credential-mode matrix and all response redaction cases. Therefore
  T045 and T047 remain open and this record is not phase-completion evidence.

## Real Gitea saved-one-time-PAT evidence — 2026-07-24

- Verified the local provider using only safe metadata: repository
  `annotation-admin/ImageDataset`, public visibility, default ref `main`.
  The PAT was read from `.env.PAT.local` in process memory and was never
  printed or written to `.env`.
- The browser-facing server field was `http://localhost:3100`. For this exact
  configured `GITEA_PUBLIC_URL`, the server maps to its configured
  `GITEA_INTERNAL_URL` before provider access. This permits Compose web to
  reach Gitea without allowing a browser to choose a private host. A clone URL
  such as `/annotation-admin/ImageDataset.git` is not a server URL; owner and
  repository are separate fields.
- Exact redacted test command (run from `apps/web` after sourcing the local
  PAT without echoing it):

  ```bash
  SOURCE_CONNECTION_INTEGRATION_TESTS=1 \
  SOURCE_CONNECTION_HTTP_BASE_URL=http://127.0.0.1:3000 \
  SOURCE_CONNECTION_GITEA_BASE_URL=http://localhost:3100 \
  QUEUE_INTEGRATION_TESTS=1 REDIS_HOST=127.0.0.1 \
  REDIS_DB=15 REDIS_TEST_DB=15 \
  BULLMQ_PREFIX=fieldframe-phase014-test \
  REDIS_TEST_PREFIX=fieldframe-phase014-test \
  node --env-file-if-exists=../../.env \
    --require ./tests/auth-ownership/register-server-only.cjs \
    --import tsx --test --test-concurrency=1 \
    tests/source-connections/source-import-start-runtime.test.ts
  ```

- Result: **1 passed, 0 failed, 0 skipped** in 3.57 seconds. It used normal
  signup/login opaque-cookie authentication and a MANAGER actor. Preflight
  covered PUBLIC, saved ONE_TIME_PAT, and EXISTING_SOURCE_CONNECTION modes;
  every preflight created no Dataset, SourceConnection, Job, queue delivery,
  or MinIO object. Start Import then created a Dataset named
  `IMG987-<random suffix>`, an owned ACTIVE SourceConnection whose stored
  token was encrypted and unequal to the PAT, and a `QUEUED IMPORT_DATASET`
  Job. The isolated BullMQ delivery was read back as exactly `{ jobId }`; Job
  input and JobEvents did not contain the PAT. No `phase014-test/` MinIO
  object was created.
- The test cleans up only its Dataset cascade, its created SourceConnection,
  its user, and its isolated queue delivery. It does not touch the normal
  `annotation-platform` namespace. No secret, cookie, database URL, provider
  token, or storage credential appears in test output or this record.
- A separate normal-Compose (`next start`) public-preflight test passed:
  **1 passed, 0 failed, 0 skipped** in 1.52 seconds. It proves an exact
  configured `GITEA_PUBLIC_URL` of `http://localhost:3100` maps to the
  server-owned `GITEA_INTERNAL_URL` in production mode. The same test confirms
  both PUBLIC and ONE_TIME_PAT Preview requests return the safe
  `annotation-admin/ImageDataset` projection and create no Dataset,
  SourceConnection, or Job. This exception is limited to that exact configured
  root; arbitrary HTTP destinations and every cross-host redirect remain
  subject to the normal SSRF policy.
- Host-run `pnpm run dev` uses the browser-reachable `http://localhost:3100`
  directly, while Compose web uses the exact server-controlled mapping above.
  An authenticated host-dev run against `http://127.0.0.1:3001` passed
  (**1 passed, 0 failed**): both public and one-time-PAT Preview Import
  projected `annotation-admin/ImageDataset` safely with no durable writes.
